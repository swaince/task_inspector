pub mod db;
mod analysis;
mod app_env;
mod http;
pub mod ldap;
mod llm;
mod mcp;
mod shell;
mod store;

use db::Db;
use llm::StreamRegistry;
use tauri::Manager;

/// 应用入口。
///
/// 前端的网络请求、模型调用和本地数据全部经过这里的命令，
/// webview 里只跑界面逻辑，拿到不到 Token，也不受内网跨域限制。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 外链交给系统默认浏览器打开，并且只允许 http/https
        .plugin(tauri_plugin_opener::init())
        // 自动更新：检查 GitHub Release 的 latest.json，下载并校验签名
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 更新安装完成后由前端调用 relaunch 重启
        .plugin(tauri_plugin_process::init())
        .manage(StreamRegistry::default())
        .manage(mcp::McpManager::default())
        .manage(shell::ShellRegistry::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let database = Db::open(app.handle()).map_err(into_boxed)?;
            // 旧版本用的是「一条记录一个 JSON 文件」，升级时把数据搬进数据库，
            // 否则用户的历史会看起来凭空消失
            store::migrate_into(&database, app.handle()).map_err(into_boxed)?;
            app.manage(database);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            http::http_request,
            llm::llm_stream,
            llm::llm_cancel,
            db::settings_get,
            db::settings_set,
            app_env::install_kind,
            mcp::mcp_list_tools,
            mcp::mcp_call_tool,
            shell::shell_run,
            shell::shell_cancel,
            db::reports_upsert,
            db::reports_by_date,
            db::reports_dates,
            db::reports_clear,
            db::inspections_upsert,
            db::inspections_list,
            db::inspections_by_key,
            db::inspections_delete,
            db::inspections_clear,
            db::inspections_prune,
            db::data_reset,
            db::commits_upsert,
            db::embeddings_upsert,
            db::search_hybrid,
            db::stats_by_date,
            db::projects_list,
            db::projects_upsert,
            db::projects_delete,
            db::projects_sync_from_gitlab,
            db::profiles_get,
            db::profile_upsert,
            db::profiles_delete,
            db::members_list,
            db::members_upsert,
            db::members_delete,
            db::members_import,
            ldap::ldap_sync,
            ldap::ldap_probe,
            analysis::tool_status,
            analysis::analysis_defaults,
            analysis::dir_usage,
            analysis::clear_cache,
            analysis::analysis_install,
            analysis::analysis_install_cancel,
            analysis::analysis_index,
            analysis::scan_repo,
            analysis::git_hotspots,
            analysis::git_head,
            analysis::git_branches,
            analysis::git_worktree_add,
            analysis::git_worktree_remove,
            analysis::git_clone,
            analysis::ensure_dirs,
            analysis::read_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("启动应用失败");
}

fn into_boxed(message: String) -> Box<dyn std::error::Error> {
    message.into()
}
