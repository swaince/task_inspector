/// 当前运行的是安装版还是免安装版。
///
/// 自动更新只适用于安装版：NSIS 安装器会替换已安装的文件；
/// 免安装版没有安装器，用新 zip 覆盖 exe 才是正确的更新方式。
/// Windows 上以安装目录里有没有 NSIS 留下的 uninstall.exe 为准，
/// macOS 上以 .app 是否位于 /Applications 为准。
#[tauri::command]
pub fn install_kind() -> String {
    let Ok(exe) = std::env::current_exe() else {
        return "unknown".into();
    };

    #[cfg(target_os = "windows")]
    {
        let installed = exe
            .parent()
            .map(|dir| dir.join("uninstall.exe").exists())
            .unwrap_or(false);
        return if installed { "installed" } else { "portable" }.into();
    }

    #[cfg(target_os = "macos")]
    {
        let installed = exe.to_string_lossy().contains("/Applications/");
        return if installed { "installed" } else { "portable" }.into();
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = exe;
        "unknown".into()
    }
}
