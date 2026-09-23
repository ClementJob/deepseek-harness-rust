//! Bounded tail of the Host's stderr, kept for failure diagnostics only.

use std::collections::VecDeque;

/**
 * Retains the most recent `capacity` bytes of one stream.
 *
 * The Electron shell keeps 64 Ki of Host stderr for crash reports; this tail
 * serves the same purpose and is never surfaced to the Web document.
 */
pub struct BoundedTail {
    capacity: usize,
    bytes: VecDeque<u8>,
}

impl BoundedTail {
    pub fn new(capacity: usize) -> Self {
        Self { capacity, bytes: VecDeque::new() }
    }

    /// Append output, discarding the oldest bytes beyond the capacity.
    pub fn extend(&mut self, addition: &[u8]) {
        if addition.len() >= self.capacity {
            self.bytes.clear();
            self.bytes.extend(&addition[addition.len() - self.capacity..]);
            return;
        }
        self.bytes.extend(addition.iter().copied());
        while self.bytes.len() > self.capacity {
            self.bytes.pop_front();
        }
    }

    /// The retained tail, lossily decoded: diagnostics must survive arbitrary plugin bytes.
    pub fn text(&self) -> String {
        let bytes: Vec<u8> = self.bytes.iter().copied().collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_the_tail_beyond_capacity() {
        let mut tail = BoundedTail::new(8);
        tail.extend(b"abcdefghij");
        assert_eq!(tail.text(), "cdefghij");
        tail.extend(b"kl");
        assert_eq!(tail.text(), "efghijkl");
    }

    #[test]
    fn accepts_output_larger_than_capacity() {
        let mut tail = BoundedTail::new(4);
        tail.extend(b"0123456789");
        assert_eq!(tail.text(), "6789");
        assert_eq!(tail.text().len(), 4);
    }

    #[test]
    fn retains_exact_capacity_without_loss() {
        let mut tail = BoundedTail::new(6);
        tail.extend(b"abcdef");
        assert_eq!(tail.text(), "abcdef");
    }

    #[test]
    fn decodes_split_utf8_lossily() {
        let mut tail = BoundedTail::new(4);
        // One three-byte character plus a cut second character.
        tail.extend("水水".as_bytes());
        assert_eq!(tail.text().chars().count(), 2);
        assert!(tail.text().contains('\u{FFFD}'));
    }
}
