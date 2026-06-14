/// 按严格 JSONL 语义把字节流切成行：仅以 `\n` 分隔，剥掉尾部 `\r`。
/// 绝不按 Unicode 行分隔符（U+2028/U+2029）切分——它们在 JSON 字符串内合法。
#[derive(Default)]
pub struct JsonlBuffer {
    buffer: String,
}

impl JsonlBuffer {
    pub fn new() -> Self {
        Self {
            buffer: String::new(),
        }
    }

    /// 追加一段文本，返回其中已完成的行（不含分隔符）。未结束的尾部保留在内部缓冲。
    pub fn push(&mut self, chunk: &str) -> Vec<String> {
        self.buffer.push_str(chunk);
        let mut out = Vec::new();
        while let Some(idx) = self.buffer.find('\n') {
            let mut line = self.buffer[..idx].to_string();
            if line.ends_with('\r') {
                line.pop();
            }
            out.push(line);
            self.buffer.drain(..=idx);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_on_lf_only_and_strips_cr() {
        let mut buf = JsonlBuffer::new();
        let lines = buf.push("{\"a\":1}\r\n{\"b\":2}\n");
        assert_eq!(
            lines,
            vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]
        );
    }

    #[test]
    fn buffers_partial_line_until_newline() {
        let mut buf = JsonlBuffer::new();
        assert!(buf.push("{\"a\":").is_empty());
        let lines = buf.push("1}\n");
        assert_eq!(lines, vec!["{\"a\":1}".to_string()]);
    }

    #[test]
    fn does_not_split_on_unicode_line_separators() {
        let mut buf = JsonlBuffer::new();
        let lines = buf.push("{\"t\":\"a\u{2028}b\"}\n");
        assert_eq!(lines, vec!["{\"t\":\"a\u{2028}b\"}".to_string()]);
    }

    #[test]
    fn handles_empty_lines() {
        let mut buf = JsonlBuffer::new();
        let lines = buf.push("\n\n");
        assert_eq!(lines, vec!["".to_string(), "".to_string()]);
    }

    #[test]
    fn lone_cr_does_not_split_and_is_buffered() {
        let mut buf = JsonlBuffer::new();
        // 只有 \r，不应产出任何行
        assert!(buf.push("a\rb").is_empty());
        // 直到遇到 \n 才成行（此处中间的 \r 在行内，应原样保留）
        let lines = buf.push("c\n");
        assert_eq!(lines, vec!["a\rbc".to_string()]);
    }

    #[test]
    fn empty_push_returns_no_lines() {
        let mut buf = JsonlBuffer::new();
        assert!(buf.push("").is_empty());
    }

    #[test]
    fn does_not_split_on_paragraph_separator_u2029() {
        let mut buf = JsonlBuffer::new();
        let lines = buf.push("{\"t\":\"a\u{2029}b\"}\n");
        assert_eq!(lines, vec!["{\"t\":\"a\u{2029}b\"}".to_string()]);
    }
}
