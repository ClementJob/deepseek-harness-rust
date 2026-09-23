//! Fixture signtool: appends one argv line per run to `FAKE_SIGNTOOL_LOG` and
//! optionally fails with `FAKE_SIGNTOOL_EXIT`, so signing invocations become
//! assertable without a real certificate.

use std::io::Write as _;

fn main() {
    let log_path = std::env::var("FAKE_SIGNTOOL_LOG").expect("FAKE_SIGNTOOL_LOG must name the argv log file");
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let mut log = std::fs::OpenOptions::new().create(true).append(true).open(&log_path).expect("open the argv log");
    writeln!(log, "{}", arguments.join("\u{1f}")).expect("append to the argv log");
    if let Ok(code) = std::env::var("FAKE_SIGNTOOL_EXIT") {
        if code != "0" {
            std::process::exit(code.parse().unwrap_or(1));
        }
    }
}
