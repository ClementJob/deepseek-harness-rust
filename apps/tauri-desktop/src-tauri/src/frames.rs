//! NDJSON control frames exchanged with the Desktop Host over its stdio pipes.
//!
//! The Host writes one JSON object per line on stdout; malformed output is a
//! protocol violation that must become a fatal shell error, matching the
//! Electron shell's IPC validation (`apps/desktop/src/host-process.ts`).

use serde_json::Value;

/// Highest accepted frame size. A longer line is a protocol violation, not a frame.
const MAX_LINE_BYTES: usize = 1024 * 1024;

/// One Host-to-shell control frame.
#[derive(Clone, Debug, PartialEq)]
pub enum Frame {
    /// The Host Web application is serving; `url` is the authenticated page the shell must load.
    Ready { url: String },
    /// A Host failure the Host chose to report, with its complete inspected error when supplied.
    Fatal { message: String, diagnostic: Option<String> },
    /// Embedded-Platform credential state. Opaque here: this shell has no Platform views yet.
    PlatformSession { session: Value },
    /// The Host acknowledged a `shutdown` request and completed teardown.
    ShutdownComplete,
    /// Reply to a shell `update-tasks` request.
    UpdateTasks { request_id: i64, active: bool, error: Option<String> },
}

/// Splits stdout bytes into frames across arbitrary read boundaries.
pub struct FrameStream {
    buffer: Vec<u8>,
}

impl FrameStream {
    pub fn new() -> Self {
        Self { buffer: Vec::new() }
    }

    /**
     * Feed one stdout chunk and return the frames it completed.
     *
     * Fails with the protocol violation that must become a fatal shell error:
     * invalid JSON, an unknown frame, or an unterminated line beyond the size bound.
     */
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Frame>, String> {
        self.buffer.extend_from_slice(chunk);
        let mut frames = Vec::new();
        let mut consumed = 0;
        while let Some(line_end) = self.buffer[consumed..].iter().position(|&byte| byte == b'\n') {
            let end = consumed + line_end;
            if end - consumed > MAX_LINE_BYTES {
                return Err(format!("control frame exceeds {MAX_LINE_BYTES} bytes"));
            }
            let line = std::str::from_utf8(&self.buffer[consumed..end])
                .map_err(|_| "control frame is not UTF-8".to_string())?;
            frames.push(parse_line(line)?);
            consumed = end + 1;
        }
        self.buffer.drain(..consumed);
        if self.buffer.len() > MAX_LINE_BYTES {
            return Err(format!("control frame exceeds {MAX_LINE_BYTES} bytes without a line break"));
        }
        Ok(frames)
    }

    /// Close the stream: a nonempty unterminated tail is a protocol violation.
    pub fn finish(self) -> Result<(), String> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        Err("the desktop host stdout ended inside a control frame".into())
    }
}

/**
 * Parse one complete frame line (without its line break).
 *
 * Tolerates a CRLF line ending; every other deviation from the contract
 * (`docs` and the shared shell contract) is rejected.
 */
pub fn parse_line(line: &str) -> Result<Frame, String> {
    let line = line.strip_suffix('\r').unwrap_or(line);
    let value: Value =
        serde_json::from_str(line).map_err(|error| format!("control frame is not valid JSON: {error}"))?;
    let object = value.as_object().ok_or("control frame is not a JSON object")?;
    let frame_type = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or("control frame has no string type")?;
    match frame_type {
        "ready" => {
            let url = object
                .get("url")
                .and_then(Value::as_str)
                .ok_or("ready frame has no url")?;
            Ok(Frame::Ready { url: url.to_owned() })
        }
        "fatal" => {
            let message = object
                .get("message")
                .and_then(Value::as_str)
                .ok_or("fatal frame has no message")?;
            let diagnostic = optional_string(object, "diagnostic")?;
            Ok(Frame::Fatal { message: message.to_owned(), diagnostic })
        }
        "platform-session" => {
            let session = object.get("session").ok_or("platform-session frame has no session")?;
            Ok(Frame::PlatformSession { session: session.clone() })
        }
        "shutdown-complete" => Ok(Frame::ShutdownComplete),
        "update-tasks" => {
            let request_id = object
                .get("requestId")
                .and_then(Value::as_i64)
                .ok_or("update-tasks frame has no integer requestId")?;
            let active = object
                .get("active")
                .and_then(Value::as_bool)
                .ok_or("update-tasks frame has no boolean active")?;
            let error = optional_string(object, "error")?;
            Ok(Frame::UpdateTasks { request_id, active, error })
        }
        other => Err(format!("unknown control frame type {other:?}")),
    }
}

