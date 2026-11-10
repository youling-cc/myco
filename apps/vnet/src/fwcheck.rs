//! 入站可达性自检。
//!
//! 背景（2026-11-04 实测）：客户端在「公共网络」配置下没有入站放行规则时，
//! 所有发往监听端口的 UDP 包被系统静默丢弃，表现为「P2P 永远打不通、但中继正常」。
//! 这个症状极易被误判为 NAT 问题（我们排查了数小时），必须让程序自己说出来。
//!
//! 两个关键设计约束：
//! 1. **绝不能阻塞启动**。Windows 防火墙规则可能有数百条，全量枚举要数秒到数十秒，
//!    所以放在后台线程里跑，主流程立即返回 Unknown，查到后再更新。
//! 2. **查询必须服务端过滤**。用 `Get-NetFirewallApplicationFilter -Program <本exe>`，
//!    而不是枚举全部规则再过滤（后者实测 10s+ 无响应）。

use std::sync::{Arc, Mutex, OnceLock};

/// 入站可达性判定结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InboundStatus {
    /// 存在覆盖当前网络配置的入站放行规则
    Allowed,
    /// 没有任何规则覆盖本程序 —— P2P 必然失败
    Blocked,
    /// 尚未判定完成 / 非 Windows / 查询失败
    Unknown,
}

impl InboundStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            InboundStatus::Allowed => "allowed",
            InboundStatus::Blocked => "blocked",
            InboundStatus::Unknown => "unknown",
        }
    }
}

/// 全局缓存：后台线程查完后写这里，status 输出随时读
static CACHED: OnceLock<Arc<Mutex<InboundStatus>>> = OnceLock::new();

fn cache() -> &'static Arc<Mutex<InboundStatus>> {
    CACHED.get_or_init(|| Arc::new(Mutex::new(InboundStatus::Unknown)))
}

/// 当前已知状态（非阻塞）
pub fn current() -> InboundStatus {
    *cache().lock().unwrap()
}

#[cfg(windows)]
fn query_blocking() -> InboundStatus {
    let exe = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => return InboundStatus::Unknown,
    };
    // 服务端过滤：只取与本 exe 关联的规则，速度是枚举全量规则的百倍以上
    let script = format!(
        r#"$ErrorActionPreference='SilentlyContinue';
$prof=(Get-NetConnectionProfile).NetworkCategory;
$rules=Get-NetFirewallApplicationFilter -Program '{exe}' | Get-NetFirewallRule |
  Where-Object {{ $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' -and $_.Enabled -eq 'True' }};
$ok=$rules | Where-Object {{ $_.Profile -eq 'Any' -or ($prof -contains 'Public' -and "$($_.Profile)" -match 'Public') -or ($prof -contains 'Private' -and "$($_.Profile)" -match 'Private') -or ($prof -contains 'DomainAuthenticated' -and "$($_.Profile)" -match 'Domain') }};
if ($ok) {{ 'ALLOWED' }} elseif ($rules) {{ 'WRONGPROFILE' }} else {{ 'NO_RULE' }}"#,
        exe = exe.replace('\'', "''")
    );

    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：GUI 进程（Tauri，无控制台）下不弹可见窗口
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output();

    match out {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout);
            if s.contains("ALLOWED") {
                InboundStatus::Allowed
            } else if s.contains("NO_RULE") || s.contains("WRONGPROFILE") {
                InboundStatus::Blocked
            } else {
                InboundStatus::Unknown
            }
        }
        _ => InboundStatus::Unknown,
    }
}

#[cfg(not(windows))]
fn query_blocking() -> InboundStatus {
    InboundStatus::Unknown
}

/// 在后台线程里检查入站可达性，**立即返回**（不阻塞启动）。
/// 查到 Blocked 时打印醒目的修复指引。
pub fn spawn_check() {
    // 进程内只跑一次：多实例/重建场景下每次 Connection 都调这里，
    // 每次都起 powershell 会让 GUI 进程反复弹窗（2026-11-05 实测用户投诉）。
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
    std::thread::spawn(|| {
        let st = query_blocking();
        *cache().lock().unwrap() = st;
        if st == InboundStatus::Blocked {
            let exe = std::env::current_exe()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| "<本程序路径>".into());
            println!();
            println!("  [FW] ⚠️  入站被 Windows 防火墙拦截（已确认：无覆盖当前网络的允许规则）");
            println!("  [FW]    发往监听端口的 UDP 包会被系统静默丢弃 —— P2P 将永远打不通。");
            println!("  [FW]    中继路径不受影响，隧道仍可用。");
            println!("  [FW]    修复（管理员执行一次）：");
            println!("  [FW]      netsh advfirewall firewall add rule name=\"myco-vnet-in\" ^");
            println!("  [FW]        dir=in action=allow program=\"{}\" protocol=UDP profile=any", exe);
            println!();
        } else if st == InboundStatus::Allowed {
            println!("  [FW] inbound OK (firewall allows this program)");
        }
    });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_str_matches_variants() {
        assert_eq!(InboundStatus::Allowed.as_str(), "allowed");
        assert_eq!(InboundStatus::Blocked.as_str(), "blocked");
        assert_eq!(InboundStatus::Unknown.as_str(), "unknown");
    }

    #[test]
    fn current_starts_unknown_without_check() {
        // 未调用 spawn_check 时必须是 Unknown，不能误报 Blocked
        assert_eq!(current(), InboundStatus::Unknown);
    }
}
