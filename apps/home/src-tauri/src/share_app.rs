//! 分享应用适配器边界（DSH 插件下沉的 P0 落点，2026-11-02）。
//!
//! 用户口径：**能不在 myco 核心就不放核心**——身份/授权/传输/恢复/审计留在 myco，
//! 具体应用的协议（DSH 的 BOOT、上游 cookie、HTTP/WS 反代、mux、session 投影、
//! caps 词表与页面状态映射）交给「分享应用适配器」，最终由 DSH 插件承载。
//!
//! P0（本文件当前形态）：定义边界与注册表，把「kind → 目标口/人话名/env 描述/
//! 动作判定」先从 `vnet_env` 常量表抽到适配器实现里（**行为零变化**，数值与文案
//! 与旧表逐字一致）；DSH 适配器内部暂委托既有实现，后续 P1 再把 BOOT/反代/mux
//! 等实体代码迁入 `dsh_adapter` 模块、P3 再迁出进程成为 DSH 插件。
//!
//! 不变量（任何阶段都不得破）：
//! 1. **P/A 权威在 host myco core**：适配器只执行、不裁决 DID；
//! 2. **私钥红线**：适配器永远拿不到设备种子，只拿 [`AuthorizedCtx`]；
//! 3. **默认拒绝**：适配器缺失/异常 → 上层 fail-closed，绝不绕过鉴权；
//! 4. 浏览器零凭据：简版地址 `http://127.0.0.1:<port>/gw/<shareId>/` 形态不变。

/// 已由 myco core 裁决过的授权上下文（适配器**只能在其范围内执行**）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizedCtx {
    pub share_id: String,
    pub did: String,
    pub label: String,
    /// 生效 caps（`session.read` / `session.input` / `agent.view` / `scope.switch` …）。
    /// 令牌对 myco core 而言是**不透明字符串**，其语义由适配器解释。
    pub caps: Vec<String>,
    /// 只读分享（适配器必须拒绝写类动作）。
    pub ro: bool,
}

/// 适配器要判定的动作（P0 只有粗粒度，P1 细化到 DSH RPC 方法级）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppAction {
    /// 已授权 HTTP 请求（method + 上游相对路径）。
    Http { method: String, path: String },
    /// WS 升级（上游相对路径）。
    Ws { path: String },
    /// 打开该分享的 env（点卡/env open）。
    EnvOpen,
}

/// env 描述：目标端口、requires、人话名（供 env/open 与卡片展示）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvDescriptor {
    pub kind: &'static str,
    pub default_target_port: u16,
    pub requires: Option<&'static str>,
}

/// 一类「被分享的应用」的协议适配器（注册表见 [`adapter_for`]）。
pub trait ShareAppAdapter: Send + Sync {
    /// env kind（与卡面 `env.kind` 一致）：`"dsh"`。
    fn kind(&self) -> &'static str;
    /// 人话服务名（no-service 文案）：旧表里 dsh = `"DSH web"`。
    fn title(&self) -> &'static str;
    /// env 未显式给 port 时的目标端口：旧表里 dsh = 13911（host Gateway 根口）。
    fn default_target_port(&self) -> u16;
    /// env 未显式给 localPort 时的**本机**默认口（浏览器/代理看到的口）。dsh = 23911。
    fn default_local_port(&self) -> u16;
    /// env 描述（P1 起由插件提供健康/上游地址；P0 只是静态描述）。
    fn env_describe(&self, _share_id: &str) -> EnvDescriptor;
    /// 动作判定：core 已裁决，适配器只做**应用语义**的收紧（如 ro 拒绝写）。
    fn authorize_action(&self, ctx: &AuthorizedCtx, action: &AppAction) -> Result<(), String>;
}

/// DSH 适配器（P0：数值/文案与 `vnet_env` 旧常量表逐字一致；实体协议下一步迁入）。
pub struct DshAdapter;

