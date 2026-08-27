//! 把 pi sidecar 相关的诊断日志转发到父（dev）控制台。
//!
//! dev 控制台（Windows Terminal / ConPTY，VT 模式）下，裸 `\n`（LF）只下移一行而不回到
//! 第 0 列，于是逐行右移呈阶梯状错位（staircase）。`eprintln!` 恰好只写裸 `\n`，而 shell
//! 插件交付的 pi 行通常已被剥掉行尾符（无 `\r`），两者叠加就是花屏日志。统一经此处转发：
//! 去掉原有行尾、把消息内部可能残留的裸 `\n` 一并规整，再用显式 `\r\n` 收尾，保证每个可视
//! 行都回车归位。

/// 把一段文本规整为 CRLF 行结尾：去掉首尾多余行尾符后，先清掉所有 CR 再按 LF 重建 CRLF
/// （避免对已是 `\r\n` 的内容重复加 CR），最后补一个收尾的 `\r\n`。返回值即可直接写控制台。
#[cfg(any(windows, test))]
pub(crate) fn normalize_crlf(msg: &str) -> String {
    let body = msg.trim_end_matches(['\r', '\n']);
    let mut out = body.replace('\r', "").replace('\n', "\r\n");
    out.push_str("\r\n");
    out
}

/// 转发一条诊断日志，在 Windows 上统一 CRLF 结尾以避免 VT 控制台下的 staircase 错位。
pub(crate) fn forward_log(msg: &str) {
    #[cfg(windows)]
    {
        eprint!("{}", normalize_crlf(msg));
    }
    #[cfg(not(windows))]
    {
        // 类 Unix 终端的 tty 自带 ONLCR，裸 \n 即可正确回车，保持日志/重定向文件为 LF。
        eprintln!("{}", msg.trim_end_matches(['\r', '\n']));
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_crlf;

    #[test]
    fn appends_crlf_to_a_bare_line() {
        // 行尾符被插件剥掉的常见情形：补一个 \r\n。
        assert_eq!(
            normalize_crlf("[agent-mode] extension loaded"),
            "[agent-mode] extension loaded\r\n"
        );
    }

    #[test]
    fn rewrites_lone_lf_terminator_to_crlf() {
        assert_eq!(normalize_crlf("loaded\n"), "loaded\r\n");
    }

    #[test]
    fn does_not_double_cr_on_existing_crlf() {
        assert_eq!(normalize_crlf("loaded\r\n"), "loaded\r\n");
    }

    #[test]
    fn normalizes_internal_lf_in_multiline_message() {
        // 单个事件含多行时，内部裸 \n 也要回车，否则内部仍然阶梯错位。
        assert_eq!(normalize_crlf("line1\nline2"), "line1\r\nline2\r\n");
    }

    #[test]
    fn collapses_trailing_blank_lines() {
        assert_eq!(normalize_crlf("done\r\n\r\n"), "done\r\n");
    }
}
