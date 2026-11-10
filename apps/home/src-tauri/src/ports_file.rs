//! ports_file.rs — 统一端口档案 `%APPDATA%\youling\ports.json`（2026-10-14 立）。
//!
//! 目的：myco 的三个常驻面端口对调用方（skill/agent/脚本）**可发现**——
//! 管理面 3102 被占时自动顺延换口（重启后还会优先复用记忆口），调用方不能再
//! 硬编码 3102，一律从本文件读实际值：
//!
//! ```json
//! {"mgmt":3102,"gw":13911,"tunnel":9100}
//! ```
//!
//! · `mgmt`   本地管理面（dsh_share::start_local_api）——**动态**：记忆口被占
//!   则从 3102 起递增（上限 3102+50），bind 成功后写回；
//! · `gw`     分享公网网关（13911）——本期**固定**（跨设备寻址锚，另议），
//!   只把实际值写进来；bind 失败维持现有失败行为（不自动换、不更新档案）；
//! · `tunnel` P2P 数据面（9100）——沿用 p2p_server 自带的冲突顺延逻辑，
//!   实际绑定口写进来（可能 9101…）。
//!
//! 兼容：文件不存在/损坏 → 全部用默认值（读取零副作用）；mgmt 启动时发现
//! 档案缺失/损坏会按默认值落盘一次。写路径 `record()` 为读-改-写合并（进程内
//! 互斥；三个面启动时各写各的字段，互不覆盖）。风格承 p2p_tunnel 的
//! tunnel-ports.json 端口记忆（`port_memo_*`）。

use std::path::PathBuf;

/// 管理面默认口（也是动态顺延的基准）。
pub const DEFAULT_MGMT: u16 = 3102;
/// 管理面顺延上限（含）：3102..=3152，共 51 个口。
pub const MGMT_MAX: u16 = DEFAULT_MGMT + 50;
/// 分享公网网关默认口（本期固定，不参与动态换口）。
pub const DEFAULT_GW: u16 = 13911;
/// P2P 数据面默认口（p2p_server 自带 9100..9109 顺延）。
pub const DEFAULT_TUNNEL: u16 = 9100;

/// 进程内写互斥（三个面的启动写并发时串行化读-改-写；一次性动作，无争用）。
static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn ports_path() -> PathBuf {
    myco_core::config::config_dir().join("ports.json")
}

/// 日志/提示用：档案路径（人读形态）。
pub fn ports_path_for_log() -> String {
    ports_path().display().to_string()
}

/// 档案内容（三口的实际值）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ports {
    pub mgmt: u16,
    pub gw: u16,
    pub tunnel: u16,
}

impl Default for Ports {
    fn default() -> Self {
        Ports { mgmt: DEFAULT_MGMT, gw: DEFAULT_GW, tunnel: DEFAULT_TUNNEL }
    }
}

/// 读档案（纯读，零副作用）：文件缺失/损坏/字段非法 → 默认值。
/// 调用方（skill/agent、CLI 端口解析）据此发现实际口。
pub fn read() -> Ports {
    let s = match std::fs::read_to_string(ports_path()) {
        Ok(s) => s,
        Err(_) => return Ports::default(),
    };
    let v: serde_json::Value = match serde_json::from_str(&s) {
        Ok(v) => v,
        Err(_) => return Ports::default(),
    };
    let port_of = |k: &str, dflt: u16| {
        v.get(k).and_then(|x| x.as_u64()).and_then(|n| u16::try_from(n).ok()).filter(|p| *p != 0).unwrap_or(dflt)
    };
    Ports {
        mgmt: port_of("mgmt", DEFAULT_MGMT),
        gw: port_of("gw", DEFAULT_GW),
        tunnel: port_of("tunnel", DEFAULT_TUNNEL),
    }
}

/// 把一个字段的实际值合并写进档案（其余字段保持原样；文件不存在/损坏则以
/// 当前 `read()` 结果——缺失=默认值——为底重建）。失败只记日志不 panic：
/// 档案是可再生的派生信息，不值得为它炸掉服务启动。
pub fn record(kind: &str, port: u16) {
    let _g = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = ports_path();
    // 底：现有文件可用则逐字段合并；损坏/缺失 → 默认值整体重写（兼容条款：
    // 损坏档案在任何一次 record 后即自愈为全默认+本次实际值）。
    let mut base: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::to_value(Ports::default().to_json()).unwrap_or_default());
    if let Some(o) = base.as_object_mut() {
        o.insert(kind.to_string(), serde_json::json!(port));
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(&path, serde_json::to_string(&base).unwrap_or_default()) {
        eprintln!("[ports-file] 写 {kind}={port} 失败（{}）: {e}", path.display());
    }
}