fn optional_string(object: &serde_json::Map<String, Value>, key: &str) -> Result<Option<String>, String> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(format!("{key} must be a string")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(stream: &mut FrameStream, bytes: &[u8]) -> Vec<Frame> {
        stream.push(bytes).expect("chunk must parse")
    }

    #[test]
    fn parses_every_frame_shape() {
        assert_eq!(
            parse_line(r#"{"type":"ready","url":"http://127.0.0.1:19387/"}"#).unwrap(),
            Frame::Ready { url: "http://127.0.0.1:19387/".into() }
        );
        assert_eq!(
            parse_line(r#"{"type":"fatal","message":"boot failed","diagnostic":"Error: x"}"#).unwrap(),
            Frame::Fatal { message: "boot failed".into(), diagnostic: Some("Error: x".into()) }
        );
        assert_eq!(
            parse_line(r#"{"type":"fatal","message":"boot failed"}"#).unwrap(),
            Frame::Fatal { message: "boot failed".into(), diagnostic: None }
        );
        assert_eq!(parse_line(r#"{"type":"shutdown-complete"}"#).unwrap(), Frame::ShutdownComplete);
        assert_eq!(
            parse_line(r#"{"type":"platform-session","session":null}"#).unwrap(),
            Frame::PlatformSession { session: Value::Null }
        );
        assert_eq!(
            parse_line(r#"{"type":"update-tasks","requestId":3,"active":true}"#).unwrap(),
            Frame::UpdateTasks { request_id: 3, active: true, error: None }
        );
        assert_eq!(
            parse_line(r#"{"type":"update-tasks","requestId":4,"active":false,"error":"locked"}"#).unwrap(),
            Frame::UpdateTasks { request_id: 4, active: false, error: Some("locked".into()) }
        );
    }

    #[test]
    fn rejects_invalid_frames() {
        for line in [
            "not json",
            "[1,2]",
            r#"{"url":"http://127.0.0.1/"}"#,
            r#"{"type":"whatever"}"#,
            r#"{"type":"ready"}"#,
            r#"{"type":"ready","url":42}"#,
            r#"{"type":"fatal","message":7}"#,
            r#"{"type":"update-tasks","requestId":1.5,"active":true}"#,
            r#"{"type":"update-tasks","requestId":1,"active":"yes"}"#,
            r#"{"type":"update-tasks","requestId":1,"active":true,"error":9}"#,
            r#"{"type":"platform-session"}"#,
            "",
            "   ",
        ] {
            assert!(parse_line(line).is_err(), "expected {line:?} to be rejected");
        }
    }

    #[test]
    fn splits_frames_across_chunk_boundaries() {
        let payload = [
            r#"{"type":"ready","url":"http://127.0.0.1:19387/app"}"#,
            r#"{"type":"shutdown-complete"}"#,
            r#"{"type":"update-tasks","requestId":1,"active":false}"#,
            "",
        ]
        .join("\n");
        let mut stream = FrameStream::new();
        let mut frames = Vec::new();
        // One byte at a time exercises every split boundary.
        for byte in payload.as_bytes() {
            frames.extend(feed(&mut stream, std::slice::from_ref(byte)));
        }
        assert_eq!(
            frames,
            vec![
                Frame::Ready { url: "http://127.0.0.1:19387/app".into() },
                Frame::ShutdownComplete,
                Frame::UpdateTasks { request_id: 1, active: false, error: None },
            ]
        );
        stream.finish().expect("no unterminated tail");
    }

    #[test]
    fn keeps_large_frames_from_sticking() {
        let large_url = format!("http://127.0.0.1:19387/{}", "x".repeat(200_000));
        let payload = format!(
            "{}\n{}\n",
            serde_json::json!({ "type": "ready", "url": large_url }),
            r#"{"type":"shutdown-complete"}"#,
        );
        let mut stream = FrameStream::new();
        let mut frames = Vec::new();
        // Irregular chunk sizes across the huge frame's interior and its terminator.
        let bytes = payload.as_bytes();
        let mut offset = 0;
        for step in [7usize, 4096, 1, 65_537, 3, 100_000] {
            let end = (offset + step).min(bytes.len());
            if offset >= end {
                break;
            }
            frames.extend(feed(&mut stream, &bytes[offset..end]));
            offset = end;
        }
        frames.extend(feed(&mut stream, &bytes[offset..]));
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0], Frame::Ready { url: large_url });
        assert_eq!(frames[1], Frame::ShutdownComplete);
    }

    #[test]
    fn rejects_oversized_frames() {
        let oversized = format!("{}x\n", "{\"type\":\"ready\",\"url\":\"");
        let mut stream = FrameStream::new();
        let result = stream.push(oversized.repeat(2).as_bytes());
        assert!(result.is_err());
        // An unterminated line beyond the bound fails even without a line break.
        let mut stream = FrameStream::new();
        let result = stream.push(&[b'x'; MAX_LINE_BYTES + 1]);
        assert!(result.is_err());
    }

    #[test]
    fn rejects_unterminated_tail_at_eof() {
        let mut stream = FrameStream::new();
        feed(&mut stream, br#"{"type":"ready","url":"http://127.0.0.1/"}"#);
        feed(&mut stream, b"\n");
        feed(&mut stream, br#"{"type":"shutdown-comp"#);
        assert!(stream.finish().is_err());
        assert!(FrameStream::new().finish().is_ok());
    }

    #[test]
    fn tolerates_crlf_line_endings() {
        let mut stream = FrameStream::new();
        let frames = feed(&mut stream, b"{\"type\":\"ready\",\"url\":\"u\"}\r\n");
        assert_eq!(frames, vec![Frame::Ready { url: "u".into() }]);
    }
}
