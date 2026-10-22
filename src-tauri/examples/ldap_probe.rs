//! LDAP 诊断命令行工具。
//!
//! 复用应用里同一条代码路径（`ldap::probe_from_json` / `sync_dry_run` / `sync_into_db`），
//! 用于在没有 GUI 的情况下排查真实目录、或先把人员同步好再启动应用——
//! 桌面端的数据在自己的 SQLite 里，靠这个入口可以离线准备好。
//!
//! 用法：
//!   cargo run --example ldap_probe -- <设置.json>
//!   cargo run --example ldap_probe -- --sync <设置.json>
//!   cargo run --example ldap_probe -- --write <数据库路径> <设置.json>
//!
//! 设置文件就是应用里那份完整设置的 JSON（含 ldap 段）。
//! 里面有密码，别提交到仓库、也别把输出外发。

use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use task_inspector_lib::ldap::{LdapProbeReport, SyncDryRun};

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1).peekable();
    let mut sync = false;
    let mut write: Option<PathBuf> = None;
    let mut settings_path: Option<String> = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--sync" => sync = true,
            "--write" => {
                let Some(path) = args.next() else {
                    eprintln!("--write 后面要跟数据库路径");
                    return ExitCode::FAILURE;
                };
                write = Some(PathBuf::from(path));
            }
            other => settings_path = Some(other.to_string()),
        }
    }

    let Some(settings_path) = settings_path else {
        eprintln!("用法：cargo run --example ldap_probe -- [--sync] [--write <数据库路径>] <设置.json>");
        return ExitCode::FAILURE;
    };

    let settings = match fs::read_to_string(&settings_path) {
        Ok(text) => text,
        Err(err) => {
            eprintln!("读不到设置文件 {settings_path}：{err}");
            return ExitCode::FAILURE;
        }
    };

    // 设置文件里只有 ldap 段是探测需要的，单独取出来
    let ldap_json = match serde_json::from_str::<serde_json::Value>(&settings) {
        Ok(value) => match value.get("ldap") {
            Some(ldap) => ldap.to_string(),
            None => {
                eprintln!("设置文件里没有 ldap 段");
                return ExitCode::FAILURE;
            }
        },
        Err(err) => {
            eprintln!("设置文件不是合法 JSON：{err}");
            return ExitCode::FAILURE;
        }
    };

    match task_inspector_lib::ldap::probe_from_json(&ldap_json) {
        Ok(report) => print_report(&report),
        Err(message) => {
            eprintln!("\n探测失败：{message}");
            return ExitCode::FAILURE;
        }
    }

    if sync && write.is_none() {
        println!("\n=== 对账试跑（写内存库，不影响任何真实数据）===");
        match task_inspector_lib::ldap::sync_dry_run(&ldap_json) {
            Ok(run) => print_dry_run(&run),
            Err(message) => {
                eprintln!("\n对账试跑失败：{message}");
                return ExitCode::FAILURE;
            }
        }
    }

    if let Some(db_path) = write {
        println!("\n=== 写入数据库 {} ===", db_path.display());
        match task_inspector_lib::ldap::sync_into_db(&db_path, &settings) {
            Ok(outcome) => {
                println!(
                    "完成：新增 {} 人，更新 {} 人，跳过 {} 条",
                    outcome.added, outcome.updated, outcome.skipped
                );
                println!("配置也已一并写入，启动应用即为配好的状态。");
            }
            Err(message) => {
                eprintln!("\n写入失败：{message}");
                return ExitCode::FAILURE;
            }
        }
    }

    ExitCode::SUCCESS
}

fn print_dry_run(run: &SyncDryRun) {
    println!(
        "结果：新增 {} 人，更新 {} 人，跳过 {} 条（缺关键属性）",
        run.outcome.added, run.outcome.updated, run.outcome.skipped
    );

    if run.duplicate_emails.is_empty() {
        println!("邮箱无冲突。");
    }
    else {
        println!(
            "\n⚠ {} 个邮箱被多个账号共用——这些人之间无法区分提交归属：",
            run.duplicate_emails.len()
        );
        for (email, users) in &run.duplicate_emails {
            println!("    {email}  ←  {}", users.join("、"));
        }
    }

    if !run.without_email.is_empty() {
        println!(
            "\n⚠ {} 个账号没有邮箱，无法按作者匹配提交：{}",
            run.without_email.len(),
            run.without_email.join("、")
        );
    }

    println!("\n前几条会建成的记录（核对映射结果是否符合预期）：");
    for p in &run.sample {
        println!(
            "  {:<8} uid={:<14} mail={:<26} 工号={:<8} 部门={:<10} 岗位={}",
            if p.name.is_empty() { "（空）" } else { &p.name },
            if p.username.is_empty() { "（空）" } else { &p.username },
            p.email.clone().unwrap_or_else(|| "（空）".into()),
            p.employee_no.clone().unwrap_or_else(|| "（空）".into()),
            p.department.clone().unwrap_or_else(|| "（空）".into()),
            p.title.clone().unwrap_or_else(|| "（空）".into()),
        );
    }
}

fn print_report(report: &LdapProbeReport) {
    println!("\n=== 探测结果 ===");
    println!("搜索起点 : {}", report.base_dn);
    println!("过滤器   : {}", report.filter);
    println!("匹配条数 : {}（属性统计基于前 {} 条）", report.total, report.sampled);

    println!("\n--- 当前映射的命中情况 ---");
    for m in &report.mapped {
        let mark = if m.present == 0 { "✗" } else { "✓" };
        println!(
            "  {mark} {:<12} {:<20} {:>5} 条   {}",
            m.field,
            if m.name.is_empty() { "（空）" } else { &m.name },
            m.present,
            m.sample.clone().unwrap_or_default()
        );
    }

    if report.suggestions.is_empty() {
        println!("\n属性映射没有问题。");
    }
    else {
        println!("\n--- 建议修改 ---");
        for s in &report.suggestions {
            println!(
                "  {}  {} → {}（目录里有 {} 条）",
                s.field, s.current, s.suggested, s.suggested_present
            );
        }
    }

    println!("\n--- 目录里实际存在的属性（前 {} 个）---", report.available.len());
    for a in &report.available {
        println!(
            "  {:<24} {:>5} 条   {}",
            a.name,
            a.present,
            a.sample.clone().unwrap_or_default()
        );
    }

    if report.sensitive_attributes.is_empty() {
        println!("\n目录未返回敏感属性，符合预期。");
    }
    else {
        println!(
            "\n⚠ 目录返回了以下敏感属性（值已隐藏）：{}",
            report.sensitive_attributes.join("、")
        );
        println!("  正常情况下目录 ACL 应该挡住它们。这属于目录侧的配置问题，建议找运维确认，");
        println!("  本工具不需要这些属性，读数不受影响。");
    }

    println!("\n--- 抽样条目 ---");
    for entry in &report.samples {
        println!("  dn: {}", entry.dn);
        for (k, v) in &entry.attributes {
            println!("      {k} = {v}");
        }
    }
}