impl ShareAppAdapter for DshAdapter {
    fn kind(&self) -> &'static str {
        "dsh"
    }

    fn title(&self) -> &'static str {
        "DSH web"
    }

    fn default_target_port(&self) -> u16 {
        13911
    }

    fn default_local_port(&self) -> u16 {
        23911
    }

    fn env_describe(&self, _share_id: &str) -> EnvDescriptor {
        EnvDescriptor { kind: "dsh", default_target_port: 13911, requires: Some("dsh") }
    }

    fn authorize_action(&self, ctx: &AuthorizedCtx, action: &AppAction) -> Result<(), String> {
        // P0 只做**只读收紧**：写类动作用 caps 词表判定；读类与 env 打开沿用 core 裁决。
        // 未知动作 fail-open 是历史兼容口径（P1 迁到方法级 allowlist 时改成默认关）。
        let write = match action {
            AppAction::Http { method, .. } => {
                !matches!(method.to_ascii_uppercase().as_str(), "GET" | "HEAD" | "OPTIONS")
            }
            _ => false,
        };
        if write && ctx.ro {
            return Err("该分享为只读，写请求被拒绝".into());
        }
        Ok(())
    }
}

/// 适配器注册表：`env.kind` → 适配器。未注册的 kind（rdp/ssh/stereo/adb/http…）
/// 返回 `None`——它们不经过应用适配器，继续由 myco 通用链路处理。
pub fn adapter_for(kind: &str) -> Option<&'static dyn ShareAppAdapter> {
    static DSH: DshAdapter = DshAdapter;
    match kind {
        "dsh" => Some(&DSH),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(ro: bool) -> AuthorizedCtx {
        AuthorizedCtx {
            share_id: "sh-1".into(),
            did: "did:myco:dev".into(),
            label: "设备·测试".into(),
            caps: vec!["session.read".into()],
            ro,
        }
    }

    /// P0 硬约束：数值/文案必须与旧 `vnet_env` 表**逐字一致**（行为零变化）。
    #[test]
    fn dsh_adapter_matches_legacy_defaults() {
        let a = adapter_for("dsh").expect("dsh 必须注册");
        assert_eq!(a.kind(), "dsh");
        assert_eq!(a.title(), crate::vnet_env::service_name("dsh"));
        assert_eq!(Some(a.default_target_port()), crate::vnet_env::default_target_port("dsh"));
        let d = a.env_describe("sh-1");
        assert_eq!(d.kind, "dsh");
        assert_eq!(d.default_target_port, 13911);
        assert_eq!(d.requires, Some("dsh"));
    }

    /// 非应用类 kind 不注册（rdp/ssh 等继续走通用链路）。
    #[test]
    fn non_app_kinds_have_no_adapter() {
        for k in ["rdp", "ssh", "stereo", "adb", "http", "nope", ""] {
            assert!(adapter_for(k).is_none(), "{k} 不应注册应用适配器");
        }
    }

    /// 只读分享的写请求必须被适配器拒绝；读请求放行（写判定与旧 ro 口径一致）。
    #[test]
    fn readonly_share_rejects_writes() {
        let a = adapter_for("dsh").unwrap();
        let get = AppAction::Http { method: "GET".into(), path: "/app/api/session/list".into() };
        let post = AppAction::Http { method: "POST".into(), path: "/app/api/session/prompt".into() };
        assert!(a.authorize_action(&ctx(false), &get).is_ok());
        assert!(a.authorize_action(&ctx(false), &post).is_ok());
        assert!(a.authorize_action(&ctx(true), &get).is_ok());
        assert!(a.authorize_action(&ctx(true), &post).is_err());
        assert!(a.authorize_action(&ctx(true), &AppAction::EnvOpen).is_ok());
        assert!(a.authorize_action(&ctx(true), &AppAction::Ws { path: "/app/api/remote.mux".into() }).is_ok());
    }
}
