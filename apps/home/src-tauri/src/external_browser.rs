use std::process::Command;

pub(super) fn open(url: &str) -> Result<(), String> {
    launch(browser_command(url))
}

fn browser_command(url: &str) -> Command {
    let mut command = Command::new("/usr/bin/open");
    command.arg(url);
    command
}

fn launch(mut command: Command) -> Result<(), String> {
    let status = command.status().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("打开浏览器失败: {status}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn uses_macos_system_opener() {
        let command = browser_command("https://example.invalid/");
        assert_eq!(command.get_program(), OsStr::new("/usr/bin/open"));
    }

    #[test]
    fn preserves_url_as_one_argument() {
        let url = "https://example.invalid/?q=hello world&next=%2Ftask#section";
        let command = browser_command(url);
        assert_eq!(command.get_args().collect::<Vec<_>>(), [OsStr::new(url)]);
    }

    #[cfg(unix)]
    #[test]
    fn reports_opener_failure() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exit 23"]);
        let error = launch(command).expect_err("浏览器启动失败不能被当作成功");
        assert!(error.starts_with("打开浏览器失败: "), "{error}");
        assert!(error.contains("23"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn accepts_successful_opener() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exit 0"]);
        assert_eq!(launch(command), Ok(()));
    }

    #[test]
    fn reports_missing_opener() {
        assert!(launch(Command::new("")).is_err());
    }
}