impl Ports {
    /// 对外 JSON 形状（与文件格式一致：小写字段名——这是跨进程文件约定，
    /// 不走 FE/BE 的 camelCase 通道）。
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({ "mgmt": self.mgmt, "gw": self.gw, "tunnel": self.tunnel })
    }
}

/// 管理面 bind 尝试序列（纯函数，单测直击）：先记忆口（跨重启复用，调用方
/// 缓存的 URL 不失效），被占则从 3102 起递增至 `MGMT_MAX`。记忆口本身在
/// 扫描区间内时去重（不试两遍）。
pub fn mgmt_bind_candidates(remembered: Option<u16>) -> Vec<u16> {
    let mut v: Vec<u16> = Vec::with_capacity(52);
    if let Some(r) = remembered.filter(|p| *p != 0) {
        v.push(r);
    }
    for p in DEFAULT_MGMT..=MGMT_MAX {
        if !v.contains(&p) {
            v.push(p);
        }
    }
    v
}

#[cfg(test)]
mod port_file_tests {
    use super::*;

    /// 承 dsh_share/p2p_tunnel 的隔离纪律：进程级 MYCO_CONFIG_DIR 临时目录 +
    /// 全局锁串行（fs 落盘测试不得互踩，也不得碰真实 %APPDATA%）。
    fn isolated() -> std::sync::MutexGuard<'static, ()> {
        crate::test_env_lock::test_env_lock()
    }

    /// 读写往返：三字段各自 record → read 全部命中（合并写不覆盖兄弟字段）。
    #[test]
    fn roundtrip_and_merge_write() {
        let _g = isolated();
        let _ = std::fs::remove_file(ports_path());
        record("mgmt", 3103);
        record("gw", 13911);
        record("tunnel", 9102);
        let p = read();
        assert_eq!(p, Ports { mgmt: 3103, gw: 13911, tunnel: 9102 });
        // 合并写：单字段更新不动其余
        record("mgmt", 3104);
        assert_eq!(read().mgmt, 3104);
        assert_eq!(read().gw, 13911, "mgmt 换口不得覆盖 gw 字段");
        assert_eq!(read().tunnel, 9102, "mgmt 换口不得覆盖 tunnel 字段");
    }

    /// 兼容：文件不存在 → 默认值；损坏 → 默认值（读取零副作用、不 panic）。
    #[test]
    fn missing_or_corrupt_file_falls_back_to_defaults() {
        let _g = isolated();
        let _ = std::fs::remove_file(ports_path());
        assert_eq!(read(), Ports::default(), "无档案 = 全默认");
        std::fs::write(ports_path(), "{not json at all").unwrap();
        assert_eq!(read(), Ports::default(), "坏档案 = 全默认");
        std::fs::write(ports_path(), r#"{"mgmt":"abc","gw":0,"tunnel":99999}"#).unwrap();
        assert_eq!(read(), Ports::default(), "字段非法（串/0/越界）= 对应默认");
        // 坏档案自愈：任一 record 后以默认+实际值重写
        record("mgmt", 3105);
        assert_eq!(read(), Ports { mgmt: 3105, ..Ports::default() });
    }

    /// 管理面 bind 序列：记忆口优先 + 3102 起递增（上限 3102+50）+ 去重。
    #[test]
    fn mgmt_bind_candidates_shape() {
        let none = mgmt_bind_candidates(None);
        assert_eq!(none.first(), Some(&3102), "无记忆从 3102 起");
        assert_eq!(none.last(), Some(&(3102 + 50)), "上限 3102+50（含）");
        assert_eq!(none.len(), 51);
        let remembered = mgmt_bind_candidates(Some(3107));
        assert_eq!(remembered.first(), Some(&3107), "记忆口最先试（重启复用）");
        assert_eq!(remembered.len(), 51, "扫描区间含 3107 → 去重后总数不变");
        assert_eq!(remembered[1], 3102);
        // 记忆口在区间外（手改档案）：先试它，再全区间扫描
        let outside = mgmt_bind_candidates(Some(3200));
        assert_eq!(outside.first(), Some(&3200));
        assert_eq!(outside.len(), 52);
    }
}
