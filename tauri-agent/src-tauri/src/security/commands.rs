use std::path::Path;

static ALLOWED_COMMANDS: &[&str] = &[
    "node", "npm", "pnpm", "yarn", "bun", "python", "python3", "pip", "pip3", "git", "cargo",
    "rustc", "go", "make", "cmake", "ls", "dir", "cat", "echo", "pwd",
];

pub fn validate_command(command: &str) -> Result<(), String> {
    let cmd_name = Path::new(command)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(command);

    let normalized = cmd_name.to_lowercase().trim_end_matches(".exe").to_string();

    if ALLOWED_COMMANDS.contains(&normalized.as_str()) {
        Ok(())
    } else {
        Err(format!(
            "Command '{}' not allowed. Permitted: {}",
            command,
            ALLOWED_COMMANDS.join(", ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_whitelisted_commands() {
        assert!(validate_command("node").is_ok());
        assert!(validate_command("npm").is_ok());
        assert!(validate_command("git").is_ok());
        assert!(validate_command("python3").is_ok());
    }

    #[test]
    fn rejects_dangerous_commands() {
        assert!(validate_command("powershell").is_err());
        assert!(validate_command("cmd").is_err());
        assert!(validate_command("bash").is_err());
        assert!(validate_command("reg").is_err());
    }

    #[test]
    fn handles_exe_suffix() {
        assert!(validate_command("node.exe").is_ok());
        assert!(validate_command("npm.exe").is_ok());
    }

    #[test]
    fn rejects_path_prefixed_commands() {
        assert!(validate_command("C:\\evil\\hack.exe").is_err());
        assert!(validate_command("/bin/rm").is_err());
    }

    #[test]
    fn error_message_includes_allowed_list() {
        let err = validate_command("evil").unwrap_err();
        assert!(err.contains("not allowed"));
        assert!(err.contains("node"));
    }
}
