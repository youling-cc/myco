//! cli.rs — home 的 CLI 分支（纯 Rust，无 tauri 依赖；`myco cli <子命令>` 进入）。
//!
//! feat/cli-suite 设计（协调者定稿）：
//! - 身份/设备/委任状原语**全部复用共享 crate myco-core**（core_id + core_deleg），
//!   不引入第二套身份实现——A2 myco-ubuntu 的薄原语（identity.rs/device.rs）弃用，
//!   只提取其命令词表结构 / serve HTTP API 面 / 冒烟方法（见 cli_serve.rs 与
//!   scripts/cli_smoke_test.py）。
//! - 命令词表三端对齐（phone cli.ts 头注释为权威）：
//!   identity birth/did/list/export-seed · sign · device register/list/revoke/token/
//!   verify-token · delegation issue/verify/list/revoke · attest · serve · status
//!   · share create/list/grant/visibility/revoke（分享网关管理面的 HTTP 语法糖，
//!     见本文件 `share` 段：只调 `:3102/api/dshShare/*`，不直读 dsh-shares.json）
//! - 密钥/种子路径 = home 现状（GUI 与 CLI 同一身份域）：core_id 的
//!   config_dir()（%APPDATA%\youling，MYCO_CONFIG_DIR 覆盖）——**无独立 --data-dir**，
//!   设备钥 device.key / 账号种子 accounts/<did>.seed / 委任状 delegations.json
//!   与 GUI 完全共享，`cli identity did` 与 GUI「我的」面板同一身份。
//! - 输出约定（A2 同款）：成功 pretty JSON → stdout；失败 stderr + exit 1。
//!
//! wire 兼容（跨端互操作，phone cli.ts / A2 同款）：
//!   device-grant msg = "device-grant\n{orgDid}\n{deviceDid}\n{scopes}\n{expiresAt}"
//!     token = base64(json({orgDid,deviceDid,scopes,issuedAt,expiresAt,sigB64})) camelCase
//!   delegation wire = base64(json(Delegation))（myco-core encode_present，camelCase，
//!     msg = "delegation\n{accountDid}\n{devicePubkeyB64}\n{deviceName}\n{scopes}\n{issuedAt}\n{exp}\n{nonce}"）
//!   attest msg = "attest\n{rootDid}\n{pubkeyB64}\n{issuedAt}"（第68轮归一协议）

use base64::Engine as _;
use ed25519_dalek::Signer as _;
use myco_core::delegation as core_deleg;
use myco_core::identity as core_id;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;

use crate::cli_serve;

fn b64e(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}
fn b64d(s: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| format!("base64 解码失败: {e}"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// identity-svc 基址（与 identity_service.rs 同源规则：MYCO_DID_BASE 覆盖）。
fn base_url() -> String {
    std::env::var("MYCO_DID_BASE").unwrap_or_else(|_| "https://myco.youling.cc/myco-id".into())
}

// ─── 入口 ───

/// CLI 主入口（main.rs 分叉调用，args 不含 `cli` 前缀）。
pub fn main(args: &[String]) {
    match args.first().map(String::as_str) {
        None | Some("help") | Some("--help") | Some("-h") => usage_exit(false),
        Some(sub) => {
            if !is_cli_command(sub) {
                eprintln!("error: 未知子命令 {sub:?}（可用: account/auth/identity/sign/wallet/device/delegation/attest/serve/share/task/env/vnet/presence/status/friend/chat/session）");
                usage_exit(true);
            }
            dispatch(sub, &args[1..]);
        }
    }
}

/// 首参是否 CLI 子命令。
///
/// 2026-11-03（UI 能力 CLI 补齐）：新增 account（账号生命周期）、auth（网页登录深链）、
/// task（任务卡）、env（环境入口）、vnet（转发/隧道）、presence（在线态）、wallet（钱包签名）。
pub fn is_cli_command(s: &str) -> bool {
    matches!(
        s,
        "identity" | "sign" | "device" | "delegation" | "attest" | "serve" | "share" | "status"
            | "friend" | "chat" | "session" | "p2p" | "account" | "auth" | "task" | "env" | "vnet"
            | "presence" | "wallet"
    )
}

pub fn usage_exit(err: bool) -> ! {
    println!(
        "myco cli —— home 登录器 CLI 通道（与 phone / linux 形态同一套命令词表；
        2026-11-03 起按「UI 有的 CLI 都要有」补齐账号/登录/成员设备/授权/任务卡/vnet 六条线，
        能力矩阵与边界见 dev/CLI-PARITY.md）

用法: myco cli <子命令> [参数]
  identity birth                   幂等确认本机设备身份（device.key，与 GUI 同钥）
  identity did                     DID Document（设备层 + 本机持有的根账号层）
  identity list                    本机账号清单
  identity switch --did <did>      激活已持有的主账号/成员账号（无种子成员用委任状）
  identity export-seed             导出根种子 b64（仅具身设备；谨慎保管）
  sign <payload-b64> [--as root|device]   Ed25519 签名（auto=根钥优先，回退设备钥并标注 signer）
  device register --did <deviceDid> [--name N] [--no-delegation]
                                   attest 上云 + 顺签委任状（第68轮归一协议）
  device list                      设备清单（云名册 + 在线状态）
  device rename --name N           本机设备改名（显示名标签；中文可用，DID/授权不变）
  device revoke <did|pubkeyB64>    云除名（被吊销设备轮询自见）
  device token --did <deviceDid> [--scopes a,b] [--ttl-secs 3600]
                                   根账号签发设备授权 token（phone 同构 wire）
  device verify-token <token-b64>  离线验证设备授权 token
  delegation issue --did <deviceDid|pubkeyB64> [--name N] [--scopes a,b]
                                   签发委任状（返回 wire，三端互通）
  delegation verify <wire-b64>     离线验证委任状
  delegation list                  本机委任状清单
  delegation revoke <did|pubkeyB64>  本地吊销 + 云端吊销注册表传播
  attest --did <deviceDid>         生成 attest 签名（不上云；调试/人工通道）
  p2p tunnel drop --did <deviceDid>
                                   强杀指定设备的持久隧道（T8 断线恢复测试钩子；
                                   下一条消息自动重建，预期 ≤2s）
  serve [--port 3102]              无 UI HTTP 服务（headless 调用面，端点见 /healthz）
  status                           身份/账号/委任状概要

账号生命周期（2026-11-03：与 UI 账号页/登录页同一套 core 原语；种子/私钥不出 core）：
  account status                   账号态（hasSoul/hasPassword/locked/legacy + 角色/配置目录）
  account list                     本机账号清单（含角色：embodiment/agent）
  account create [--name N] [--password P] [--phone P] [--email E] [--force]
                                   新建 youling 账号（DID 由账号钥派生；--force=已有账号也再建）
  account import --text <恢复码>|--file <路径> [--password P]
                                   导入账号（明文 seedB64 或 ct=/salt=/iv= 加密备份+密码）
  account login [--password P] [--base-url URL]
                                   设备身份注册 + 登录 identity-svc（YoulingAuth 第一步同款）
  account unlock --password P       解锁加密账号（解锁后本进程内可用根钥）
  account set-password --password P / account remove-password --password P
  account switch --did <账号did>   切活动账号（= identity switch，主设备种子槽或成员委任状）
  account rename --name <新名>     改账号名（账号钥签 rename，成功后本地清单直写）
  account logout                   登出（清会话/活动指针；账号数据留在各自桶）
  account device-logout            设备注销（删本机 device.key；账号层/服务端名册不动）
  account unbind                   解绑本机账号（删账号种子+active+会话；设备钥保留，高风险）
  account discover                 云名册反查 → 自动发现被收编账号（joined/alreadyListed/…）
  account set-backed-up            标记账号已备份（服务端 backedUp 旗标）

登录深链（myco://auth；网页侧密码/验证码/扫码三种方式都在 youling 页面完成，
CLI 负责出登录地址 + 本地签名 + 回调确认；分身设备用 --delegated 走委任状签名）：
  auth url [--page <页面URL>]      出可登录 URL（平台出票 + 本机签名确认，10 分钟内复用）
  auth sign --ticket <票据> [--delegated]
                                   签 myco-auth\\n{{ticket}}（根钥；--delegated=设备钥+委任状）
  auth confirm --url <回调地址> --ticket <票据>
               (--token <identity-svc 会话token> | --sig <签名> --did <did> [--delegation <json>])
                                   确认登录（回调地址按白名单校验，仅 http(s)）
  auth session-key [--status|--clear|--pubkey <b64>]
                                   提交面会话钥：看剩余 / 清理 / 签发（12h，silent=只续期）

成员设备（配对/授权/名册；= UI「我的设备」三张卡的全部动作）：
  device add --did <deviceDid> --name <名>
                                    添加成员设备（attest 上云 + 投递委任状 + P2P 收编通知）
  device enroll [--wait <秒>] [--json]
                                    被添加方一键取件：名册反查 + 拉委任状并落本地（UI 20s 轮询同源）
  device invite                    出邀请码（nonce/5 分钟有效；手机扫码后走 device pair）
  device pair list                 待确认配对申请（/signal/drain 的 type=pair）
  device pair confirm|reject|dismiss --did <did>
                                    确认授权 / 拒绝 / 忽略配对申请
  device authorized [list]         本机设备白名单（authorized-dids.json）
  device authorized rename --did D --name N / device authorized remove --did D
                                    改白名单显示名 / 删白名单记录（可重新配对；不动名册）
  device trusted [list]            可信根账号（roots）清单
  device trusted rename --did D --name N / device trusted note --did D --note T
  device scopes --did D --scopes a,b         设该设备的任务域授权范围
  device allow --did D [--ttl-ms N] / device deny --did D
                                    放行/拒绝该设备连本机（临时授权带有效期）
  device origin-revoke --origin O  按出生地整组吊销白名单（返回移除数）
  device group                     设备群：群 id + 成员 + 在线态（= UI「智能体」Tab 设备群）

分享网关管理面（薄 HTTP 语法糖——只调运行中网关的本地管理面 /api/dshShare/*，
与 myco skill 同一套端点；不直接读写 dsh-shares.json。管理面默认 :3102，被占
自动顺延（3102..3152），实际口见 %APPDATA%\\youling\\ports.json 的 mgmt 字段）：
  share create --granularity session|workspace|instance|main
               [--session-id X | --cwd DIR] [--title T]
               [--visibility private|public] [--space machine|project|session]
               [--sessions id1,id2] [--window-ms N]
               [--caps session.read,session.input] [--goal G] [--sla S] [--reward R]
               [--env-kind rdp|dsh|ssh|http|stereo|adb|vnc|rustdesk --env-device <did>
                [--env-port P] [--env-local-port P] [--env-label L]]
               [--grant-to <名> [--grant-did <did>]]
                                   一条命令声明完整任务：档位 + S/O/A 约束 + 谁能进
                                   （--env-kind = 环境卡，缺档位默认 main、不拉实例）
                                   → 打印 shareId/入口；--grant-to 顺带签一条邀请
                                   （不出网前本地校验 --caps/--space/--window-ms）
  share list [--json]              全部分享（档位/标题/state/可见范围概要）
  share grant --share <id> --label <名> [--did <did>] [--ttl-secs N]
              [--window-ms N] [--caps session.read,session.input] [--ro]
                                   签发授权 → 打印给对方用的 bearer URL
  share visibility --share <id> --space machine|project|session
                   [--sessions id1,id2] [--window-ms N]
                                   设可见范围（S→O 投影）
  share revoke --share <id> [--label <名>]
                                   整个分享下线 / 只吊销某人的 grant

  share grants --share <id>        谁能看：协作者 + 每人**生效**能力/可见范围/转授权
  share caps --share <id> --caps a,b,c
                                    覆盖**任务级**能力集（四个固定 id 的声明面）
  share grant-caps --share <id> --did D --caps a,b
                                    逐人能力（只收紧任务级声明；列出的=true，其余=false）
  share revoke-all --share <id>    收回全部协作者授权（保留 owner 自己的行）
  share requests [--share <id>]    待批申请（提权 rw/claim/history/reshare；= list.pendingRequests）
  share req-decide --request <reqId> (--approve|--deny) [--remember]
                                    批/驳一条待批申请（转授申请走同一队列）
  share reshare [--share <id>]     待批准的转授申请（主人侧；只要 want=reshare）
  share reshare-decide --share <id> --request <id> (--approve|--deny) [--remember]
                                    批/驳一条转授申请（--remember=以后这人转授不再问）
  share can-reshare --share <id> [--did D (--on|--off) | --all (--on|--off)]
                                    看/开关转授权限（--all=全部非 owner 协作者）
  share perm --share <id> --did D [--read|--no-read] [--write|--no-write]
             [--window-ms N | --window-full]
                                    owner 实时管控：读写开关 + 历史窗口（下一请求即生效）
  share suspend|resume|complete --share <id>
                                    暂停（全员只读）/恢复/标记任务完成（complete→closed）
  share kill --share <id>          杀掉该分享的实例/会话进程（分享记录保留）
  share open --share <id>          本机现签 owner 入口 URL（点开即进，永不失效）
  share task-group --share <id>    任务群（幂等建群，返回 groupId/members）
  share ensure-group --share <id>  确保任务群存在（只返回 groupId）
  share sessions [--share <id>]    可授权的会话清单（§3.22 options 同源）
  share capabilities [--share <id>] 能力目录（caps 词表 + 来源/降级说明）
  share events [--share <id>] [--since-ms N]
                                    读取授权/状态事件流（NDJSON 回放，按分享/时间过滤）
  share publish --share <id> --goal G [--sla S] [--reward R]
                                    发布为公共任务（state→published；缺 goal 会被拒）

任务卡（= UI 任务 Tab「好友分享的任务」；与 UI 同一实现 chat_service）：
  task list [--all] [--json]       任务卡清单（默认不列 shared=我分享出去的；--all 含）
  task accept --task <taskId>      接受任务卡（pending → todo，回执给对方）
  task status --task <taskId> --status todo|doing|done
                                   改任务状态（done 会合并参与者并回发完成事件）
  task rename --task <taskId> --title <新标题>   仅 owner；落库 + 广播
  task open --task <taskId> [--dry-run]
                                   打开任务卡：卡上 env → POST /api/env/open 建链（rdp/dsh/…）；
                                   无 env 的 open-url 卡只打印链接（不劫持浏览器）
  task tombstone --task <id> [--ids a,b] [--reason R] [--no-broadcast]
                                   清理测试卡（持久撤销名单，防对账/重投复活；默认广播同账号设备）
  task delete --task <id>          从本地任务库删除（dev 门禁：网关需 MYCO_DEV_API=1）
  task youling | task resume       平台「我的任务」/能力画像（youling_tasks，30s 缓存）

好友（2026-10-12「UI 有的感知/状态/动作 CLI 都要有」第一批；档案=本地权威
friends.json，与 UI 同档案同语义）：
  friend list                      感知：好友快照（只读本地，零网络）
  friend add --did <账号did> --name <名>
                                    动作：管理员直写加好友（=签名握手完成态，
                                    不向对端投递；运维/测试/双端自管 E2E 用。
                                    正常加好友走 UI 的 friend-request/accept 握手）
  friend remove --did <账号did>    动作：删好友行（幂等）

聊天（2026-10-12 第二批；与 UI 同一实现 chat_service，非协议重造）：
  chat state                        感知：会话/群/未读概要（含会话 id——conv 用）
  chat send --to <对方账号did> --text <内容>
                                    动作：单聊文本（P2P 直推→信箱兜底）
  chat group --group <群id> --text <内容>
                                    动作：群聊文本（端侧按 members 扇出）
  chat conv <会话id>                感知：读一个会话的落盘消息（验证投递）

DSH 会话（2026-10-13 agent 间通讯：给 DSH 会话投消息，prompt 注入立即触发对方 AI；
wire 细节在 dsh_share.rs 的 CLI bridge——这里只是命令面）：
  session list [--json]            感知：本机 DSH 会话清单（会话名 + sessionID）
  session send --to <会话名|sessionID> --text <内容>
                                    动作：本机直投（本机 DSH web，operator 身份）
  session send --task <sh-xxx> --text <内容>
                                    动作：经 myco 分享网关投递（本机任务卡捷径 /
                                    隧道到源设备；对方网关会追加授权署名）
  · 消息自动带发送方前缀 [<会话名>]: ——会话名取 $DSH_SESSION_ID 对应会话，
    查不到用 id 尾 8 位；无环境变量则 [myco]

环境入口与虚拟组网（2026-11-03；只调运行中网关的本地管理面 :3102——隧道/租约/
客户端进程都活在常驻 GUI 进程里，一次性 CLI 进程自建隧道会随退出而死）：
  env kinds                        支持的 env.kind 白名单（rdp/dsh/ssh/http/stereo/adb/vnc/rustdesk）
  env open --kind K --device <did> [--port P] [--local-port P] [--label L]
           [--entry-url U] [--card-id S] [--task-id T]
                                   按环境声明建 127.0.0.1:<固定口> 链路并起客户端
                                   （state=ready/offline/no-service/denied 如实回）
  vnet status                      统一状态面（网络指纹 + S 层 + 转发口全表 + 隧道健康）
  vnet forwards                    当前活跃端口隧道（device/port/localPort）
  vnet forward --device D --port P [--local-port P]
                                   按需开一条隧道（返回本地口）
  vnet keep --device D --port P [--local-port P] [--label L]
                                   持久化转发（重启/断线自动重建）+ 立即开一次
  vnet unkeep --device D --port P  移除持久化记录（不关当前隧道）
  vnet close --device D --port P   关闭隧道（释放本地口）
  vnet leases                      端点租约表（state/health/listener/失败原因）
  vnet netstate                    L1–L4 网络状态快照
  vnet ports                       端口白名单（能力发现）
  vnet mdns                        同 LAN mDNS 发现快照
  vnet diag                        网络诊断（含 v4 探测，会发网络请求）
  vnet tune [--batch N] [--disable-ipv6 on|off]
                                   隧道上行批量帧数 / 禁用 v6 热调
  vnet allow-ports [--add a,b] [--remove a,b]
                                   用户级端口授权（增删即持久化、立即生效）
  vnet rdp --device D [--port 3389] [--local-port P] [--user U] [--no-launch]
                                   keep + 建链 + 写临时 .rdp + 起 mstsc（--no-launch 只出文件）

在线态（UI 好友灯/我的设备；心跳由常驻 GUI 维持，CLI 只读一次快照）：
  presence [--friends|--devices]   好友在线灯 + 本机其他设备（active/typing/idle/locked）

钱包签名（UI 网页登录/探索自动登录同一原语；根钥或设备钥+委任状）：
  wallet sign --message <文本> [--delegated]

环境: MYCO_DID_BASE（identity-svc，默认 https://myco.youling.cc/myco-id）/ MYCO_SERVE_PORT
      MYCO_SHARE_LOCAL_PORT / ENV_HTTP_PORT（分享网关管理面端口，默认 3102——不设
      则读 ports.json 记忆口；被占自动顺延，实际口落 ports.json）
密钥域: %APPDATA%\\youling（MYCO_CONFIG_DIR 覆盖）——与 GUI 同一身份，无独立 data-dir
端口档案: %APPDATA%\\youling\\ports.json = {{\"mgmt\":3102,\"gw\":13911,\"tunnel\":9100}}
      ——三个常驻面的实际口（mgmt 动态顺延 / gw 本期固定 / tunnel 冲突顺延后实测值），
      skill/agent 一律从这里发现端口"
    );
    std::process::exit(if err { 1 } else { 0 })
}

fn die(msg: impl std::fmt::Display) -> ! {
    eprintln!("error: {}", msg);
    std::process::exit(1)
}

fn out(v: serde_json::Value) -> ! {
    println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
    std::process::exit(0)
}

/// 单线程 tokio 跑 core_id 的异步调用（CLI 场景无需多线程）。
fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(f)
}

// ─── 参数解析（A2 cli.rs 同规则：--key value / --key=value / bool flag；positional 收集）───

#[derive(Debug)]
pub struct Parsed {
    pub positional: Vec<String>,
    pub flags: HashMap<String, String>,
}

/// 已知无值布尔 flag（phone 同款：--no-delegation；share 段加 --json / --ro；
/// 2026-11-03 补齐 account/auth/share/task/vnet 的新布尔面）。
const BOOL_FLAGS: &[&str] = &[
    "no-delegation", "json", "ro",
    // account / auth / wallet
    "force", "delegated", "clear",
    // share 授权面
    "read", "no-read", "write", "no-write", "window-full", "on", "off", "all",
    "approve", "deny", "remember",
    // task / presence / vnet
    "no-broadcast", "dry-run", "devices", "friends", "no-launch",
];

/// **多值一律用逗号**的 flag（`--sessions a,b`）。同键重复出现本地报错——
/// `HashMap` 的既有语义是"后给覆盖前给"，对多值面就是**静默丢掉前一个**
/// （`--sessions a --sessions b` 只剩 b），比报错难查得多。
const CSV_FLAGS: &[&str] = &["sessions"];

pub fn parse_args(args: &[String]) -> Result<Parsed, String> {
    let mut p = Parsed { positional: vec![], flags: HashMap::new() };
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if let Some(stripped) = a.strip_prefix("--") {
            if stripped.is_empty() {
                return Err("空 flag".into());
            }
            if let Some((k, v)) = stripped.split_once('=') {
                if CSV_FLAGS.contains(&k) && p.flags.contains_key(k) {
                    return Err(format!("flag --{k} 重复给——多值请用逗号: --{k} a,b"));
                }
                p.flags.insert(k.to_string(), v.to_string());
            } else if BOOL_FLAGS.contains(&stripped) {
                p.flags.insert(stripped.to_string(), "true".into());
            } else if i + 1 < args.len() && !args[i + 1].starts_with("--") {
                if CSV_FLAGS.contains(&stripped) && p.flags.contains_key(stripped) {
                    return Err(format!("flag --{stripped} 重复给——多值请用逗号: --{stripped} a,b"));
                }
                p.flags.insert(stripped.to_string(), args[i + 1].clone());
                i += 1;
            } else {
                return Err(format!("flag --{stripped} 缺值"));
            }
        } else {
            p.positional.push(a.clone());
        }
        i += 1;
    }
    Ok(p)
}

fn scopes_csv(s: Option<&String>) -> Option<Vec<String>> {
    s.map(|v| v.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
}

// ─── 身份公共件 ───

/// 设备钥已存在？（identity birth 的 born 判定；device.key = core_id 设备钥主名）。
fn device_key_exists() -> bool {
    myco_core::config::config_dir().join("device.key").is_file()
}

/// did:<method>:<b58> → b58 尾巴（= publicKeyBase58；裸公钥规范）。
fn b58_tail(did: &str) -> Option<String> {
    did.split_once(':').and_then(|(_, rest)| rest.split_once(':')).map(|(_, tail)| tail.to_string())
        .filter(|t| !t.is_empty())
}

/// DID Document（与 phone didDocument / A2 identity.rs document() 同构）。
fn device_document(did: &str) -> serde_json::Value {
    // publicKeyBase58 语义=裸 32B 公钥 base58（W3C 通行口径）。did spec v0.3 后 did 串可能是
    // canonical z-multibase（尾=34B ed01+pk），不能直接当公钥尾巴用——经 did_pubkey_bytes
    // 归一后再编码；解析失败（软 did）退回 b58_tail 作展示兜底（非判定面）。
    let pk_b58 = myco_core::identity::did_pubkey_bytes(did)
        .map(|pk| bs58::encode(pk).into_string())
        .or_else(|| b58_tail(did));
    let mut doc = json!({
        "id": did,
        "verificationMethod": [{
            "id": format!("{}#key0", did),
            "type": "Ed25519VerificationKey2020",
            "publicKeyBase58": pk_b58,
        }],
    });
    // created 取 device.key mtime（不可得则省略——phone 同款宽容）
    if let Ok(md) = std::fs::metadata(myco_core::config::config_dir().join("device.key")) {
        if let Ok(t) = md.modified() {
            if let Some(dt) = chrono::DateTime::<chrono::Utc>::from_timestamp(
                t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0),
                0,
            ) {
                doc["created"] = json!(dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
            }
        }
    }
    doc
}

/// 设备身份（did:myco:<b58>，幂等创建——core_id device_identity）。
fn require_device() -> (String, [u8; 32]) {
    match core_id::device_identity() {
        Ok((did, seed_b64)) => match b64d(&seed_b64) {
            Ok(raw) => match <[u8; 32]>::try_from(raw.as_slice()) {
                Ok(seed) => (did, seed),
                Err(_) => die("设备种子长度异常（≠32B）"),
            },
            Err(e) => die(e),
        },
        Err(e) => die(format!("设备身份不可用: {e}")),
    }
}

/// 根账号签名钥（无根钥即死——分身设备无公章）。
fn require_root() -> (String, [u8; 32]) {
    let seed = core_id::cached_account_seed().unwrap_or_else(|| die("本机未持有根钥（分身设备，或加密模式请先在 GUI 解锁）"));
    let did = core_id::account_did().unwrap_or_else(|| die("DID 缺失"));
    (did, seed)
}

// ─── device-grant token wire（phone cli.ts 同构，camelCase JSON）───

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantClaims {
    pub org_did: String,
    pub device_did: String,
    pub scopes: Vec<String>,
    pub issued_at: u64,
    pub expires_at: u64,
    #[serde(default)]
    pub sig_b64: String,
}

impl GrantClaims {
    pub fn msg(&self) -> String {
        format!("device-grant\n{}\n{}\n{}\n{}", self.org_did, self.device_did, self.scopes.join(","), self.expires_at)
    }
}

pub fn issue_grant(claims: &GrantClaims, root_seed: &[u8; 32]) -> String {
    let signing = ed25519_dalek::SigningKey::from_bytes(root_seed);
    let mut c = GrantClaims { sig_b64: String::new(), ..serde_json::from_value(serde_json::to_value(claims).unwrap()).unwrap() };
    c.sig_b64 = b64e(&signing.sign(c.msg().as_bytes()).to_bytes());
    b64e(&serde_json::to_vec(&c).unwrap_or_default())
}

/// 离线验 token：orgDid 裸公钥验签 + 过期检查。返回 (valid, reason/claims)。
pub fn verify_grant(token_b64: &str) -> (bool, String, Option<GrantClaims>) {
    let raw = match b64d(token_b64) {
        Ok(r) => r,
        Err(_) =>{ return (false, "token 结构不符（base64 解不开）".into(), None); }
    };
    let claims: GrantClaims = match serde_json::from_slice(&raw) {
        Ok(c) => c,
        Err(_) =>{ return (false, "token 结构不符（json 解不开）".into(), None); }
    };
    if claims.org_did.is_empty() || claims.device_did.is_empty() || claims.sig_b64.is_empty() {
        return (false, "token 缺 orgDid/deviceDid/sigB64".into(), None);
    }
    // spec v0.3 canonical-only（2026-10-10）：org did 只收 canonical——尾段必须 z 开头，
    // z 后 base58 须 34B 且 0xed 0x01 头（legacy 裸 base58 已废止，不再回落解码）。
    let Some(tail) = b58_tail(&claims.org_did) else {
        return (false, "不支持的 did 格式（orgDid 须为 did:<method>:z<base58btc(0xed01+32B)>）".into(), None);
    };
    let Some(mb) = tail.strip_prefix('z') else {
        // legacy（尾段裸 base58）/ 其它非 multibase 形态：不支持的格式，直接拒
        return (false, "不支持的 did 格式（orgDid 尾段须为 z multibase；legacy 裸 base58 已废止）".into(), None);
    };
    let pk: Vec<u8> = {
        let payload = match bs58::decode(mb).into_vec() {
            Ok(p) => p,
            Err(_) =>{ return (false, "不支持的 did 格式（orgDid multibase 解码失败）".into(), None); }
        };
        if payload.len() != 34 || payload[0] != 0xed || payload[1] != 0x01 {
            return (false, "不支持的 did 格式（orgDid multibase 载荷非法：须 34B 且 0xed01 头）".into(), None);
        }
        payload[2..].to_vec()
    };
    let Ok(pk32): Result<[u8; 32], _> = pk.as_slice().try_into() else {
        return (false, "orgDid 解码后非 32B 公钥".into(), None);
    };
    let Ok(sig) = b64d(&claims.sig_b64) else {
        return (false, "sigB64 解码失败".into(), None);
    };
    let Ok(sig64): Result<[u8; 64], _> = sig.as_slice().try_into() else {
        return (false, "签名长度异常（≠64B）".into(), None);
    };
    let vk = match ed25519_dalek::VerifyingKey::from_bytes(&pk32) {
        Ok(v) => v,
        Err(_) =>{ return (false, "公钥构造失败".into(), None); }
    };
    use ed25519_dalek::Verifier as _;
    if vk.verify(claims.msg().as_bytes(), &ed25519_dalek::Signature::from_bytes(&sig64)).is_err() {
        return (false, "签名验证失败（伪造或字段被篡改）".into(), None);
    }
    if claims.expires_at < now_ms() {
        return (false, format!("token 已过期（expiresAt={}）", claims.expires_at), None);
    }
    (true, String::new(), Some(claims))
}

// ═══ 命令实现（pub 供 cli_serve 复用；返回 Result 而非 exit——serve 侧转 HTTP 状态）═══

pub fn cmd_identity(p: &Parsed) -> Result<serde_json::Value, String> {
    match p.positional.first().map(String::as_str) {
        Some("birth") => {
            let existed = device_key_exists();
            let (did, _) = require_device();
            Ok(json!({
                "did": did, "born": !existed, "document": device_document(&did),
                "rootDid": core_id::account_did(),
                "note": "设备身份与 GUI 同钥（device.key）；账号身份请用 GUI 登录/创建",
            }))
        }
        Some("did") | None => {
            let (did, _) = require_device();
            let mut doc = device_document(&did);
            if let Some(root) = core_id::account_did() {
                doc["youling"] = json!({ "id": root, "note": "本机持有的有灵根账号（组织层身份）" });
            }
            Ok(doc)
        }
        Some("list") => Ok(json!({ "accounts": core_id::accounts_load_with_roles() })),
        Some("switch") => {
            let did = p.flags.get("did").cloned()
                .or_else(|| p.positional.get(1).cloned())
                .ok_or("用法: identity switch --did <accountDid>")?;
            // 与 GUI 账号抽屉同一实现：主设备种子槽或成员委任状任一有效才允许切换。
            core_id::account_switch(did)
        }
        Some("export-seed") => {
            let seed = block_on(core_id::account_export_seed())?;
            Ok(json!({ "seedB64": seed, "note": "根种子仅此一次明文输出——离线保管，勿入聊天/仓库" }))
        }
        Some(other) => Err(format!("未知子命令 identity {other}（可用: birth/did/list/switch/export-seed）")),
    }
}

pub fn cmd_sign(p: &Parsed) -> Result<serde_json::Value, String> {
    let payload_b64 = p.positional.first().ok_or("用法: sign <payload-b64> [--as root|device]")?;
    let payload = b64d(payload_b64)?;
    let as_mode = p.flags.get("as").cloned().unwrap_or_else(|| "auto".into());
    let (did, seed, signer) = match as_mode.as_str() {
        "root" => { let (d, s) = require_root(); (d, s, "root") }
        "device" => { let (d, s) = require_device(); (d, s, "device") }
        "auto" => {
            // phone/A2 同语义：组织（根）钥优先；分身设备回退设备钥并标注 signer
            match (core_id::account_did(), core_id::cached_account_seed()) {
                (Some(d), Some(s)) => (d, s, "root"),
                _ => { let (d, s) = require_device(); (d, s, "device") }
            }
        }
        other => return Err(format!("--as 只认 root/device/auto，收到 {other:?}")),
    };
    let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
    let sig = b64e(&signing.sign(&payload).to_bytes());
    Ok(json!({ "signature": sig, "did": did, "algo": "ed25519", "signer": signer }))
}

pub fn cmd_device(p: &Parsed) -> Result<serde_json::Value, String> {
    match p.positional.first().map(String::as_str) {
        Some("register") => cmd_device_register(p),
        Some("list") | None => {
            let ov = block_on(core_id::account_list_devices())?;
            Ok(json!({ "name": ov.name, "backedUp": ov.backed_up, "devices": ov.devices,
                       "note": "云名册（identity-svc /presence/by-root）" }))
        }
        Some("revoke") => {
            let arg = p.positional.get(1).ok_or("用法: device revoke <did|pubkeyB64>")?;
            device_revoke_impl(arg)
        }
        Some("token") => cmd_device_token(p),
        Some("verify-token") => {
            let t = p.positional.get(1).ok_or("用法: device verify-token <token-b64>")?;
            let (valid, reason, claims) = verify_grant(t);
            Ok(if valid { json!({ "valid": true, "claims": claims }) } else { json!({ "valid": false, "reason": reason }) })
        }
        // ── 成员设备生命周期（2026-11-03 CLI 补齐；与 UI「我的设备」同实现）──
        Some("add") => cmd_device_add(p),
        Some("enroll") => cmd_device_enroll(p),
        Some("invite") => cmd_device_invite(),
        Some("pair") => cmd_device_pair(p),
        Some("authorized") => cmd_device_authorized(p),
        Some("trusted") => cmd_device_trusted(p),
        Some("scopes") => cmd_device_scopes(p),
        Some("allow") => cmd_device_allow_deny(p, true),
        Some("deny") => cmd_device_allow_deny(p, false),
        Some("origin-revoke") => cmd_device_origin_revoke(p),
        Some("group") => cmd_device_group(),
        // ── 显示名（2026-11-03）：标签用途，DID/授权不变 ──
        Some("rename") => cmd_device_rename(p),
        Some(other) => Err(format!(
            "未知子命令 device {other}（可用: register/list/revoke/token/verify-token/add/enroll/invite/pair/authorized/trusted/scopes/allow/deny/origin-revoke/group/rename）"
        )),
    }
}

/// 本机设备改名（2026-11-03）：写 config 覆盖文件 device-name.txt。
/// 显示名只是**标签**（信封署名/卡面 sourceDeviceName/URL 路径标签）——
/// 不改 DID、不影响授权/已发卡，新署名即时生效（读路径每次现读）。
pub fn cmd_device_rename(p: &Parsed) -> Result<serde_json::Value, String> {
    let name = p.flags.get("name").map(String::as_str).unwrap_or("");
    if name.is_empty() {
        return Err("用法: device rename --name <新设备名>（≤32 字符，中文可用；显示名只是标签，DID/授权不变）".into());
    }
    let stored = core_id::set_device_display_name(name)?;
    let did = core_id::device_identity().map(|(d, _)| d).unwrap_or_default();
    Ok(json!({
        "ok": true,
        "name": stored,
        "deviceDid": did,
        "note": "显示名已更新（署名/卡面/地址标签即时生效）；DID 与授权不变",
    }))
}

/// attest 上云（第68轮归一协议；identity_service::add_device_by_did 同款底层）+ 顺签委任状。
pub fn cmd_device_register(p: &Parsed) -> Result<serde_json::Value, String> {
    let device_did = p.flags.get("did").ok_or("用法: device register --did <deviceDid> [--name N] [--no-delegation]")?;
    let pubkey_b64 = core_id::device_pubkey_from_did_or_b64(device_did)?;
    let name = p.flags.get("name").cloned().unwrap_or_else(|| "cli-device".into());
    let (root_did, seed) = require_root();
    // attest 签名（msg 三行式，第68轮归一）
    let issued_at = now_ms();
    let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
    let attest_msg = format!("attest\n{root_did}\n{pubkey_b64}\n{issued_at}");
    let attest_sig = b64e(&signing.sign(attest_msg.as_bytes()).to_bytes());
    // 上云（blocking client——CLI 单线程场景，home 已启用 reqwest blocking feature）
    let http = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build().map_err(|e| e.to_string())?;
    let resp = http.post(format!("{}/root/device/add", base_url()))
        .json(&json!({
            "rootDid": root_did, "pubkeyB64": pubkey_b64, "name": name,
            "issuedAt": issued_at, "attestSigB64": attest_sig,
        }))
        .send().map_err(|e| format!("attest 请求失败: {e}"))?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("attest status={status} body={}", serde_json::to_string(&body).unwrap_or_default()));
    }
    // 顺签委任状（--no-delegation 跳过；失败不挡注册——phone 同款）
    let mut delegation_issued = false;
    if p.flags.get("no-delegation").is_none() {
        let dels = core_deleg::Delegations::load();
        if dels.issue_for(&seed, &root_did, &pubkey_b64, &name, scopes_csv(None)).is_ok() {
            delegation_issued = true;
        }
    }
    Ok(json!({
        "device": { "did": device_did, "name": name, "pubkeyB64": pubkey_b64 },
        "attest": body,
        "delegationIssued": delegation_issued,
    }))
}

fn cmd_device_token(p: &Parsed) -> Result<serde_json::Value, String> {
    let device_did = p.flags.get("did").ok_or("用法: device token --did <deviceDid> [--scopes a,b] [--ttl-secs 3600]")?;
    if !device_did.starts_with("did:") {
        return Err("设备 did 应为 did:<method>: 前缀".into());
    }
    let scopes = scopes_csv(p.flags.get("scopes")).unwrap_or_default();
    let ttl: u64 = p.flags.get("ttl-secs").and_then(|s| s.parse().ok()).unwrap_or(3600);
    let (root_did, seed) = require_root();
    let now = now_ms();
    let claims = GrantClaims {
        org_did: root_did, device_did: device_did.clone(), scopes,
        issued_at: now, expires_at: now + ttl * 1000, sig_b64: String::new(),
    };
    let token = issue_grant(&claims, &seed);
    Ok(json!({
        "token": token,
        "verifyHint": "验证方: 设备节点或平台按 orgDid 裸公钥离线验签（device verify-token / phone 同构）",
    }))
}

/// 云除名（identity_service::device_revoke 同款底层）。
pub fn device_revoke_impl(pubkey_or_did: &str) -> Result<serde_json::Value, String> {
    let pubkey_b64 = core_id::device_pubkey_from_did_or_b64(pubkey_or_did)?;
    let (root_did, seed) = require_root();
    let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
    let msg = format!("revoke\n{root_did}\n{pubkey_b64}");
    let sig = b64e(&signing.sign(msg.as_bytes()).to_bytes());
    let http = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build().map_err(|e| e.to_string())?;
    let r = http.post(format!("{}/root/device/revoke", base_url()))
        .json(&json!({ "rootDid": root_did, "pubkeyB64": pubkey_b64, "rootSig": sig }))
        .send()
        .map_err(|e| format!("revoke 请求失败: {e}"))?;
    let status = r.status();
    let body: serde_json::Value = r.json().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("revoke status={status} body={}", serde_json::to_string(&body).unwrap_or_default()));
    }
    Ok(body)
}

pub fn cmd_delegation(p: &Parsed) -> Result<serde_json::Value, String> {
    match p.positional.first().map(String::as_str) {
        Some("issue") => {
            let device_did = p.flags.get("did").ok_or("用法: delegation issue --did <deviceDid|pubkeyB64> [--name N] [--scopes a,b]")?;
            let pubkey_b64 = core_id::device_pubkey_from_did_or_b64(device_did)?;
            let name = p.flags.get("name").cloned().unwrap_or_else(|| "device".into());
            let (root_did, seed) = require_root();
            let dels = core_deleg::Delegations::load();
            let d = dels.issue_for(&seed, &root_did, &pubkey_b64, &name, scopes_csv(p.flags.get("scopes")))?;
            let wire = core_deleg::encode_present(&d);
            Ok(json!({ "delegation": d, "wire": wire }))
        }
        Some("verify") => {
            let wire = p.positional.get(1).ok_or("用法: delegation verify <wire-b64>")?;
            match core_deleg::decode_present(wire) {
                Some(d) => match core_deleg::verify(&d) {
                    Ok(remaining_ms) => Ok(json!({ "valid": true, "remainingMs": remaining_ms, "delegation": d })),
                    Err(e) => Ok(json!({ "valid": false, "reason": e })),
                },
                None => Ok(json!({ "valid": false, "reason": "wire 结构不符（base64/json 解不开）" })),
            }
        }
        Some("list") | None => Ok(json!({ "delegations": core_deleg::Delegations::load().list() })),
        Some("revoke") => {
            let arg = p.positional.get(1).ok_or("用法: delegation revoke <did|pubkeyB64>")?;
            let pubkey_b64 = core_id::device_pubkey_from_did_or_b64(arg)?;
            let dels = std::sync::Arc::new(core_deleg::Delegations::load());
            if !dels.revoke(&pubkey_b64) {
                return Err("本机无该设备的委任状".into());
            }
            core_deleg::push_revocations_best_effort(&dels); // 云端注册表传播（尽力而为）
            Ok(json!({ "revoked": pubkey_b64, "pushed": "best-effort" }))
        }
        Some(other) => Err(format!("未知子命令 delegation {other}（可用: issue/verify/list/revoke）")),
    }
}

/// attest 离线签名（不上云；device register 上云走同一消息格式）。
pub fn cmd_attest(p: &Parsed) -> Result<serde_json::Value, String> {
    let device_did = p.flags.get("did").ok_or("用法: attest --did <deviceDid>")?;
    let pubkey_b64 = core_id::device_pubkey_from_did_or_b64(device_did)?;
    let (root_did, seed) = require_root();
    let issued_at = now_ms();
    let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
    let msg = format!("attest\n{root_did}\n{pubkey_b64}\n{issued_at}");
    let sig = b64e(&signing.sign(msg.as_bytes()).to_bytes());
    Ok(json!({
        "msg": msg, "sigB64": sig, "issuedAt": issued_at,
        "rootDid": root_did, "pubkeyB64": pubkey_b64,
        "note": "离线 attest 签名——device register 上云用同一消息格式（第68轮归一协议）",
    }))
}

pub fn cmd_status() -> Result<serde_json::Value, String> {
    let (device_did, _) = require_device();
    let account = block_on(core_id::account_get())?;
    let delegations = core_deleg::Delegations::load().list().len();
    Ok(json!({
        "deviceDid": device_did,
        "rootDid": account["rootDid"],
        "role": account["role"],
        "accounts": core_id::accounts_load_with_roles().len(),
        "delegations": delegations,
        "configDir": myco_core::config::config_dir().display().to_string(),
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

// ═══════════════════════════════════════════════════════════════════════
// friend —— 好友档案三件套（2026-10-12「UI 有的感知/状态/动作 CLI 都要有」第一批）
//
// 与 share 组的"薄 HTTP 糖"不同，friend 直接落档案：好友档案=本地权威
// （friends.json，2026-10-07 去服务端化），没有运行中网关的内存态要绕，
// UI 读写的就是同一份文件——CLI 直写不会造成进程不一致。
// 语义边界（诚实声明印在回包里）：`add` 是**管理员直写**（status=ok，即签名
// 握手完成态），不向对端投递 friend-request；正常加好友走 UI 的握手链。
//
// 变体：整段依赖 chat_service（随 GUI 变体编译）⇒ CLI/headless 构建返回明确错误。
// ═══════════════════════════════════════════════════════════════════════
#[cfg(feature = "gui")]
pub fn cmd_friend(p: &Parsed) -> Result<serde_json::Value, String> {
    match p.positional.first().map(String::as_str) {
        Some("list") | None => {
            let friends = crate::chat_service::friends_snapshot();
            Ok(json!({
                "count": friends.len(),
                "friends": friends,
                "note": "本地档案（friends.json 即权威）；只读，零网络"
            }))
        }
        Some("add") => {
            let did = p.flags.get("did").ok_or("用法: friend add --did <账号did> --name <名>")?;
            let name = p.flags.get("name").ok_or("用法: friend add --did <账号did> --name <名>")?;
            crate::chat_service::friend_add_admin(did, name)
        }
        Some("remove") => {
            let did = p.flags.get("did").ok_or("用法: friend remove --did <账号did>")?;
            crate::chat_service::friend_remove(did)
        }
        Some(other) => Err(format!("未知子命令 friend {other}（可用: list/add/remove）")),
    }
}

/// CLI/headless 变体：好友档案读写走 chat_service（GUI 侧）⇒ 明确报错而非静默。
#[cfg(not(feature = "gui"))]
pub fn cmd_friend(_p: &Parsed) -> Result<serde_json::Value, String> {
    Err("friend 子命令仅 GUI 构建可用（好友/聊天服务随 GUI 变体编译）".into())
}

// ═══════════════════════════════════════════════════════════════════════
// chat —— 聊天三件套（2026-10-12「UI 有的感知/状态/动作 CLI 都要有」第二批）
//
// 与 friend 组同层：直接调 chat_service 的 pub 函数（与 UI 完全同一实现——
// 不是协议重造）。发送走 p2p_send_raw（P2P 直推 → 信箱兜底），CLI 一次性进程
// 只做发起方；对方在线即直推、离线走信箱，与 UI 行为一致。
//
// 变体：整段依赖 chat_service（随 GUI 变体编译）⇒ CLI/headless 构建返回明确错误。
// ═══════════════════════════════════════════════════════════════════════
#[cfg(feature = "gui")]
/// CLI 发送收尾（2026-10-20）：等真实投递结果（≤3s）并合并到输出——
/// accepted 不再是唯一信息，调用方能区分「已送达 / 入待发队列 / 后台未确认」。
fn with_delivery_result(mut r: serde_json::Value) -> serde_json::Value {
    const CLI_WAIT_MS: u64 = 5000;
    let msg = r.get("msgId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let conv = r.get("convId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if msg.is_empty() || conv.is_empty() {
        return r;
    }
    let d = block_on(crate::chat_service::chat_wait_send_result(conv, msg, CLI_WAIT_MS));
    if let Some(o) = r.as_object_mut() {
        o.insert("delivery".into(), d);
    }
    r
}

#[cfg(feature = "gui")]
pub fn cmd_chat(p: &Parsed) -> Result<serde_json::Value, String> {
    match p.positional.first().map(String::as_str) {
        Some("send") => {
            let to = p.flags.get("to").ok_or("用法: chat send --to <对方账号did> --text <内容>")?;
            let text = p.flags.get("text").ok_or("用法: chat send --to <对方账号did> --text <内容>")?;
            let r = block_on(crate::chat_service::chat_send(
                to.clone(), "text".into(), json!({ "text": text }),
            ))?;
            Ok(with_delivery_result(r))
        }
        Some("group") => {
            let gid = p.flags.get("group").ok_or("用法: chat group --group <群id> --text <内容>")?;
            let text = p.flags.get("text").ok_or("用法: chat group --group <群id> --text <内容>")?;
            let r = block_on(crate::chat_service::chat_send_group(
                gid.clone(), json!({ "text": text }),
            ))?;
            Ok(with_delivery_result(r))
        }
        Some("conv") => {
            let id = p.positional.get(1).ok_or("用法: chat conv <会话id>（会话id 从 chat state 拿）")?;
            block_on(crate::chat_service::chat_load_conv(id.clone()))
        }
        // 2026-10-12 群三件（④）：感知/建群/拉人——建群走 task_group_ensure
        // （创建者=群主+系统条+扇出，与任务群同一实现），拉人直调群治理命令。
        Some("groups") => {
            let groups = crate::chat_service::groups_snapshot();
            Ok(json!({
                "count": groups.len(),
                "groups": groups.iter().map(|g| json!({
                    "id": g.get("id"), "name": g.get("name"),
                    "owner": g.get("owner"),
                    "members": g.get("members").and_then(|m| m.as_array()).map(|a| a.len()),
                })).collect::<Vec<_>>(),
            }))
        }
        Some("group-create") => {
            let name = p.flags.get("name").ok_or("用法: chat group-create --name <群名> [--members did1,did2]")?;
            let members: Vec<String> = p.flags.get("members").map(|m| m.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()).unwrap_or_default();
            let gid = block_on(crate::chat_service::task_group_ensure(None, name, members))?;
            Ok(json!({ "ok": true, "groupId": gid, "note": "创建者=群主；群消息待成员上线/对账补齐" }))
        }
        Some("group-invite") => {
            let gid = p.flags.get("group").ok_or("用法: chat group-invite --group <群id> --members did1,did2")?;
            let members: Vec<String> = p.flags.get("members").map(|m| m.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()).unwrap_or_default();
            block_on(crate::chat_service::chat_group_invite(gid.clone(), members))
        }
        Some("state") | None => block_on(crate::chat_service::chat_state()),
        Some(other) => Err(format!("未知子命令 chat {other}（可用: send/group/conv/state/groups/group-create/group-invite）")),
    }
}

/// CLI/headless 变体：聊天收发走 chat_service（GUI 侧）⇒ 明确报错而非静默。
#[cfg(not(feature = "gui"))]
pub fn cmd_chat(_p: &Parsed) -> Result<serde_json::Value, String> {
    Err("chat 子命令仅 GUI 构建可用（好友/聊天服务随 GUI 变体编译）".into())
}

// ═══════════════════════════════════════════════════════════════════════
// session —— DSH 会话通讯（2026-10-13「agent 间通讯」：给 DSH 会话投消息）
//
// 与 friend/chat 同层的设计原则：CLI 只是命令面——会话清单/直投/网关投递的
// wire 细节（0.2 信封、arg_key 的 _request/request 之别、mint cookie、取票+
// 隧道）全在 dsh_share.rs 的 CLI bridge，那里是这些知识的权威所在地。
// 三条命令：
//   · list            本机会话清单（会话名 + sessionID；与 UI 分享面板同一条加工链）
//   · send --to       本机直投：prompt 注入本机 DSH 的某个会话（对方 AI 立即处理）
//   · send --task     经分享网关投递（本机任务卡捷径 / 隧道到源设备网关）
// 所有消息自动带发送方身份前缀 `[<会话名>]: `——会话名取 $DSH_SESSION_ID 对应
// 会话，查不到用 id 尾 8 位；无环境变量则 `[myco]`。
// ═══════════════════════════════════════════════════════════════════════
// p2p 段——隧道诊断/测试钩子（T8 断线恢复验收用）
// ═══════════════════════════════════════════════════════════════════════
pub fn cmd_p2p(p: &Parsed) -> Result<serde_json::Value, String> {
    match p.positional.first().map(String::as_str) {
        Some("tunnel") => match p.positional.get(1).map(String::as_str) {
            Some("drop") => {
                let did = p.flags.get("did").ok_or("用法: p2p tunnel drop --did <设备did>")?;
                #[cfg(feature = "gui")]
                {
                    block_on(crate::p2p_client::debug_tunnel_drop(did))
                        .map(|msg| json!({ "ok": true, "msg": msg }))
                }
                #[cfg(not(feature = "gui"))]
                Err("p2p tunnel drop 仅 GUI 构建可用（CLI/headless 无隧道池）".into())
            }
            _ => Err("用法: p2p tunnel drop --did <设备did>".into()),
        },
        _ => Err("用法: p2p tunnel drop --did <设备did>（强杀指定设备的持久隧道，验证断线恢复）".into()),
    }
}

pub fn cmd_session(p: &Parsed) -> Result<ShareReply, String> {
    match p.positional.first().map(String::as_str) {
        Some("list") | None => session_list(p),
        Some("send") => session_send(p),
        Some("whoami") => {
            let explicit = p
                .flags
                .get("session-id")
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let sessions = block_on(crate::dsh_share::cli_local_sessions())
                .map(|v| v["sessions"].as_array().cloned().unwrap_or_default())
                .unwrap_or_default();
            // 2026-10-19：whoami 也走同一刷新路径（fork 会话不在呈现清单里 → 未解析）。
            // 显式 sessionId 优先，其次 env DSH_SESSION_ID（与 session_whoami 内部规则一致）。
            let sid_for_refresh = explicit
                .clone()
                .or_else(|| std::env::var("DSH_SESSION_ID").ok().filter(|s| !s.trim().is_empty()));
            let sessions = sessions_with_refresh_for_sid(sessions, sid_for_refresh.as_deref());
            session_whoami(&sessions, explicit.as_deref())
        }
        Some(other) => Err(format!("未知子命令 session {other}（可用: list/send/whoami）")),
    }
}

/// `session list [--json]`：本机 DSH 会话清单（人话表 + JSON 同一份数据）。
fn session_list(_p: &Parsed) -> Result<ShareReply, String> {
    let v = block_on(crate::dsh_share::cli_local_sessions())?;
    let human = session_list_human(&v);
    Ok(ShareReply { json: v, human })
}

/// `session list` 的人话表（纯函数，单测覆盖）：名字 + sessionID，最近在前。
fn session_list_human(v: &serde_json::Value) -> String {
    let sessions = v["sessions"].as_array().cloned().unwrap_or_default();
    if sessions.is_empty() {
        return "本机没有可见会话（打开 DSH 桌面版后这里会出清单）\n".into();
    }
    let mut out = format!("会话 {} 条（最近在前）\n\n", sessions.len());
    for s in &sessions {
        let name = s["name"].as_str().unwrap_or("?");
        let sid = s["sessionId"].as_str().unwrap_or("?");
        out.push_str(&format!("  {name:<32} {sid}\n"));
    }
    out.push_str("\n投递: myco cli session send --to <名字或sessionID> --text <内容>\n");
    out
}

/// 发送方身份（纯函数，单测覆盖）：$DSH_SESSION_ID → 清单里对应会话的名字；
/// 查不到用 id 尾 8 位；无环境变量 → "myco"。前缀 `[<名>]: ` 在调用侧拼。
/// id 匹配同时认裸 uuid 与 `session-<uuid>`（实测：环境变量给裸 uuid，
/// session/list 回 `session-` 前缀形态——同一会话两种写法）。
///
/// 2026-10-15 语义名加固（用户真案：收到 `[from: 533e48a1·x7oj]` 完全看不出是谁——
/// 会话名承载功能职责信息，人和 AI 都靠它理解上下文）：
/// · 清单查不到时**回退到会话文件目录直查**（读 session 文件第一行的标题行）；
/// · 仍查不到 → 用 id 尾 8（可能是新会话未索引，或 DSH 401 导致清单拉空）。
fn session_sender_name(env_sid: Option<&str>, sessions: &[serde_json::Value]) -> String {
    session_sender_name_ex(env_sid, sessions, None)
}

/// 带会话文件目录直查的完整版（`sessions_dir` = None 跳过直查，纯函数单测用）。
fn session_sender_name_ex(
    env_sid: Option<&str>,
    sessions: &[serde_json::Value],
    sessions_dir: Option<&std::path::Path>,
) -> String {
    match env_sid.map(str::trim).filter(|s| !s.is_empty()) {
        None => "myco".into(),
        Some(id) => {
            let prefixed = format!("session-{id}");
            // ① DSH session/list API 的清单
            if let Some(name) = sessions
                .iter()
                .find(|s| {
                    s["sessionId"].as_str() == Some(id) || s["sessionId"].as_str() == Some(prefixed.as_str())
                })
                .and_then(|s| s["name"].as_str().map(|n| n.trim().to_string()))
                .filter(|n| !n.is_empty())
            {
                return name;
            }
            // ② 会话文件目录直查（清单可能因 401 拉空/新会话未索引，文件是真相之源）：
            //    读 <dir>/<session-id>.jsonl 的第一行 JSON 的 name 字段
            if let Some(dir) = sessions_dir {
                for fname in [format!("{id}.jsonl"), format!("session-{id}.jsonl")] {
                    let p = dir.join(&fname);
                    if let Ok(txt) = std::fs::read_to_string(&p) {
                        if let Some(first_line) = txt.lines().next() {
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(first_line) {
                                if let Some(name) = v["name"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
                                    return name;
                                }
                            }
                        }
                    }
                }
            }
            // ③ 都查不到 → id 尾 8
            tail_chars(id, 8)
        }
    }
}

/// 尾 n 个字符（不足 n 原样；按字符算，中文/UUID 通用）。
pub(crate) fn tail_chars(s: &str, n: usize) -> String {
    let c: Vec<char> = s.chars().collect();
    c[c.len().saturating_sub(n)..].iter().collect()
}

/// 调用方误写头部时自动剥掉（真案：did 会话手写 `[from: myco]` → 双层头部）。
/// 只认"第一行以 `[from:` 开头且以 `]` 结尾 + 第二行是 `---`"这一种形态；其余原样。
/// 剥掉用户手写的 `[from: ...]` + `---` 头（防双层头部/伪造署名）。
/// share 网关的 /view/say 与跨会话投递复用同一份规则。
pub(crate) fn strip_handwritten_header(text: &str) -> String {
    let t = text.trim_start_matches(['\n', '\r', ' ', '\t']);
    let Some(rest) = t.strip_prefix("[from:") else { return text.to_string() };
    let Some(nl) = rest.find('\n') else { return text.to_string() };
    let (head, tail) = rest.split_at(nl);
    if !head.trim_end().ends_with(']') {
        return text.to_string();
    }
    let after = tail.trim_start_matches(['\n', '\r']);
    match after.strip_prefix("---") {
        Some(body) => body.trim_start_matches(['\n', '\r']).to_string(),
        None => text.to_string(),
    }
}

/// **身份解析（2026-10-14 v3——署名必须可验证）**：agent 编名字真案两起
/// （"基础设施"、"镜像模式重构线"——清单里根本没这两个会话，用户两次实测问题）。规则：
///   ① 显式 sessionId（= `$env:DSH_SESSION_ID`）→ 清单查名（权威）；查不到退 id 尾8（如实，不编）
///   ② 显式 from → 必须与清单里某个会话名对上（大小写不敏感）；对不上**直接拒绝**
///   ③ 只有 env（myco 自己的环境，可能继承自别的会话）→ 放行但标未验证 + 告警
///   ④ 都没有 → 拒绝（旧版静默署名 myco，对方无从识别）
/// 返回 (名字, 来源, 是否已验证)。
/// 发送方是否不在（呈现口径）会话清单里（2026-10-19 Fix「fork 会话」；纯函数，单测直击）。
/// `true` = 需要刷新完整清单再解析署名（fork 出来的新会话不在呈现清单里）。
pub(crate) fn sender_missing_from_list(
    sessions: &[serde_json::Value],
    explicit_from: Option<&str>,
    effective_sid: Option<&str>,
) -> bool {
    explicit_from
        .map(|f| {
            !sessions.iter().any(|s| {
                s["name"].as_str().map(|n| n.trim().eq_ignore_ascii_case(f)).unwrap_or(false)
            })
        })
        .unwrap_or(false)
        || effective_sid
            .map(|sid| {
                let prefixed = format!("session-{sid}");
                !sessions.iter().any(|s| {
                    let x = s["sessionId"].as_str().unwrap_or("");
                    x == sid || x == prefixed.as_str()
                })
            })
            .unwrap_or(false)
}
/// 合并会话清单（2026-10-19 Fix「fork 会话」；纯函数，单测直击）：
/// 过滤清单（呈现口径）在前，完整清单里**只在完整清单出现**的会话追加（fork 会话
/// 就在这一类）。按 sessionId 去重，保持原顺序。
fn merge_session_lists(
    filtered: &[serde_json::Value],
    full: &[serde_json::Value],
) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = filtered.to_vec();
    for s in full {
        let sid = s["sessionId"].as_str().unwrap_or("");
        if sid.is_empty() {
            continue;
        }
        if !out.iter().any(|x| x["sessionId"].as_str() == Some(sid)) {
            out.push(s.clone());
        }
    }
    out
}
/// `--from <名字>` → 该名字对应的 sessionId（给 from 的 id 尾 / reply-to 用）。
///
/// 2026-10-19（同名歧义护栏）：真案「申诉管理」在本机清单里有**两条同名记录**——
/// 只取第一个会把 reply-to 指到**同名的另一个会话**，于是"回复给谁"就错了（比署名丑
/// 严重得多：消息会进错会话）。规则：
///   · 唯一命中 → 用它；
///   · 多个同名 → **只在其中一个就是 env/explicit 的 sessionId 时才采信**；
///   · 否则返回 None（宁可不给 id 尾，也不猜一个错的 reciprocity 目标），由调用方提示。
fn from_sid_for_label(
    sessions: &[serde_json::Value],
    from_name: &str,
    effective_sid: Option<&str>,
) -> Option<String> {
    let target = from_name.trim();
    if target.is_empty() {
        return None;
    }
    let hits: Vec<&str> = sessions
        .iter()
        .filter(|s| {
            s["name"]
                .as_str()
                .map(|n| n.trim().eq_ignore_ascii_case(target))
                .unwrap_or(false)
        })
        .filter_map(|s| s["sessionId"].as_str())
        .collect();
    match hits.len() {
        0 => None,
        1 => Some(hits[0].to_string()),
        _ => {
            let want = effective_sid.map(|s| s.trim().trim_start_matches("session-"));
            if let Some(want) = want {
                if let Some(h) = hits
                    .iter()
                    .find(|h| h.trim_start_matches("session-") == want)
                {
                    return Some(h.to_string());
                }
            }
            eprintln!(
                "[session-name] 署名 \"{target}\" 有 {} 个同名会话（{}）——不猜 reply-to，\
                 建议改传 sessionId 消歧",
                hits.len(),
                hits.join(" / ")
            );
            None
        }
    }
}

fn resolve_sender(
    sessions: &[serde_json::Value],
    explicit_from: Option<&str>,
    explicit_sid: Option<&str>,
    env_sid: Option<&str>,
) -> Result<(String, &'static str, bool), String> {
    let name_in_list = |n: &str| {
        sessions.iter().any(|s| {
            s["name"].as_str().map(|x| x.trim().eq_ignore_ascii_case(n)).unwrap_or(false)
        })
    };
    let sid_known = |id: &str| {
        let prefixed = format!("session-{id}");
        sessions.iter().any(|s| {
            let sid = s["sessionId"].as_str().unwrap_or("");
            sid == id || sid == prefixed.as_str()
        })
    };
    if let Some(id) = explicit_sid.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok((session_sender_name(Some(id), sessions), "sessionId", sid_known(id)));
    }
    if let Some(f) = explicit_from.map(str::trim).filter(|s| !s.is_empty()) {
        // 清单不可用（DSH 没在跑）→ 无法校验：放行但标未验证（不挡跨设备投递）
        if sessions.is_empty() {
            return Ok((f.to_string(), "from", false));
        }
        if name_in_list(f) {
            return Ok((f.to_string(), "from", true));
        }
        return Err(format!(
            "署名 \"{f}\" 不在本机会话清单里——myco 拒绝用不存在的会话名署名（真案：\"基础设施\"/\"镜像模式重构线\" 都是编的，用户两次实测问题）。\
             请改用 --session-id $env:DSH_SESSION_ID（API 用 \"sessionId\" 字段）让 myco 自动解析你的名字；\
             或先跑 session list 看你自己的名字。"
        ));
    }
    if let Some(id) = env_sid.map(str::trim).filter(|s| !s.is_empty()) {
        // myco 自己的环境变量——可能继承自别的会话（真案：供题器运维署名落到 DSH协议应用）
        return Ok((session_sender_name(Some(id), sessions), "env", false));
    }
    Err("缺身份——请带 --session-id $env:DSH_SESSION_ID（推荐：myco 自动解析名字）或 --from <你的会话名>".into())
}

/// `--to` 目标解析（纯函数，单测覆盖）。匹配链（前面的优先）：
/// sessionId 精确 → 会话名精确（不区分大小写）→ 会话名唯一子串 → sessionId 唯一前缀。
/// 歧义/落空都 Err 人话并附候选——绝不静默挑一个。
fn session_resolve_target(
    sessions: &[serde_json::Value],
    to: &str,
) -> Result<(String, String), String> {
    if sessions.is_empty() {
        return Err("本机会话清单为空——先确认 DSH 桌面版在运行（myco cli session list）".into());
    }
    let get = |s: &serde_json::Value| {
        (
            s["sessionId"].as_str().unwrap_or_default().to_string(),
            s["name"].as_str().unwrap_or_default().to_string(),
        )
    };
    // ① sessionId 精确
    if let Some(s) = sessions.iter().find(|s| s["sessionId"].as_str() == Some(to)) {
        return Ok(get(s));
    }
    let lt = to.to_lowercase();
    let name_hit = |s: &serde_json::Value| {
        s["name"].as_str().map(|n| n.to_lowercase().contains(&lt)).unwrap_or(false)
    };
    // ② 会话名精确（不区分大小写）
    let exact: Vec<_> = sessions
        .iter()
        .filter(|s| s["name"].as_str().map(|n| n.to_lowercase() == lt).unwrap_or(false))
        .collect();
    if exact.len() == 1 {
        return Ok(get(exact[0]));
    }
    if exact.len() > 1 {
        let cands: Vec<String> = exact.iter().map(|s| get(s).0).collect();
        return Err(format!("\"{to}\" 同名会话有 {} 个（{:?}）——用 sessionId 精确指定", exact.len(), cands));
    }
    // ③ 会话名唯一子串
    let subs: Vec<_> = sessions.iter().filter(|s| name_hit(s)).collect();
    if subs.len() == 1 {
        return Ok(get(subs[0]));
    }
    if subs.len() > 1 {
        let names: Vec<String> = subs.iter().map(|s| get(s).1).take(5).collect();
        return Err(format!("\"{to}\" 匹配到 {} 个会话（{:?}）——用更长的名字或 sessionId", subs.len(), names));
    }
    // ④ sessionId 唯一前缀
    let pref: Vec<_> = sessions.iter().filter(|s| s["sessionId"].as_str().map(|x| x.starts_with(to)).unwrap_or(false)).collect();
    if pref.len() == 1 {
        return Ok(get(pref[0]));
    }
    if pref.len() > 1 {
        let cands: Vec<String> = pref.iter().map(|s| get(s).0).collect();
        return Err(format!("sessionID 前缀 \"{to}\" 匹配到 {} 个会话（{:?}）——多给几位", pref.len(), cands));
    }
    Err(format!("没有叫 \"{to}\" 的会话——myco cli session list 看清单"))
}

/// `session whoami`：返回当前会话的身份（名字 + sessionId + 设备尾4）。
/// 解决"agent 不知道自己叫什么"——发送前先 whoami，填 from/sessionId 用。
///
/// 2026-10-14 修（署名退化真案）：**myco 是独立进程，正常启动（双击/自启/计划任务）
/// 拿不到 DSH 会话环境**，靠 myco 自己的 `DSH_SESSION_ID` 必然退化成 "myco"（did 会话
/// 回信署名 myco·x7oj 即此因）。故支持调用方显式传 sessionId——agent 的 shell 里有
/// `$env:DSH_SESSION_ID`，交给 myco 统一查名。
fn session_whoami(
    sessions: &[serde_json::Value],
    explicit_sid: Option<&str>,
) -> Result<ShareReply, String> {
    let sid_src = explicit_sid
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("DSH_SESSION_ID").ok().filter(|s| !s.trim().is_empty()));
    let device_did = core_id::device_identity().map(|(d, _)| d).unwrap_or_default();
    let tail4 = if device_did.len() >= 4 { tail_chars(&device_did, 4) } else { String::new() };
    let (name, sid, resolved) = match &sid_src {
        Some(id) => {
            let full = if id.starts_with("session-") { id.clone() } else { format!("session-{id}") };
            let found = sessions.iter().any(|s| {
                s["sessionId"].as_str() == Some(full.as_str())
                    || s["sessionId"].as_str() == Some(id.as_str())
            });
            (session_sender_name(Some(id), sessions), full, found)
        }
        None => ("myco".into(), String::new(), false),
    };
    let label = if tail4.is_empty() { name.clone() } else { format!("{name}·{tail4}") };
    let mut human = format!(
        "你是：{label}\n  会话名  {name}\n  sessionId {sid}\n  设备    ·{tail4}\n  发消息时 from 用：{name}"
    );
    if !resolved {
        human.push_str(
            "\n⚠️ 身份未解析（没拿到你的 sessionId，或它不在会话清单里）——请显式传入：\
             {\"action\":\"session_whoami\",\"sessionId\":\"$env:DSH_SESSION_ID\"}\
             （PowerShell 里 $env:DSH_SESSION_ID 就是你自己的会话 id）",
        );
    }
    Ok(ShareReply {
        json: json!({ "name": name, "sessionId": sid, "deviceTail4": tail4, "label": label, "resolved": resolved }),
        human,
    })
}

/// 会话清单按需补全（whoami 等）：sid 不在清单里 → 实时拉完整清单（含 fork/子代理，
/// 5 分钟 TTL）合并；刷新失败保持原清单（降级不报错，谁调用谁决定提示）。
fn sessions_with_refresh_for_sid(
    sessions: Vec<serde_json::Value>,
    sid: Option<&str>,
) -> Vec<serde_json::Value> {
    let missing = sid
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|sid| {
            let prefixed = format!("session-{sid}");
            !sessions.iter().any(|s| {
                let x = s["sessionId"].as_str().unwrap_or("");
                x == sid || x == prefixed.as_str()
            })
        })
        .unwrap_or(false);
    if !missing {
        return sessions;
    }
    match block_on(crate::dsh_share::cli_sessions_for_sender()) {
        Ok(v) => {
            let full = v["sessions"].as_array().cloned().unwrap_or_default();
            merge_session_lists(&sessions, &full)
        }
        Err(_) => sessions,
    }
}
/// `session send`（--to 本机直投 / --task 经分享网关）。
/// 回信路由头（2026-10-19 Fix2：解决子代理/收件人路由混乱）。
///
/// 收件人看到 `[from: 群体智能/子代理(70f04816)·x7oj via myco · 时间]` 时不知道回给
/// 谁（子代理不可直接寻址），所以消息头加两行纯增量信息：
///   · `reply-to: <发送方 sessionId>`——普通会话可直接 `session_send to=<该id>`；
///     子代理则给出子代理自己的 sessionId（信息透明，至少可审计）。
///   · `reply-to-name: <父会话名>`——名字含 "/子代理" 时取 "/" 前部分（=父会话名，
///     收件人回给父会话即可）；普通会话取全名。

/// 署名头显示名/ID 尾（2026-10-19 Bug 修「from 串位」；纯函数，单测直击）：
/// **from 为显式署名时，头部 from 必须显示 from 本人**——不能用 env `DSH_SESSION_ID`
/// （myco 常由别的会话拉起，env 恒指向那个会话；真案：`from=申诉管理` 却显示
/// `[from: DSH协议应用]`，因为 env 指向 DSH协议应用）。sessionId/env 路径保持原样
/// （清单解析名 + sid 尾 8）。
fn sender_label_parts(
    sender_src: &str,
    sender: &str,
    resolved_name: &str,
    from_sid: Option<&str>,
    effective_sid: Option<&str>,
) -> (String, Option<String>) {
    if sender_src == "from" {
        (sender.to_string(), from_sid.map(String::from))
    } else {
        (resolved_name.to_string(), effective_sid.map(String::from))
    }
}

/// 消息头（**v6「充要」版**，2026-10-19 设计定稿：只留必要且充分的字段）。
///
/// ```
/// [from: 会话名 · 10-19 19:16]
/// reply-to: session-cd8a3c33-c0f3-4843-ade3-55fd603bf5db
/// 正文第一行……
/// ```
///
/// 砍掉的都是**可推导或重复**的（用户原话：「这个消息头太冗长啊，你不能秉持充要么」）：
///   · `reply-to-name` —— 与 from 的名字逐字相同；
///   · `(id尾8)` —— 就是 reply-to 的 sessionId 末 8 位；
///   · `·设备尾4` —— 会话 id 已定位到设备侧会话，回信不需要；
///   · `via myco` / `local via skill` —— 投递通道是实现细节，收件人不需要知道；
///   · `---` —— 两行前缀（`[from: ` / `reply-to: `）自识别，没有歧义。
///
/// 留的只有三件必要信息：**谁发的**（名字，给人看）、**回给谁**（完整 sessionId，
/// 给路由用）、**什么时候**（隔很久才读也知道时间）。
/// - 子代理：名字 = `父会话名/子代理`（是谁真的在说，必要），reply-to 给子代理自己的 id；
/// - steer 插队：`[from: 名字 · ⚡插队 · 10-19 19:16]`（被打断是必要信息）；
/// - 拿不到 sessionId（--from 无法映射且无 env）：只出 from 行，**不给 reply-to**
///   —— 宁缺勿错，绝不指向一个猜出来的会话。
fn format_chat_header(from_name: &str, sender_sid: Option<&str>, steer: bool) -> String {
    let name = from_name.trim();
    let name = if name.is_empty() { "myco" } else { name };
    let stamp = chrono::Local::now().format("%m-%d %H:%M");
    let prio = if steer { " · ⚡插队" } else { "" };
    let mut out = format!("[from: {name}{prio} · {stamp}]\n");
    if let Some(sid) = sender_sid.map(str::trim).filter(|s| !s.is_empty()) {
        let full = if sid.starts_with("session-") {
            sid.to_string()
        } else {
            format!("session-{sid}")
        };
        out.push_str(&format!("reply-to: {full}\n"));
    }
    out
}
fn session_send(p: &Parsed) -> Result<ShareReply, String> {
    let usage = "用法: session send --to <会话名|sessionID> --text <内容>  |  session send --task <sh-xxx> --text <内容>";
    let to = p.flags.get("to").map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let task = p.flags.get("task").map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if to.is_some() && task.is_some() {
        return Err("--to 与 --task 只能给一个（本机直投 / 经网关投递是两条路）".into());
    }
    if to.is_none() && task.is_none() {
        return Err(format!("缺投递目标——{usage}"));
    }
    let text = p
        .flags
        .get("text")
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("缺 --text（投递内容）——{usage}"))?;
    if text.chars().count() > 8000 {
        return Err("--text 太长（>8000 字，与网关发言上限同口径）".into());
    }
    // 发送方身份：$DSH_SESSION_ID 对应的会话名（清单 best-effort；--task 时清单只用于
    // 署名，DSH 不在跑也允许投——名字退到 id 尾 8 位）。
    let env_sid = std::env::var("DSH_SESSION_ID").ok().filter(|s| !s.trim().is_empty());
    let sessions_v = match block_on(crate::dsh_share::cli_local_sessions()) {
        Ok(v) => v,
        Err(e) => {
            if to.is_some() {
                return Err(e); // --to 的目标解析必须有清单
            }
            json!({ "sessions": [] }) // --task：不因本机 DSH 不在跑而挡远程投递
        }
    };
    let mut sessions = sessions_v["sessions"].as_array().cloned().unwrap_or_default();
    // **身份解析 v3**（详见 resolve_sender 头注释）：sessionId 权威 > from 必须可验证 >
    // env（未验证）> 拒绝。取代 v2 的"from 优先、编名字也照发"。
    let explicit_sid = p
        .flags
        .get("session-id")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let explicit_from = p
        .flags
        .get("from")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let effective_sid = explicit_sid.as_deref().or(env_sid.as_deref());
    // 2026-10-19 Fix「fork 会话」：过滤清单（呈现口径 163 条）不含 DSH fork 出来的新会话
    // （申诉管理/抽检管理…，DSH 侧有 968 条）。若发送方的 --from / --session-id / env
    // 在过滤清单里查不到 → **实时从 DSH 拉完整清单**（含 fork/子代理，5 分钟 TTL）
    // 合并后再解析署名；否则会误报「署名不在本机会话清单里」或署名退化成 ID 尾 8。
    let sender_missing = sender_missing_from_list(&sessions, explicit_from.as_deref(), effective_sid);
    if sender_missing {
        match block_on(crate::dsh_share::cli_sessions_for_sender()) {
            Ok(v) => {
                let full = v["sessions"].as_array().cloned().unwrap_or_default();
                sessions = merge_session_lists(&sessions, &full);
            }
            Err(e) => eprintln!("[session-name] 刷新完整会话清单失败（署名按未验证降级）：{e}"),
        }
    }
    // 2026-10-15 语义名加固：清单查不到时回退到会话文件目录直查（真案：收到
    // [from: 533e48a1·x7oj] 完全看不出是谁——DSH 401 可能导致清单拉空）。
    let sessions_dir = crate::dsh_share::dirs_home().parse::<std::path::PathBuf>().ok()
        .map(|h| h.join(".dsh").join("sessions"));
    let sender_for_label = session_sender_name_ex(
        effective_sid,
        &sessions,
        sessions_dir.as_deref(),
    );
    let (sender, sender_src, sender_verified) = resolve_sender(
        &sessions,
        explicit_from.as_deref(),
        explicit_sid.as_deref(),
        env_sid.as_deref(),
    )?;
    // 2026-10-17 设计定稿（a+c）：过滤清单里查不到的两类情况共用一份「全量清单（含子代理）」，
    // 按需取一次（正常发送不付这份 3~4s）：
    //   · 署名未验证（发送方是子代理/已结束会话）→ 用「父会话名/子代理」显示，不再裸 ID 尾
    //   · --to 目标不在过滤清单（多为子代理/子会话）→ 仍可寻址，投递照样由 myco 签名
    // 目的：让"发给子代理"这种场景不必再手写头 + 绕过 myco 直投（头格式混乱的根因）。
    let mut all_cache: Option<Vec<serde_json::Value>> = None;
    fn full_sessions(all: &mut Option<Vec<serde_json::Value>>) -> Vec<serde_json::Value> {
        if all.is_none() {
            *all = Some(
                block_on(crate::dsh_share::cli_all_sessions())
                    .map(|v| v["sessions"].as_array().cloned().unwrap_or_default())
                    .unwrap_or_default(),
            );
        }
        all.clone().unwrap_or_default()
    }
    let mut sender_for_label = sender_for_label;
    if !sender_verified {
        if let Some(sid) = effective_sid {
            let full_id = if sid.starts_with("session-") {
                sid.to_string()
            } else {
                format!("session-{sid}")
            };
            let all = full_sessions(&mut all_cache);
            let hit = all.iter().find(|s| {
                s["sessionId"].as_str() == Some(full_id.as_str())
                    || s["sessionId"].as_str() == Some(sid)
                    || s["sessionId"]
                        .as_str()
                        .map(|x| x.ends_with(sid))
                        .unwrap_or(false)
            });
            if let Some(n) = hit.and_then(|h| h["name"].as_str()).filter(|n| !n.is_empty()) {
                sender_for_label = n.to_string();
            }
        }
    }
    // 未验证告警（清单不可用 / 只给了 env / 清单里查不到该 sessionId）。
    let sign_warning = if sender_verified {
        None
    } else {
        Some(
            "署名未验证——清单里没找到你的会话。请带 --session-id $env:DSH_SESSION_ID\
             （API：\"sessionId\" 字段）让 myco 自动解析名字。",
        )
    };
    // 2026-10-19 设计定稿「头部要充要」→ v6（详见 format_chat_header 头注释）：
    //   [from: 名字 · MM-DD HH:MM]
    //   reply-to: session-<完整 id>
    //   正文
    // from 走显式署名时必须显示 from 本人（不能拿 env DSH_SESSION_ID——myco 常由别的
    // 会话拉起，真案 `from=申诉管理` 却显示 `[from: DSH协议应用]`）；id 尾/设备尾已砍掉。
    let from_sid_for_label: Option<String> = if explicit_sid.is_none() {
        // 同名歧义护栏：多命中且无法用 env sid 消歧 → 不给 reply-to（绝不猜错会话）
        explicit_from
            .as_deref()
            .and_then(|f| from_sid_for_label(&sessions, f, effective_sid))
    } else {
        None
    };
    let (label_name, label_sid) = sender_label_parts(
        sender_src,
        &sender,
        &sender_for_label,
        from_sid_for_label.as_deref(),
        effective_sid,
    );
    let mode_val = p.flags.get("mode").map(|s| s.as_str()).unwrap_or("queue");
    let body = strip_handwritten_header(&text);
    let prefixed = format!(
        "{}{}",
        format_chat_header(&label_name, label_sid.as_deref(), mode_val == "steer"),
        body
    );
    // ── 投递 ──
    if let Some(t) = &task {
        let mut v = block_on(crate::dsh_share::cli_prompt_via_share(t, &prefixed))?;
        v["sender"] = json!(sender);
        v["deliveredText"] = json!(prefixed);
        if let Some(w) = sign_warning {
            v["warning"] = json!(w);
        }
        let sid = v["sessionId"].as_str().unwrap_or("-").to_string();
        // route=local：本机注册表捷径（任务卡在本机且绑了会话——没走网关/隧道）；
        // route=gateway：真经了网关（本地网关或隧道到源设备），源侧会追加授权署名。
        let (via, note) = if v["route"].as_str() == Some("local") {
            ("本机任务卡（本机直投）", "对方 AI 会立即处理（prompt 已入队）")
        } else {
            ("经分享网关（隧道）", "对方 AI 会立即处理；网关侧还会追加分享授权署名")
        };
        let mut human = format!(
            "已投递（{via}）\n  任务卡      {t}\n  目标会话    {sid}\n  署名        [{sender}]\n  消息        {prefixed}\n  提示        {note}",
        );
        if let Some(w) = sign_warning {
            human.push_str(&format!("\n  ⚠️  {w}"));
        }
        return Ok(ShareReply { json: v, human });
    }
    let to_val = to.clone().unwrap_or_default();
    // 目标解析：先查过滤清单（普通会话）；落空再查**全量清单（含子代理）**——
    // 2026-10-17（a）：子代理会话原本不可寻址，逼得各会话手写头 + 直投；
    // 现在发给子代理也走 myco（署名/审计一致）。全量也落空才报原始人话错误。
    let (sid, name) = match session_resolve_target(&sessions, &to_val) {
        Ok(x) => x,
        Err(e) => {
            let all = full_sessions(&mut all_cache);
            match session_resolve_target(&all, &to_val) {
                Ok(x) => x,
                Err(_) => return Err(e),
            }
        }
    };
    let mode = p.flags.get("mode").map(|s| s.as_str()).unwrap_or("queue");
    let reply = block_on(crate::dsh_share::cli_local_session_prompt_mode(&sid, &prefixed, mode))?;
    let mut v = json!({
        "ok": true, "route": "local",
        "to": { "sessionId": sid, "name": name },
        "sender": sender,
        "senderSource": sender_src,
        "deliveredText": prefixed,
        "reply": reply,
    });
    let mut human = format!(
        "已投递（本机直投）\n  目标会话    {name}（{sid}）\n  署名        [{sender}]（来源：{sender_src}）\n  消息        {prefixed}\n  提示        对方 AI 会立即处理（prompt 已入队）",
    );
    if let Some(w) = sign_warning {
        v["warning"] = json!(w);
        human.push_str(&format!("\n  ⚠️  {w}"));
    }
    Ok(ShareReply { json: v, human })
}

// ═══════════════════════════════════════════════════════════════════════
// share —— 分享网关管理面的**薄** CLI（feat/dsh-share-home）
//
// 设计约束（协调者定稿，改动前先读）：
//   · **只是 HTTP 的语法糖**：全部经 `http://127.0.0.1:<管理面>/api/dshShare/*`
//     调用（与 myco skill 走同一套端点、同一份语义），**不新增任何语义**，
//     也**绝不直读/直写 `dsh-shares.json`**（运行中的网关持有内存态，直改文件
//     会与进程不一致——这正是 skill 只走 HTTP 的同一条理由）。
//   · **camelCase JSON**：请求体字段与 `dsh_share.rs` 的 `local_router()` 期望
//     一致（shareId/granularity/sessionId/cwd/title/label/did/ttlSec/windowMs/
//     space/sessions + 任务声明面 caps/stateVisibility/taskCard——见 `share_create_plan`）。
//   · **网关没跑要给人话**：连不上 → 提示先跑 `myco cli serve` 或打开 myco Home，
//     退出码 1（不打印半截表格）。
//   · `list` 支持 `--json`（原始响应，脚本/agent 用）；其余子命令同样认 `--json`。
// ═══════════════════════════════════════════════════════════════════════

/// 分享网关本地管理面基址——与 `dsh_share::local_api_base()` **同一套规则**
/// （MYCO_SHARE_LOCAL_PORT / ENV_HTTP_PORT 覆盖 → ports.json 记忆口 → 默认 3102；
/// 2026-10-14 起管理面 3102 被占会动态顺延，实际口落 ports.json 的 mgmt 字段）。
fn share_api_base() -> String {
    let port: u16 = std::env::var("MYCO_SHARE_LOCAL_PORT")
        .or_else(|_| std::env::var("ENV_HTTP_PORT"))
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| crate::ports_file::read().mgmt);
    format!("http://127.0.0.1:{port}")
}

/// 逐人能力集的五个固定 id（机器面钉死在 `dsh_share::CAP_IDS`；这里只是 CLI 侧的
/// 词表副本，用于把 `--caps a,b` 翻成端点要的布尔对象，并在本地拦下拼错的 id）。
/// 2026-11-04 真案：model.select 已是第 5 个可控能力（dsh_share CAP_IDS 同步加），
/// 但 CLI 词表漏了——`share create --caps model.select` 被误报"未知能力 id"。
const SHARE_CAP_IDS: &[&str] = &["session.read", "session.input", "agent.view", "scope.switch", "model.select"];

const SHARE_DOWN_HINT: &str = "分享网关未在运行——先跑 `myco cli serve` 或打开 myco Home";

/// 打网关的 HTTP 面（唯一的出网点；GET/POST 两种）。
///
/// 错误约定：网关的连接失败/超时/非 JSON 一律转**人话**；端点返回
/// `{"ok":false,"error":…}`（多数 handler 用 200 携带业务失败）也转 Err，
/// 让 dispatch 统一 `stderr + exit 1`。
fn share_call(method: &str, path: &str, body: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let base = share_api_base();
    let url = format!("{base}{path}");
    let http = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP 客户端构造失败: {e}"))?;
    let req = if method == "GET" { http.get(&url) } else { http.post(&url) };
    let req = match body {
        Some(b) => req.json(&b),
        None => req,
    };
    let resp = req.send().map_err(|e| {
        if e.is_connect() {
            format!("{SHARE_DOWN_HINT}（管理面 {base} 连不上）")
        } else if e.is_timeout() {
            format!("分享网关响应超时（{base}）——网关可能正忙或已卡住")
        } else {
            format!("分享网关请求失败（{url}）: {e}")
        }
    })?;
    let status = resp.status();
    let text = resp.text().map_err(|e| format!("读响应失败: {e}"))?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|_| {
        let head: String = text.trim().chars().take(200).collect();
        format!("分享网关返回非 JSON（HTTP {status}）: {head}")
    })?;
    if v.get("ok").and_then(|x| x.as_bool()) == Some(false) {
        return Err(v
            .get("error")
            .and_then(|x| x.as_str())
            .unwrap_or("分享网关返回 ok=false（无 error 字段）")
            .to_string());
    }
    if !status.is_success() {
        return Err(format!("分享网关 HTTP {status}: {}", serde_json::to_string(&v).unwrap_or_default()));
    }
    Ok(v)
}

/// `--caps session.read,session.input` → 逐人能力勾选对象（四固定 id 布尔）。
/// 列出的 = true，其余 = **显式 false**（用户口径「只给这几项」；缺项在网关侧语义是
/// 「继承任务级」，那会让没写出来的能力悄悄留着——不是 CLI 想要的表达）。
fn share_caps_flags(csv: &str) -> Result<serde_json::Value, String> {
    let want: Vec<String> = csv.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if want.is_empty() {
        return Err(format!("--caps 为空——可用: {}", SHARE_CAP_IDS.join(",")));
    }
    for id in &want {
        if !SHARE_CAP_IDS.contains(&id.as_str()) {
            return Err(format!("未知能力 id {id:?}（可用: {}）", SHARE_CAP_IDS.join(" / ")));
        }
    }
    let mut o = serde_json::Map::new();
    for id in SHARE_CAP_IDS {
        o.insert((*id).to_string(), json!(want.iter().any(|w| w == id)));
    }
    Ok(serde_json::Value::Object(o))
}

// ─── 任务声明面（§3.14 能力集 / §3.20 状态空间可见范围 / AOP 任务卡）───
//
// 三条纪律（改动前先读）：
//   · **不新增语义**：这里只是把 CLI flag 翻成 `handle_create` **已经认**的三个入参
//     （caps / stateVisibility / taskCard），形状与网关侧逐字段对齐；
//   · **缺省不下发**：没给对应 flag 就一个字节都不发 → 网关走既有默认（零回归）；
//   · **本地能拦的别出网**：能力 id / space 值 / 毫秒数在这里就校验。

/// 四个能力面的**词表骨架**：`(id, label, methods, direction)`（direction：o=看 / a=做）。
/// 与 `dsh_share.rs::capability_face_skeleton`（§3.14.1 目录底座）**同源**——
/// id/label/methods 逐字段一致，只抄词表不 import 网关内部常量（本段是"薄 HTTP"，见段首注释）。
/// `scope.switch` 的 methods 只声明 `session/activate`（§3.14.1 口径，与网关骨架一致）。
const SHARE_CAP_FACES: &[(&str, &str, &[&str], &str)] = &[
    ("session.read", "看会话内容", &["session/page", "session/list"], "o"),
    ("session.input", "输入内容", &["session/prompt"], "a"),
    ("agent.view", "看子 agent", &["subagent/list"], "o"),
    ("scope.switch", "切换已授权的会话/工作区", &["session/activate"], "a"),
    ("model.select", "切换模型", &["session/selectModel"], "a"),
];

/// 单个能力面的**声明项**（`{id,label,methods}`，与网关 `capability_face_skeleton` 同形）。
/// `methods` 是"声明可用什么"，真正的判定在网关侧（`caps_declares`），CLI 不参与判定。
fn share_cap_item(id: &str, label: &str, methods: &[&str]) -> serde_json::Value {
    json!({ "id": id, "label": label, "methods": methods })
}

/// `--caps session.read,session.input` → create 的**任务级 caps 声明对象**
/// `{o:[{id,label,methods}], a:[…]}`（§3.14；形状 = `handle_create` 的 `caps` 入参）。
///
/// 校验**复用 `share_caps_flags`**（拼错的 id 在本地就被拦下，一轮都不出网），
/// 口径也与 `share grant --caps` **完全一致**：「列出的 = 给，没列出的 = 不给」——
/// 所以某一向一个 id 都没列 → **显式空数组**（网关 `normalize_caps` 对空数组的既有语义
/// 就是"这一向全关"，不会回落默认；填 false 的布尔对象在这条通道上不是合法形状）。
fn share_caps_decl(csv: &str) -> Result<serde_json::Value, String> {
    let flags = share_caps_flags(csv)?;
    let (mut o, mut a): (Vec<serde_json::Value>, Vec<serde_json::Value>) = (vec![], vec![]);
    for (id, label, methods, dir) in SHARE_CAP_FACES.iter().copied() {
        if flags.get(id).and_then(|v| v.as_bool()) != Some(true) {
            continue; // 没列出 = 不声明（与 grant 的显式 false 同一口径）
        }
        let item = share_cap_item(id, label, methods);
        if dir == "a" {
            a.push(item);
        } else {
            o.push(item);
        }
    }
    Ok(json!({ "o": o, "a": a }))
}

/// caps 声明对象 → 人话清单（`["看会话内容","输入内容"]`；O 向在前，取声明项的 label，
/// 缺 label 回落 id）。只列**声明了**的——没声明的不在清单里（就是"不给"）。
fn share_caps_labels(caps: &serde_json::Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for dir in ["o", "a"] {
        if let Some(arr) = caps.get(dir).and_then(|v| v.as_array()) {
            for it in arr {
                let label = it
                    .get("label")
                    .and_then(|v| v.as_str())
                    .or_else(|| it.get("id").and_then(|v| v.as_str()))
                    .unwrap_or("?");
                if !out.iter().any(|x| x == label) {
                    out.push(label.to_string());
                }
            }
        }
    }
    out
}

/// 逗号 flag → 值清单（`--sessions a, b ,c` → `["a","b","c"]`；去空白/去空项/去重保序）。
/// 重复给同键由 `parse_args` 的 `CSV_FLAGS` 本地报错（不做静默覆盖）。
fn share_csv(p: &Parsed, key: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(v) = p.flags.get(key) {
        for x in v.split(',') {
            let x = x.trim();
            if !x.is_empty() && !out.iter().any(|o| o == x) {
                out.push(x.to_string());
            }
        }
    }
    out
}

/// `--space/--sessions/--window-ms` → create 的 **stateVisibility 对象**（§3.20 可见范围）。
///
/// 为什么走 `stateVisibility` 而不是 `visibility`：这个名字在 create 上**同名不同物**
/// （`handle_create` 注释原文）——字符串 = 发布面 `private|public`，对象 = 状态空间可见范围。
/// CLI 把两者拆开表达：字符串仍走 `--visibility`（落 `visibility` 键），对象走**别名**
/// `stateVisibility`；两者可同时给、互不覆盖（网关 `handle_create` 的既有读法）。
///
/// 只下发用户**给了**的键（缺省交给网关 `visibility_default`，CLI 不另立默认）。
/// 一个都没给 → `None` = 不下发（与旧行为逐字节一致）。
fn share_state_visibility(p: &Parsed) -> Result<Option<serde_json::Value>, String> {
    let space = p.flags.get("space").map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(s) = &space {
        if !matches!(s.as_str(), "machine" | "project" | "session") {
            return Err(format!("--space 只认 machine/project/session，收到 {s:?}"));
        }
    }
    let sessions = share_csv(p, "sessions");
    let window_ms: Option<u64> = match p.flags.get("window-ms") {
        Some(w) => Some(
            w.trim()
                .parse()
                .map_err(|_| format!("--window-ms 须为非负整数毫秒，收到 {w:?}"))?,
        ),
        None => None,
    };
    if space.is_none() && sessions.is_empty() && window_ms.is_none() {
        return Ok(None);
    }
    let mut o = serde_json::Map::new();
    if let Some(s) = space {
        o.insert("space".to_string(), json!(s));
    }
    if !sessions.is_empty() {
        o.insert("sessions".to_string(), json!(sessions));
    }
    if let Some(w) = window_ms {
        o.insert("windowMs".to_string(), json!(w));
    }
    Ok(Some(serde_json::Value::Object(o)))
}

/// `--goal/--sla/--reward` → create 的 `taskCard` 对象（AOP R 层卡面；
/// 字段名与 `handle_publish` 认的 taskCard **同名**：goal/sla/reward）。
/// 一个都没给（或给了空串）→ `None` = 不下发（网关 taskCard 落 null，与旧行为一致）。
fn share_task_card(p: &Parsed) -> Option<serde_json::Value> {
    let mut m = serde_json::Map::new();
    for (flag, key) in [("goal", "goal"), ("sla", "sla"), ("reward", "reward")] {
        if let Some(v) = p.flags.get(flag).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
            m.insert(key.to_string(), json!(v));
        }
    }
    if m.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(m))
    }
}

/// 任务卡人话（"目标/验收已设"；三个字段一个都没有 → `None`）。
fn share_task_card_human(card: &serde_json::Value) -> Option<String> {
    let parts: Vec<&str> = [("goal", "目标"), ("sla", "验收"), ("reward", "奖励")]
        .iter()
        .filter(|(k, _)| card.get(*k).and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false))
        .map(|(_, l)| *l)
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(format!("{}已设", parts.join("/")))
    }
}

/// 毫秒 → 人话（6 小时 / 7 天 / 90 分钟 / 裸毫秒）。
fn share_ms_human(ms: u64) -> String {
    if ms != 0 && ms % 86_400_000 == 0 {
        format!("{}天", ms / 86_400_000)
    } else if ms != 0 && ms % 3_600_000 == 0 {
        format!("{}小时", ms / 3_600_000)
    } else if ms != 0 && ms % 60_000 == 0 {
        format!("{}分钟", ms / 60_000)
    } else {
        format!("{ms}ms")
    }
}

/// 可见范围概要（`stateVisibility` → 一句人话：空间 + 时间窗）。
fn share_vis_human(s: &serde_json::Value) -> String {
    let vis = &s["stateVisibility"];
    let space = vis["space"].as_str().unwrap_or("machine");
    let n_sessions = vis["sessions"].as_array().map(|a| a.len()).unwrap_or(0);
    let space_s = match space {
        "project" => "本项目".to_string(),
        "session" if n_sessions > 0 => format!("会话×{n_sessions}"),
        "session" => "会话（白名单空=不限）".to_string(),
        _ => "整机".to_string(),
    };
    let win_s = match vis["windowMs"].as_u64() {
        Some(ms) => format!("最近{}", share_ms_human(ms)),
        None => "全部历史".to_string(),
    };
    format!("{space_s} · {win_s}")
}

/// `list` 的人类友好表（shareId/档位/state/授权数/可见范围 + 标题）。
fn share_list_human(v: &serde_json::Value) -> String {
    let shares = v["shares"].as_array().cloned().unwrap_or_default();
    let entry = v["entryBase"].as_str().unwrap_or("-");
    if shares.is_empty() {
        return format!("没有分享（入口 {entry}）\n");
    }
    let mut out = format!("分享 {} 条（入口 {entry}）\n\n", shares.len());
    for s in &shares {
        let id = s["shareId"].as_str().unwrap_or("?");
        let gran = s["granularity"].as_str().unwrap_or("-");
        let state = s["state"].as_str().unwrap_or("-");
        let grants = s["grants"].as_array().map(|a| a.len()).unwrap_or(0);
        let title = s["title"].as_str().unwrap_or("");
        out.push_str(&format!(
            "{id:<16} {gran:<9} {state:<8} 授权 {grants:<3} 可见: {}\n",
            share_vis_human(s)
        ));
        out.push_str(&format!("  {title}\n"));
        if let Some(sid) = s["sessionId"].as_str().filter(|x| !x.is_empty()) {
            out.push_str(&format!("  └ 会话 {sid}\n"));
        }
    }
    out
}

/// CLI 侧子命令的返回：JSON（`--json` / serve 透传用）+ 人话（默认打印）。
#[derive(Debug)]
pub struct ShareReply {
    pub json: serde_json::Value,
    pub human: String,
}

/// `myco cli share <子命令>` 的纯实现（不打印、不 exit——打印在 dispatch，
/// cli_serve 的 /cli 透传取 `.json`）。
pub fn cmd_share(p: &Parsed) -> Result<ShareReply, String> {
    match p.positional.first().map(String::as_str) {
        Some("create") => share_create(p),
        Some("list") | None => share_list(p),
        Some("grant") => share_grant(p),
        Some("visibility") => share_visibility(p),
        Some("revoke") => share_revoke(p),
        // ── 2026-11-03 授权面补全（都有对应 local_router 端点，无新增业务语义）──
        Some("grants") => share_grants_cmd(p),
        Some("caps") => share_caps_cmd(p),
        Some("grant-caps") => share_grant_caps_cmd(p),
        Some("revoke-all") => share_revoke_all_cmd(p),
        Some("requests") => share_requests_cmd(p),
        Some("req-decide") => share_req_decide_cmd(p),
        Some("reshare") => share_reshare_list_cmd(p),
        Some("reshare-decide") => share_reshare_decide_cmd(p),
        Some("can-reshare") => share_can_reshare_cmd(p),
        Some("perm") => share_perm_cmd(p),
        Some("suspend") => share_state_cmd(p, "suspend"),
        Some("resume") => share_state_cmd(p, "resume"),
        Some("complete") => share_state_cmd(p, "complete"),
        Some("kill") => share_state_cmd(p, "kill"),
        Some("open") => share_open_cmd(p),
        Some("task-group") => share_task_group_cmd(p),
        Some("ensure-group") => share_ensure_group_cmd(p),
        Some("sessions") => share_sessions_cmd(p),
        Some("capabilities") => share_capabilities_cmd(p),
        Some("events") => share_events_cmd(p),
        Some("publish") => share_publish_cmd(p),
        Some(other) => Err(format!(
            "未知子命令 share {other}（可用: create/list/grant/visibility/revoke/grants/caps/grant-caps/revoke-all/requests/req-decide/reshare/reshare-decide/can-reshare/perm/suspend/resume/complete/kill/open/task-group/ensure-group/sessions/capabilities/events/publish）"
        )),
    }
}

/// `share create` 的**请求体 + 人话自述**（不发 HTTP——单测直接覆盖组装与本地校验）。
#[derive(Debug)]
struct ShareCreatePlan {
    body: serde_json::Value,
    /// 用到了任一新声明 flag？（false = 打印与旧版**逐字节一致**的老输出——零回归）
    declared: bool,
    /// 用户给的标题（没给 = None；人话里不替网关编默认名）
    title: Option<String>,
    /// 本地组装的 stateVisibility（人话打印用；None = 没下发）
    state_visibility: Option<serde_json::Value>,
    /// 本地组装的 taskCard（人话打印用；None = 没下发。create 的响应**不回显**它，
    /// 回读看 `GET /api/dshShare/visibility` / 注册表）
    task_card: Option<serde_json::Value>,
    /// 非致命提示（不拦——都是网关既有语义，说出来免得静默）
    notes: Vec<String>,
    /// `--grant-to` 的标签（None = 不签邀请）
    grant_to: Option<String>,
    /// `--env-*` 声明的环境入口人话（None = 不是环境卡）
    env_human: Option<String>,
}

/// `share create` 的新声明面用到的 flag（任一出现 → 打"任务已声明"块）。
const SHARE_DECLARE_FLAGS: &[&str] = &[
    "caps", "space", "sessions", "window-ms", "visibility", "goal", "sla", "reward", "grant-to", "grant-did",
    "env-kind", "env-device",
];

const SHARE_CREATE_USAGE: &str = "用法: share create --granularity session|workspace|instance|main \
[--session-id X | --cwd DIR] [--title T] [--visibility private|public] [--space machine|project|session] \
[--sessions id1,id2] [--window-ms N] [--caps session.read,session.input] [--goal G] [--sla S] [--reward R] \
[--env-kind rdp|dsh|ssh|http|stereo|adb|vnc|rustdesk --env-device <did> [--env-port P] [--env-local-port P] [--env-label L]] \
[--grant-to <名> [--grant-did <did>]]";

/// 组装 create 请求体（含任务声明面），**全部本地校验都在出网前**。
fn share_create_plan(p: &Parsed) -> Result<ShareCreatePlan, String> {
    let session_id = p.flags.get("session-id").map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let cwd = p.flags.get("cwd").map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    // 环境卡（`--env-kind`）：与 UI「分享环境」同一条 create 通道（body 里的 env[]），
    // 缺档位时默认 `main`（不为一张 RDP 卡白起 ~200MB 的 DSH 实例，与 UI 同语义）。
    let env_kind = p.flags.get("env-kind").map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty());
    let env_device = p.flags.get("env-device").map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if env_kind.is_some() != env_device.is_some() {
        return Err("--env-kind 与 --env-device 必须成对给（例: --env-kind rdp --env-device did:myco:…）".into());
    }
    if env_kind.is_none()
        && ["env-port", "env-local-port", "env-label"].iter().any(|f| p.flags.contains_key(*f))
    {
        return Err("--env-port/--env-local-port/--env-label 只在 --env-kind 下有意义".into());
    }
    // 档位可省：有 --session-id 推 session、有 --cwd 推 workspace（其余要显式给，
    // 免得"我分享的是哪个窗口"这种歧义落到缺省 workspace 上）。
    let granularity = match p.flags.get("granularity") {
        Some(g) => g.trim().to_string(),
        None if session_id.is_some() => "session".to_string(),
        None if cwd.is_some() => "workspace".to_string(),
        None if env_kind.is_some() => "main".to_string(),
        None => return Err(SHARE_CREATE_USAGE.into()),
    };
    if !matches!(granularity.as_str(), "session" | "workspace" | "instance" | "main") {
        return Err(format!("--granularity 只认 session/workspace/instance/main，收到 {granularity:?}"));
    }
    if granularity == "session" && session_id.is_none() {
        return Err("session 档需要 --session-id <会话 id>（清单见 GET /api/dshShare/sessions）".into());
    }
    if granularity == "workspace" && cwd.is_none() {
        return Err("workspace 档需要 --cwd <目录>".into());
    }
    let title = p.flags.get("title").map(|s| s.to_string()).filter(|s| !s.trim().is_empty());
    // ── 任务声明面 ──
    let caps = match p.flags.get("caps") {
        Some(c) => Some(share_caps_decl(c)?),
        None => None,
    };
    // `--visibility` 只管**发布面**（字符串）。对象形态（状态空间可见范围）由
    // --space/--sessions/--window-ms 组装走 `stateVisibility` 别名——两者同名不同物，
    // 不在这里猜（`handle_create` 的既有读法，见 share_state_visibility 注释）。
    let listing = match p.flags.get("visibility").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(v) if matches!(v.as_str(), "private" | "public") => Some(v),
        Some(v) => {
            return Err(format!(
                "--visibility 只认 private|public（发布面），收到 {v:?}；状态空间可见范围请用 --space/--sessions/--window-ms"
            ))
        }
        None => None,
    };
    let state_visibility = share_state_visibility(p)?;
    let task_card = share_task_card(p);
    let grant_to = p.flags.get("grant-to").map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if p.flags.contains_key("grant-to") && grant_to.is_none() {
        return Err("--grant-to 需要非空标签（例: --grant-to 小王）".into());
    }
    if grant_to.is_none() && p.flags.contains_key("grant-did") {
        return Err("--grant-did 只在 --grant-to 下有意义（给谁签邀请）".into());
    }
    let declared = SHARE_DECLARE_FLAGS.iter().any(|f| p.flags.contains_key(*f));
    // ── 提示（不拦；网关的既有语义，只是别静默）──
    let mut notes: Vec<String> = Vec::new();
    if let Some(sv) = &state_visibility {
        let sp = sv["space"].as_str().unwrap_or("machine");
        let n = sv["sessions"].as_array().map(|a| a.len()).unwrap_or(0);
        if sp == "session" && n == 0 {
            notes.push("--space session 但没给 --sessions：白名单空 = 不额外限制（与不设 space 同义）".into());
        }
        if sp != "session" && n > 0 {
            notes.push(format!("--sessions 只在 --space session 下生效（当前 space={sp}，白名单不生效）"));
        }
        if let Some(w) = sv["windowMs"].as_u64().filter(|w| *w < 60_000) {
            notes.push(format!("--window-ms {w} < 60000——网关逐人授权面（share grant）会忽略这么窄的窗"));
        }
    }
    let mut body = json!({ "granularity": granularity });
    if let Some(s) = &session_id {
        body["sessionId"] = json!(s);
    }
    if let Some(c) = &cwd {
        body["cwd"] = json!(c);
    }
    if let Some(t) = &title {
        body["title"] = json!(t);
    }
    if let Some(v) = &listing {
        body["visibility"] = json!(v);
    }
    if let Some(sv) = &state_visibility {
        body["stateVisibility"] = sv.clone();
    }
    if let Some(tc) = &task_card {
        body["taskCard"] = tc.clone();
    }
    if let Some(c) = &caps {
        body["caps"] = c.clone();
    }
    // ── 环境卡（§3.19/任务卡 env；与 UI `share_create_env_card` 的 create 半段同形）──
    let env_human = match (&env_kind, &env_device) {
        (Some(kind), Some(device)) => {
            if !crate::vnet_env::is_known_kind(kind) {
                return Err(format!(
                    "不支持的 --env-kind {kind:?}（白名单: {}）",
                    crate::vnet_env::ENV_KINDS.join("|")
                ));
            }
            if !device.starts_with("did:") {
                return Err("--env-device 须为目标设备 DID（did: 前缀）".into());
            }
            let mut env = json!({ "kind": kind, "device": device });
            if let Some(port) = flag_u16(p, "env-port")? {
                env["port"] = json!(port);
            }
            if let Some(lp) = flag_u16(p, "env-local-port")? {
                env["localPort"] = json!(lp);
            }
            if let Some(l) = p.flags.get("env-label").map(|s| s.trim()).filter(|s| !s.is_empty()) {
                env["label"] = json!(l);
            }
            body["env"] = json!([env]);
            Some(format!("{kind} → {device}"))
        }
        _ => None,
    };
    Ok(ShareCreatePlan { body, declared, title, state_visibility, task_card, notes, grant_to, env_human })
}

/// 老用法（未用任何新声明 flag）的人话——**与补齐前逐字节一致**（零回归）。
fn share_create_human_legacy(id: &str, v: &serde_json::Value) -> String {
    format!(
        "分享已创建\n  shareId       {id}\n  档位          {}\n  ownerUrl      {}\n  localOpenUrl  {}\n  提示          发给别人: myco cli share grant --share {id} --label <名>",
        v["granularity"].as_str().unwrap_or("-"),
        v["ownerUrl"].as_str().unwrap_or("-"),
        v["localOpenUrl"].as_str().unwrap_or("-"),
    )
}

/// 声明面人话块：一条命令声明了什么（档位/可见范围/能力/任务卡/入口），
/// 邀请链接在 `invite` 给了才多两行。
///
/// 可见范围/任务卡取**本地组装的那份**（= 发出去的那份）：网关 `handle_create` 的响应
/// 只回显 caps，不回显 stateVisibility/taskCard；回读口径是 `GET /api/dshShare/visibility`。
fn share_create_human_declared(
    id: &str,
    v: &serde_json::Value,
    plan: &ShareCreatePlan,
    invite: Option<&serde_json::Value>,
) -> String {
    // 可见范围：本地下发的对象（没下发 = 网关默认：整机 · 全部历史——`visibility_default`
    // 的既有口径，`share_vis_human` 对缺键的回落与它一致）。
    let vis = plan.state_visibility.clone().unwrap_or_else(|| json!({ "space": "machine", "sessions": [], "windowMs": null }));
    let caps_labels = share_caps_labels(&v["caps"]);
    let entry = format!(
        "{}{}",
        v["entryBase"].as_str().unwrap_or("").trim_end_matches('/'),
        v["urlPath"].as_str().unwrap_or(""),
    );
    let mut s = format!(
        "任务已声明\n  shareId       {id}\n  标题          {}\n  档位          {}\n  可见范围      {}\n  能力          {}\n",
        plan.title.as_deref().unwrap_or("（未命名——网关按 shareId 生成）"),
        v["granularity"].as_str().unwrap_or("-"),
        share_vis_human(&json!({ "stateVisibility": vis })),
        if caps_labels.is_empty() { "（未声明——网关默认只看+输入）".to_string() } else { caps_labels.join("、") },
    );
    if let Some(tc) = &plan.task_card {
        if let Some(t) = share_task_card_human(tc) {
            s.push_str(&format!("  任务卡        {t}\n"));
        }
    }
    if let Some(e) = &plan.env_human {
        s.push_str(&format!("  环境          {e}\n"));
    }
    s.push_str(&format!("  入口          {entry}\n"));
    s.push_str(&format!("  本地入口      {}\n", v["localOpenUrl"].as_str().unwrap_or("-")));
    if let Some(g) = invite {
        if let Some(label) = &plan.grant_to {
            s.push_str(&format!("  邀请链接      {}\n", g["url"].as_str().unwrap_or("-")));
            s.push_str(&format!("  邀请标签      {label}\n"));
        }
    }
    for n in &plan.notes {
        s.push_str(&format!("  提示          {n}\n"));
    }
    s
}

/// `share create …` → POST /api/dshShare/create（+ `--grant-to` 时第二条
/// POST /api/dshShare/grant——一次命令 = 声明 + 邀请）。
fn share_create(p: &Parsed) -> Result<ShareReply, String> {
    let plan = share_create_plan(p)?;
    let mut v = share_call("POST", "/api/dshShare/create", Some(plan.body.clone()))?;
    let id = v["shareId"].as_str().unwrap_or("?").to_string();
    // --grant-to：第二条 HTTP。失败**不吞**——分享已经建好了，错误里带上 shareId 与
    // 补跑命令，免得用户以为"没建成"再建一条重复的。
    let invite = match plan.grant_to.as_deref() {
        Some(label) => {
            let mut g = json!({ "shareId": id, "label": label });
            if let Some(d) = p.flags.get("grant-did").map(|s| s.trim()).filter(|s| !s.is_empty()) {
                g["did"] = json!(d);
            }
            match share_call("POST", "/api/dshShare/grant", Some(g)) {
                Ok(gv) => Some(gv),
                Err(e) => {
                    return Err(format!(
                        "分享已创建（{id}）但 --grant-to {label} 签发失败：{e}\n  补跑: myco cli share grant --share {id} --label {label}"
                    ))
                }
            }
        }
        None => None,
    };
    if let Some(g) = &invite {
        // --json 面：create 的原始响应**原样保留**，只追加一个 `grantTo` 键
        // （第二条 HTTP 的响应；没有它，--json 调用方拿不到邀请链接）。
        v["grantTo"] = g.clone();
    }
    let human = if plan.declared {
        share_create_human_declared(&id, &v, &plan, invite.as_ref())
    } else {
        share_create_human_legacy(&id, &v)
    };
    Ok(ShareReply { json: v, human })
}

/// `share list [--json]` → GET /api/dshShare/list。
fn share_list(_p: &Parsed) -> Result<ShareReply, String> {
    let v = share_call("GET", "/api/dshShare/list", None)?;
    let human = share_list_human(&v);
    Ok(ShareReply { json: v, human })
}

/// `share grant --share <id> --label <名> [--did D] [--ttl-secs N] [--window-ms N]
///  [--caps a,b] [--ro]` → POST /api/dshShare/grant（返回里带对方要用的 bearer URL）。
fn share_grant(p: &Parsed) -> Result<ShareReply, String> {
    let usage = "用法: share grant --share <id> --label <名> [--did <did>] [--ttl-secs N] [--window-ms N] [--caps session.read,session.input] [--ro]";
    let share_id = p.flags.get("share").ok_or(usage)?;
    let label = p.flags.get("label").ok_or(usage)?;
    let mut body = json!({ "shareId": share_id, "label": label });
    if let Some(d) = p.flags.get("did").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        body["did"] = json!(d);
    }
    let ttl_secs = match p.flags.get("ttl-secs") {
        Some(t) => Some(t.parse::<u64>().map_err(|_| format!("--ttl-secs 须为非负整数秒，收到 {t:?}"))?),
        None => None,
    };
    if let Some(t) = ttl_secs {
        body["ttlSec"] = json!(t);
    }
    if let Some(w) = p.flags.get("window-ms") {
        let wm: u64 = w.parse().map_err(|_| format!("--window-ms 须为非负整数毫秒，收到 {w:?}"))?;
        body["windowMs"] = json!(wm);
    }
    if let Some(c) = p.flags.get("caps") {
        body["caps"] = share_caps_flags(c)?;
    }
    if p.flags.contains_key("ro") {
        body["ro"] = json!(true);
    }
    // 人话里要用的字段先取出来（body 下面按值交给 share_call）
    let did_display = body["did"]
        .as_str()
        .unwrap_or("（无——bearer 链接，谁拿到谁能进）")
        .to_string();
    let v = share_call("POST", "/api/dshShare/grant", Some(body))?;
    let ttl_s = match ttl_secs {
        Some(t) => format!("{t} 秒"),
        None => "缺省 7 天".to_string(),
    };
    let human = format!(
        "已签发授权\n  shareId    {share_id}\n  标签       {label}\n  DID        {did_display}\n  权限       {}\n  有效期     {ttl_s}{}\n  bearer URL （给对方）\n    {}\n  提示       同 label 重签会覆盖旧票；收回用 share revoke --share {share_id} --label {label}",
        if p.flags.contains_key("ro") { "只读（拦写方法）" } else { "读写" },
        match p.flags.get("window-ms") {
            Some(w) => format!("；可见窗 {}（{}）", w, share_ms_human(w.parse().unwrap_or(0))),
            None => String::new(),
        },
        v["url"].as_str().unwrap_or("-"),
    );
    Ok(ShareReply { json: v, human })
}

/// `share visibility --share <id> --space machine|project|session [--sessions id1,id2]
///  [--window-ms N]` → POST /api/dshShare/visibility（任务级可见范围，S→O 投影）。
fn share_visibility(p: &Parsed) -> Result<ShareReply, String> {
    let usage = "用法: share visibility --share <id> [--space machine|project|session [--sessions id1,id2] [--window-ms N] [--did D]]（不给 --space = 读当前配置）";
    let share_id = p.flags.get("share").ok_or(usage)?;
    // 2026-11-03：不给 --space = **读**（UI「授权与可见性」面板的当前值），给了 = 写。
    let Some(space) = p.flags.get("space").map(|s| s.trim().to_string()) else {
        let v = share_call("GET", &format!("/api/dshShare/visibility?shareId={}", pct(share_id)), None)?;
        let cur = &v["current"];
        let grants = v["grants"].as_array().cloned().unwrap_or_default();
        let mut human = format!(
            "可见范围（任务级）：{}\n  shareId   {share_id}\n  space     {}\n  windowMs  {}\n",
            share_vis_human(&json!({ "stateVisibility": cur })),
            cur["space"].as_str().unwrap_or("-"),
            match cur["windowMs"].as_u64() {
                Some(ms) => format!("{ms}（最近{}）", share_ms_human(ms)),
                None => "null（全部历史）".to_string(),
            },
        );
        if !grants.is_empty() {
            human.push_str("  逐人可见范围：\n");
            for g in &grants {
                human.push_str(&format!(
                    "    {}  {}{}\n",
                    g["name"].as_str().or_else(|| g["did"].as_str()).unwrap_or("?"),
                    share_vis_human(&json!({ "stateVisibility": g["effective"] })),
                    if g["visibility"].is_null() { "（跟随整体）" } else { "（逐人覆盖）" },
                ));
            }
        }
        return Ok(ShareReply { json: v, human });
    };
    if !matches!(space.as_str(), "machine" | "project" | "session") {
        return Err(format!("--space 只认 machine/project/session，收到 {space:?}"));
    }
    // 与 create 面同一套解析（逗号分隔、去空白、去重保序；重复给同键由 parse_args 拦下）。
    let sessions: Vec<String> = share_csv(p, "sessions");
    let window_ms: Option<u64> = match p.flags.get("window-ms") {
        // 给值必须是合法毫秒；`--window-ms 0` = 极窄窗（网关按非负毫秒收）。
        Some(w) => Some(w.parse().map_err(|_| format!("--window-ms 须为非负整数毫秒，收到 {w:?}"))?),
        None => None, // 键照发（null）= 「全部历史」，可用来清掉旧的时间窗
    };
    let mut body = json!({
        "shareId": share_id,
        "visibility": { "space": space, "sessions": sessions, "windowMs": window_ms },
    });
    // §3.20 逐人覆盖：--did 给了就写该人（null 清除走 --clear 语义，这里不做）。
    if let Some(did) = p.flags.get("did").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        body["did"] = json!(did);
    }
    let v = share_call("POST", "/api/dshShare/visibility", Some(body))?;
    let cur = &v["current"];
    let cur_sessions: Vec<String> = cur["sessions"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let human = format!(
        "可见范围已设置（任务级）\n  shareId   {share_id}\n  space     {}\n  sessions  {}\n  windowMs  {}\n  概要      {}",
        cur["space"].as_str().unwrap_or(&space),
        if cur_sessions.is_empty() { "（无 = 不额外限制）".to_string() } else { cur_sessions.join(", ") },
        match cur["windowMs"].as_u64() {
            Some(ms) => format!("{ms}（最近{}）", share_ms_human(ms)),
            None => "null（全部历史）".to_string(),
        },
        share_vis_human(&json!({ "stateVisibility": cur })),
    );
    Ok(ShareReply { json: v, human })
}

/// `share revoke --share <id> [--label <名>]` → POST /api/dshShare/revoke
/// （无 label = 整个分享下线；有 label = 只吊销该人的 grant）。
fn share_revoke(p: &Parsed) -> Result<ShareReply, String> {
    let share_id = p
        .flags
        .get("share")
        .ok_or("用法: share revoke --share <id> [--label <名>]")?;
    let mut body = json!({ "shareId": share_id });
    let label = p.flags.get("label").map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(l) = &label {
        body["label"] = json!(l);
    }
    let v = share_call("POST", "/api/dshShare/revoke", Some(body))?;
    let human = match &label {
        Some(l) => format!("已吊销授权：share {share_id} · label {l}（其他人的 grant 与分享本身不受影响）"),
        None => format!("已下线整个分享：{share_id}（分享记录已移除、实例已停、所有 bearer URL 失效）"),
    };
    Ok(ShareReply { json: v, human })
}

// ═══════════════════════════════════════════════════════════════════════
// account —— 账号生命周期（2026-11-03「UI 有的 CLI 都要有」主线一）
//
// 设计纪律：
//   · 全部走 myco-core 的 account_* 原语（与 UI identity_service 的薄封装**同一实现**）；
//   · 本段不 import 任何 tauri / GUI 模块 ⇒ CLI/headless 变体也可用；
//   · **不新增种子导出面**：明文种子仍只有既存 `identity export-seed`（UI 同款），
//     这里连 `--export-backup` 都不做（加密备份也是种子，红线：私钥不出 core）。
//   · 密码只走参数/环境，不回显；输出里绝不带 seed。
// ═══════════════════════════════════════════════════════════════════════

fn account_status_json() -> Result<serde_json::Value, String> {
    let mut v = block_on(core_id::account_status())?;
    v["deviceDid"] = json!(core_id::local_did());
    v["role"] = json!(core_id::account_did()
        .map(|d| core_id::account_local_role(&d))
        .unwrap_or_else(|| "unlinked".into()));
    v["configDir"] = json!(myco_core::config::config_dir().display().to_string());
    Ok(v)
}

pub fn cmd_account(p: &Parsed) -> Result<serde_json::Value, String> {
    match p.positional.first().map(String::as_str) {
        Some("status") | None => account_status_json(),
        Some("list") => Ok(json!({ "accounts": core_id::accounts_load_with_roles() })),
        Some("create") => {
            let name = p.flags.get("name").cloned();
            let password = p.flags.get("password").cloned();
            let phone = p.flags.get("phone").cloned();
            let email = p.flags.get("email").cloned();
            let info = if p.flags.contains_key("force") {
                block_on(core_id::account_create_ex(name, password, phone, email, true))?
            } else {
                if phone.is_some() || email.is_some() {
                    return Err("--phone/--email 只在 --force 下被服务端接收（普通 create 会丢弃）".into());
                }
                block_on(core_id::account_create(name, password, phone, email))?
            };
            Ok(json!({
                "ok": true, "rootDid": info.root_did, "deviceDid": info.device_did,
                "note": "账号已创建并登记身份服务；种子只在本机 config_dir（私钥不出 core）",
            }))
        }
        Some("import") => {
            let text = match (p.flags.get("text"), p.flags.get("file")) {
                (Some(t), _) => t.clone(),
                (None, Some(f)) => std::fs::read_to_string(f)
                    .map_err(|e| format!("读备份文件失败（{f}）: {e}"))?,
                _ => return Err("用法: account import --text <恢复码>|--file <路径> [--password P]".into()),
            };
            let password = p.flags.get("password").cloned().unwrap_or_default();
            let root_did = block_on(core_id::account_import(text.trim().to_string(), password))?;
            Ok(json!({ "ok": true, "rootDid": root_did, "note": "已恢复为具身设备；设备入册失败会响亮报错" }))
        }
        Some("login") => {
            let base = p.flags.get("base-url").cloned();
            let id = block_on(core_id::identity_register_login(base, p.flags.get("password").cloned()))?;
            Ok(json!({
                "ok": true, "did": id.did, "publicKeyB64": id.public_key_b64,
                "sessionToken": id.session_token, "sessionExpiresAt": id.session_expires_at,
                "note": "设备身份注册 + identity-svc 登录（= UI registerLogin；网页登录另见 auth 组）",
            }))
        }
        Some("unlock") => {
            let pw = p.flags.get("password").ok_or("用法: account unlock --password P")?;
            block_on(core_id::account_unlock(pw.clone()))?;
            Ok(json!({ "ok": true, "unlocked": true }))
        }
        Some("set-password") => {
            let pw = p.flags.get("password").ok_or("用法: account set-password --password P")?;
            block_on(core_id::account_set_password(pw.clone()))?;
            Ok(json!({ "ok": true, "hasPassword": true }))
        }
        Some("remove-password") => {
            let pw = p.flags.get("password").ok_or("用法: account remove-password --password P")?;
            block_on(core_id::account_remove_password(pw.clone()))?;
            Ok(json!({ "ok": true, "hasPassword": false }))
        }
        Some("switch") => {
            let did = p.flags.get("did").cloned()
                .or_else(|| p.positional.get(1).cloned())
                .ok_or("用法: account switch --did <账号did>")?;
            core_id::account_switch(did)
        }
        Some("rename") => {
            let name = p.flags.get("name").ok_or("用法: account rename --name <新名>")?;
            block_on(core_id::account_rename(name.clone()))?;
            Ok(json!({ "ok": true, "name": name }))
        }
        Some("logout") => block_on(core_id::account_logout()),
        Some("device-logout") => {
            block_on(core_id::device_logout())?;
            Ok(json!({ "ok": true, "note": "设备钥已删（本机回到未注册态）；账号/服务端名册不动" }))
        }
        Some("unbind") => {
            block_on(core_id::account_unbind())?;
            Ok(json!({ "ok": true, "note": "本机账号已解绑（种子+active+会话已删；device.key 保留）" }))
        }
        Some("discover") => {
            let run = block_on(core_id::discover_cloud_accounts_at(&base_url()));
            Ok(match run {
                core_id::CloudDiscoveryRun::Report(r) => json!({
                    "outcome": "report",
                    "joined": r.joined.iter().map(|(d, n)| json!({ "did": d, "name": n })).collect::<Vec<_>>(),
                    "alreadyListed": r.already_listed,
                    "noDelegation": r.no_delegation,
                }),
                core_id::CloudDiscoveryRun::NotOnRoster => json!({ "outcome": "notOnRoster" }),
                core_id::CloudDiscoveryRun::Unreachable => json!({ "outcome": "unreachable" }),
            })
        }
        Some("set-backed-up") => {
            block_on(core_id::account_set_backed_up())?;
            Ok(json!({ "ok": true, "backedUp": true }))
        }
        Some(other) => Err(format!(
            "未知子命令 account {other}（可用: status/list/create/import/login/unlock/set-password/remove-password/switch/rename/logout/device-logout/unbind/discover/set-backed-up）"
        )),
    }
}

// ═══════════════════════════════════════════════════════════════════════
// auth —— 网页登录深链（myco://auth）的 CLI 面
//
// 事实边界（2026-11-03 审计）：密码 / 短信验证码 / 扫码三种**登录方式本身在 youling
// 网页侧**，home UI 并无这三种输入框；myco 负责的是「出票 → 本机签名 → 回调确认」。
// 所以 CLI 的等价物是：`auth url` 出可登录地址（浏览器里完成三种方式）→ 页面唤起
// myco://auth → `auth sign --ticket` 签名 → `auth confirm` 回调。分身设备（无根钥）
// 用 `--delegated`（设备钥 + 委任状），与 UI 的三段回落链同源。
// ═══════════════════════════════════════════════════════════════════════

/// `myco-auth\n{ticket}` —— 平台登录票据的签名原文（与 UI/手机同构，改这里=改协议）。
fn auth_msg(ticket: &str) -> String {
    format!("myco-auth\n{ticket}")
}

pub fn cmd_auth(p: &Parsed) -> Result<serde_json::Value, String> {
    match p.positional.first().map(String::as_str) {
        Some("url") | None => {
            let page = p
                .flags
                .get("page")
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "https://www.youling.cc".into());
            #[cfg(feature = "gui")]
            {
                let url = block_on(crate::cli_auto_login_url(page))?;
                Ok(json!({
                    "ok": true, "url": url,
                    "note": "在浏览器打开：密码/验证码/扫码都在 youling 页面完成；登录时系统唤起 myco://auth",
                }))
            }
            #[cfg(not(feature = "gui"))]
            {
                let _ = page;
                Err("auth url 仅 GUI 构建可用（出票/签名链路随 GUI 编译）".into())
            }
        }
        Some("sign") => {
            let ticket = p.flags.get("ticket").ok_or("用法: auth sign --ticket <票据> [--delegated]")?;
            let msg = auth_msg(ticket);
            if p.flags.contains_key("delegated") {
                #[cfg(feature = "gui")]
                {
                    let v = crate::identity_service::wallet_sign_delegated(msg)?;
                    Ok(json!({ "ok": true, "mode": "delegated", "result": v,
                        "note": "设备钥签票 + 委任状随行（分身设备）；平台验链后落账 accountDid" }))
                }
                #[cfg(not(feature = "gui"))]
                Err("auth sign --delegated 仅 GUI 构建可用（委任状选链随 GUI 编译）".into())
            } else {
                let (did, seed) = require_root();
                let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
                let sig = b64e(&signing.sign(msg.as_bytes()).to_bytes());
                Ok(json!({ "ok": true, "mode": "root", "did": did, "sig": sig, "message": msg }))
            }
        }
        Some("confirm") => {
            let usage = "用法: auth confirm --url <回调地址> --ticket <票据> (--token <会话token> | --sig <签名> --did <did> [--delegation <json>])";
            let url = p.flags.get("url").ok_or(usage)?;
            let ticket = p.flags.get("ticket").ok_or(usage)?;
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err("仅支持 http(s) 回调地址".into());
            }
            #[cfg(feature = "gui")]
            {
                if let Some(token) = p.flags.get("token") {
                    let v = crate::cli_youling_auth_callback(url.clone(), ticket.clone(), token.clone())?;
                    Ok(json!({ "ok": true, "mode": "token", "result": v }))
                } else {
                    let sig = p.flags.get("sig").ok_or(usage)?;
                    let did = p.flags.get("did").ok_or(usage)?;
                    let delegation = p.flags.get("delegation").cloned();
                    let v = crate::cli_youling_auth_callback_sig(
                        url.clone(), ticket.clone(), did.clone(), sig.clone(), delegation,
                    )?;
                    Ok(json!({ "ok": true, "mode": "sig", "result": v }))
                }
            }
            #[cfg(not(feature = "gui"))]
            {
                let _ = (url, ticket);
                Err("auth confirm 仅 GUI 构建可用（回调白名单逻辑随 GUI 编译）".into())
            }
        }
        Some("session-key") => {
            #[cfg(feature = "gui")]
            {
                if p.flags.contains_key("clear") {
                    let v = crate::identity_service::session_key_clear()?;
                    return Ok(json!({ "ok": true, "cleared": v }));
                }
                if let Some(pk) = p.flags.get("pubkey") {
                    let v = crate::identity_service::session_delegation_sign(pk.clone(), Some(true))?;
                    return Ok(json!({ "ok": true, "signed": v }));
                }
                let v = crate::identity_service::session_key_status()?;
                Ok(json!({ "ok": true, "status": v }))
            }
            #[cfg(not(feature = "gui"))]
            Err("auth session-key 仅 GUI 构建可用".into())
        }
        Some(other) => Err(format!(
            "未知子命令 auth {other}（可用: url/sign/confirm/session-key）"
        )),
    }
}

// ═══════════════════════════════════════════════════════════════════════
// wallet —— 钱包/票据签名（UI wallet_sign / wallet_sign_delegated 的 CLI 面）
// ═══════════════════════════════════════════════════════════════════════

pub fn cmd_wallet(p: &Parsed) -> Result<serde_json::Value, String> {
    match p.positional.first().map(String::as_str) {
        Some("sign") | None => {
            let msg = p.flags.get("message").ok_or("用法: wallet sign --message <文本> [--delegated]")?;
            if p.flags.contains_key("delegated") {
                #[cfg(feature = "gui")]
                {
                    let v = crate::identity_service::wallet_sign_delegated(msg.clone())?;
                    Ok(json!({ "ok": true, "mode": "delegated", "result": v }))
                }
                #[cfg(not(feature = "gui"))]
                Err("wallet sign --delegated 仅 GUI 构建可用".into())
            } else {
                let (did, seed) = require_root();
                let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
                let sig = b64e(&signing.sign(msg.as_bytes()).to_bytes());
                Ok(json!({ "ok": true, "mode": "root", "did": did, "sig": sig }))
            }
        }
        Some(other) => Err(format!("未知子命令 wallet {other}（可用: sign）")),
    }
}



// ═══════════════════════════════════════════════════════════════════════
// device 扩展 —— 成员设备生命周期（2026-11-03 主线二）
//
// 与既存 device register/list/revoke/token 同一组：register=attest 上云（低层），
// add=UI「添加设备」全链（attest + 委任状投递 + P2P 收编通知）。
// 被添加方无按钮（UI 靠 20s watch_tick）——CLI 用 `device enroll` 一次到位。
// ═══════════════════════════════════════════════════════════════════════

fn cmd_device_add(p: &Parsed) -> Result<serde_json::Value, String> {
    let did = p.flags.get("did").ok_or("用法: device add --did <deviceDid> --name <名> [--owner-root-did R]")?;
    let name = p.flags.get("name").cloned().unwrap_or_else(|| "cli-device".into());
    let owner = p.flags.get("owner-root-did").cloned();
    #[cfg(feature = "gui")]
    {
        let v = block_on(crate::identity_service::add_device_by_did(did.clone(), name.clone(), owner))?;
        Ok(json!({
            "ok": true, "device": { "did": did, "name": name }, "result": v,
            "note": "attest 上云 + 委任状投递 + P2P 收编通知（= UI「添加设备」同一实现）",
        }))
    }
    #[cfg(not(feature = "gui"))]
    {
        let _ = (did, name, owner);
        Err("device add 仅 GUI 构建可用（委任状投递/P2P 通知随 GUI 编译）".into())
    }
}

/// 被添加方一键取件：名册反查 → 拉委任状 → 验签落盘（与 GUI watch_tick 同一探测实现）。
fn cmd_device_enroll(p: &Parsed) -> Result<serde_json::Value, String> {
    #[cfg(feature = "gui")]
    {
        let wait_secs: u64 = match p.flags.get("wait") {
            Some(w) => w.parse().map_err(|_| format!("--wait 须为非负整数秒，收到 {w:?}"))?,
            None => 0,
        };
        let (_dev_did, seed_b64) = core_id::device_identity()?;
        let seed = b64d(&seed_b64)?;
        let arr: [u8; 32] = seed.as_slice().try_into().map_err(|_| "设备种子长度异常（≠32B）".to_string())?;
        let pub_b64 = b64e(&ed25519_dalek::SigningKey::from_bytes(&arr).verifying_key().to_bytes());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(wait_secs);
        loop {
            let outcome = block_on(crate::identity_service::watch_probe_at(&base_url(), &pub_b64, |root| {
                core_deleg::Delegations::load().has_valid_for(root, &pub_b64)
            }))?;
            match outcome {
                crate::identity_service::WatchOutcome::Accepted { root_did, name, delegation } => {
                    core_deleg::Delegations::load().accept_received(delegation);
                    core_id::accounts_upsert(&root_did, &name);
                    return Ok(json!({
                        "ok": true, "outcome": "accepted", "rootDid": root_did, "name": name,
                        "note": "委任状已验签并落本地；`account switch --did` 可激活该账号",
                    }));
                }
                crate::identity_service::WatchOutcome::AlreadySettled { root_did } => {
                    return Ok(json!({ "ok": true, "outcome": "alreadySettled", "rootDid": root_did }));
                }
                crate::identity_service::WatchOutcome::MailboxEmpty { root_did } => {
                    if std::time::Instant::now() >= deadline {
                        return Ok(json!({
                            "ok": true, "outcome": "mailboxEmpty", "rootDid": root_did,
                            "note": "已入名册但邮箱暂无委任状；让对方重发或稍后再试（GUI 每 20s 自动重试）",
                        }));
                    }
                }
                crate::identity_service::WatchOutcome::NotOnRoster => {
                    if std::time::Instant::now() >= deadline {
                        return Ok(json!({
                            "ok": true, "outcome": "notOnRoster",
                            "note": "云名册查不到本机设备：还没被任何账号添加（让对方跑 device add）",
                        }));
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(3));
        }
    }
    #[cfg(not(feature = "gui"))]
    {
        let _ = p;
        Err("device enroll 仅 GUI 构建可用（委任状取件链随 GUI 编译）".into())
    }
}

fn cmd_device_invite() -> Result<serde_json::Value, String> {
    #[cfg(feature = "gui")]
    {
        let v = block_on(crate::identity_service::invite_start())?;
        Ok(json!({
            "ok": true, "invite": v,
            "note": "把 nonce 交给对方（二维码/文本均可）：对方投 /signal/pair 后本机 `device pair list` 可见",
        }))
    }
    #[cfg(not(feature = "gui"))]
    Err("device invite 仅 GUI 构建可用".into())
}

fn cmd_device_pair(p: &Parsed) -> Result<serde_json::Value, String> {
    let usage = "用法: device pair list | device pair confirm|reject|dismiss --did <did>";
    match p.positional.get(1).map(String::as_str) {
        None | Some("list") => {
            #[cfg(feature = "gui")]
            {
                let v = block_on(crate::identity_service::pair_requests())?;
                Ok(json!({ "ok": true, "requests": v }))
            }
            #[cfg(not(feature = "gui"))]
            Err("device pair list 仅 GUI 构建可用".into())
        }
        Some("confirm") | Some("reject") | Some("dismiss") => {
            let action = p.positional.get(1).cloned().unwrap_or_default();
            let did = p.flags.get("did").ok_or(usage)?;
            #[cfg(feature = "gui")]
            {
                let ok = match action.as_str() {
                    "confirm" => crate::identity_service::confirm_device(did.clone())?,
                    "reject" => crate::identity_service::reject_device(did.clone())?,
                    _ => crate::identity_service::pair_request_dismiss(did.clone())?,
                };
                Ok(json!({ "ok": ok, "action": action, "did": did }))
            }
            #[cfg(not(feature = "gui"))]
            {
                let _ = (action, did);
                Err("device pair 仅 GUI 构建可用".into())
            }
        }
        Some(other) => Err(format!("未知子命令 device pair {other}（可用: list/confirm/reject/dismiss）")),
    }
}

fn cmd_device_authorized(p: &Parsed) -> Result<serde_json::Value, String> {
    let sa = crate::share_auth::shared();
    match p.positional.get(1).map(String::as_str) {
        None | Some("list") => Ok(json!({ "ok": true, "devices": sa.list() })),
        Some("rename") => {
            let did = p.flags.get("did").ok_or("用法: device authorized rename --did D --name N")?;
            let name = p.flags.get("name").ok_or("用法: device authorized rename --did D --name N")?;
            Ok(json!({ "ok": sa.rename_device(did, name), "did": did }))
        }
        Some("remove") | Some("forget") => {
            let did = p.flags.get("did").ok_or("用法: device authorized remove --did D")?;
            Ok(json!({ "ok": sa.remove_device(did), "did": did,
                "note": "只删本机白名单；对方仍是账号成员，可重新配对" }))
        }
        Some(other) => Err(format!("未知子命令 device authorized {other}（可用: list/rename/remove）")),
    }
}

fn cmd_device_trusted(p: &Parsed) -> Result<serde_json::Value, String> {
    let sa = crate::share_auth::shared();
    match p.positional.get(1).map(String::as_str) {
        None | Some("list") => Ok(json!({ "ok": true, "roots": sa.list_roots() })),
        Some("rename") => {
            let did = p.flags.get("did").ok_or("用法: device trusted rename --did D --name N")?;
            let name = p.flags.get("name").ok_or("用法: device trusted rename --did D --name N")?;
            Ok(json!({ "ok": sa.rename_root(did, name), "did": did }))
        }
        Some("note") => {
            let did = p.flags.get("did").ok_or("用法: device trusted note --did D --note T")?;
            let note = p.flags.get("note").ok_or("用法: device trusted note --did D --note T")?;
            Ok(json!({ "ok": sa.set_root_note(did, note), "did": did }))
        }
        Some(other) => Err(format!("未知子命令 device trusted {other}（可用: list/rename/note）")),
    }
}

fn cmd_device_scopes(p: &Parsed) -> Result<serde_json::Value, String> {
    let did = p.flags.get("did").ok_or("用法: device scopes --did D --scopes a,b")?;
    let scopes = scopes_csv(p.flags.get("scopes"))
        .ok_or("用法: device scopes --did D --scopes a,b（空=收回全部）")?;
    let ok = crate::share_auth::shared().set_scopes(did, scopes.clone());
    Ok(json!({ "ok": ok, "did": did, "scopes": scopes }))
}

fn cmd_device_allow_deny(p: &Parsed, allow: bool) -> Result<serde_json::Value, String> {
    let did = p.flags.get("did").ok_or(if allow {
        "用法: device allow --did D [--ttl-ms N]"
    } else {
        "用法: device deny --did D"
    })?;
    let ttl = match p.flags.get("ttl-ms") {
        Some(t) => Some(t.parse::<u64>().map_err(|_| format!("--ttl-ms 须为非负整数毫秒，收到 {t:?}"))?),
        None => None,
    };
    let ok = crate::share_auth::shared().set_auth(did, allow, ttl);
    Ok(json!({ "ok": ok, "did": did, "allowed": allow, "ttlMs": ttl }))
}

fn cmd_device_origin_revoke(p: &Parsed) -> Result<serde_json::Value, String> {
    let origin = p.flags.get("origin").ok_or("用法: device origin-revoke --origin <出生地标识>")?;
    let n = crate::share_auth::shared().remove_by_origin(origin);
    Ok(json!({ "ok": true, "origin": origin, "removed": n }))
}

fn cmd_device_group() -> Result<serde_json::Value, String> {
    #[cfg(feature = "gui")]
    {
        block_on(crate::chat_service::chat_device_group_info())
    }
    #[cfg(not(feature = "gui"))]
    Err("device group 仅 GUI 构建可用".into())
}

// ═══════════════════════════════════════════════════════════════════════
// presence —— 在线态（UI 好友灯 + 本机其他设备；出向心跳由 GUI 常驻环维持，
// CLI 只读一次聚合快照，不另起心跳）
// ═══════════════════════════════════════════════════════════════════════

pub fn cmd_presence(p: &Parsed) -> Result<serde_json::Value, String> {
    #[cfg(feature = "gui")]
    {
        let v = block_on(crate::chat_service::chat_presence())?;
        if p.flags.contains_key("devices") {
            Ok(json!({ "ok": true, "devices": v.get("devices").cloned().unwrap_or(json!([])) }))
        } else if p.flags.contains_key("friends") {
            Ok(json!({ "ok": true, "friends": v.get("friends").cloned().unwrap_or(json!({})) }))
        } else {
            Ok(v)
        }
    }
    #[cfg(not(feature = "gui"))]
    {
        let _ = p;
        Err("presence 仅 GUI 构建可用（presence 心跳/聚合随 GUI 编译）".into())
    }
}

// ═══════════════════════════════════════════════════════════════════════
// task —— 任务卡（UI 任务 Tab「好友分享的任务」；chat_service 同一实现）
// ═══════════════════════════════════════════════════════════════════════

/// 任务卡清单人话（纯函数，单测覆盖）：taskId/状态/标题/来源。
#[cfg_attr(not(feature = "gui"), allow(dead_code))] // headless 变体只有 `task list` 的报错桩
fn task_list_human(tasks: &[serde_json::Value], total: usize) -> String {
    if tasks.is_empty() {
        return format!("没有任务卡（本账号共 {total} 张，默认隐藏 shared）\n");
    }
    fn status_label(s: &str) -> &'static str {
        match s {
            "pending" => "待接受",
            "todo" => "待办",
            "doing" => "进行",
            "done" => "已完成",
            "revoked" => "已撤销",
            _ => "未知",
        }
    }
    let mut out = format!("任务卡 {} 张", tasks.len());
    if total > tasks.len() {
        out.push_str(&format!("（共 {total} 张，{} 张 shared 未显示；--all 可看）", total - tasks.len()));
    }
    out.push('\n');
    for t in tasks {
        let id = t["taskId"].as_str().unwrap_or("?");
        let status = t["status"].as_str().unwrap_or("-");
        let title = t["title"].as_str().unwrap_or("（无标题）");
        let from = t["fromName"].as_str().or_else(|| t["from"].as_str()).unwrap_or("");
        let share = t["shareId"].as_str().unwrap_or("");
        out.push_str(&format!("  {id:<34} [{}] {title}", status_label(status)));
        if !from.is_empty() {
            out.push_str(&format!("  ← {from}"));
        }
        if !share.is_empty() {
            out.push_str(&format!("  (share {share})"));
        }
        out.push('\n');
    }
    out
}

fn task_list(p: &Parsed) -> Result<ShareReply, String> {
    #[cfg(feature = "gui")]
    {
        let snap = block_on(crate::chat_service::chat_poll())?;
        let all: Vec<serde_json::Value> = snap
            .get("tasks")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let show_all = p.flags.contains_key("all");
        let shown: Vec<serde_json::Value> = all
            .iter()
            .filter(|t| show_all || t.get("status").and_then(|s| s.as_str()) != Some("shared"))
            .cloned()
            .collect();
        let human = task_list_human(&shown, all.len());
        Ok(ShareReply {
            json: json!({ "ok": true, "count": shown.len(), "total": all.len(), "tasks": shown }),
            human,
        })
    }
    #[cfg(not(feature = "gui"))]
    {
        let _ = p;
        Err("task 子命令仅 GUI 构建可用（任务卡库随 chat_service 编译）".into())
    }
}

fn task_arg(p: &Parsed, flag: &str, usage: &str) -> Result<String, String> {
    p.flags
        .get(flag)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| usage.to_string())
}

/// 读出某张任务卡（走 chat_poll 同一快照——与 UI 看到的完全一致）。
#[cfg(feature = "gui")]
fn task_card_by_id(task_id: &str) -> Result<serde_json::Value, String> {
    let snap = block_on(crate::chat_service::chat_poll())?;
    snap.get("tasks")
        .and_then(|v| v.as_array())
        .and_then(|a| a.iter().find(|t| t.get("taskId").and_then(|x| x.as_str()) == Some(task_id)).cloned())
        .ok_or_else(|| format!("任务卡不存在: {task_id}（`myco cli task list --all` 看清单）"))
}

/// 主 env 选择（与 UI/Rust 同序：rdp → dsh → 声明顺序第一条）。
#[cfg_attr(not(feature = "gui"), allow(dead_code))] // headless 变体没有 task open 的 env 路径
fn primary_env_of(envs: &[serde_json::Value]) -> Option<serde_json::Value> {
    envs.iter().find(|e| e["kind"].as_str() == Some("rdp"))
        .or_else(|| envs.iter().find(|e| e["kind"].as_str() == Some("dsh")))
        .or_else(|| envs.first())
        .cloned()
}

fn task_open(p: &Parsed) -> Result<ShareReply, String> {
    #[cfg(feature = "gui")]
    {
        let task_id = task_arg(p, "task", "用法: task open --task <taskId> [--dry-run]")?;
        let card = task_card_by_id(&task_id)?;
        let mut envs: Vec<serde_json::Value> = card.get("env").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        if envs.is_empty() {
            envs = card
                .pointer("/action/env")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
        }
        if let Some(env) = primary_env_of(&envs) {
            let share_id = card.get("shareId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let caps = card.get("caps").cloned().unwrap_or(json!([]));
            let body = json!({
                "cardId": if share_id.is_empty() { task_id.clone() } else { share_id.clone() },
                "taskId": task_id,
                "env": env,
                "caps": caps,
            });
            if p.flags.contains_key("dry-run") {
                return Ok(ShareReply {
                    json: json!({ "ok": true, "dryRun": true, "request": body }),
                    human: format!("将 POST /api/env/open：\n{}\n", serde_json::to_string_pretty(&body).unwrap_or_default()),
                });
            }
            let v = share_call("POST", "/api/env/open", Some(body))?;
            let state = v["state"].as_str().unwrap_or("-");
            let addr = v["address"].as_str().unwrap_or("-");
            let note = v["message"].as_str().or_else(|| v["error"].as_str()).unwrap_or("");
            let human = format!("任务卡已打开：state={state}\n  地址   {addr}\n  {note}\n");
            return Ok(ShareReply { json: v, human });
        }
        // 无 env：open-url 只打印（不劫持浏览器；任务卡可由他人下发，scheme 白名单同 UI）
        if let Some(url) = card.pointer("/action/url").and_then(|v| v.as_str()) {
            if url.starts_with("http://") || url.starts_with("https://") || url.starts_with("myco://") {
                return Ok(ShareReply {
                    json: json!({ "ok": true, "url": url, "opened": false }),
                    human: format!("这张卡没有 env 入口，打开链接：\n  {url}\n"),
                });
            }
        }
        Err("这张任务卡没有可执行入口（无 env，也无合法 open-url）".into())
    }
    #[cfg(not(feature = "gui"))]
    {
        let _ = p;
        Err("task open 仅 GUI 构建可用".into())
    }
}

fn task_tombstone(p: &Parsed) -> Result<ShareReply, String> {
    let mut ids: Vec<String> = Vec::new();
    if let Some(t) = p.flags.get("task").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        ids.push(t.to_string());
    }
    if let Some(csv) = p.flags.get("ids") {
        for x in csv.split(',') {
            let x = x.trim();
            if !x.is_empty() && !ids.iter().any(|i| i == x) {
                ids.push(x.to_string());
            }
        }
    }
    if ids.is_empty() {
        return Err("用法: task tombstone --task <id>|--ids a,b [--reason R] [--no-broadcast]".into());
    }
    let reason = p.flags.get("reason").cloned().unwrap_or_else(|| "manual".into());
    let mut body = json!({ "taskIds": ids, "reason": reason });
    if p.flags.contains_key("no-broadcast") {
        body["broadcast"] = json!(false);
    }
    let v = share_call("POST", "/api/chat/tombstoneTasks", Some(body))?;
    let n = v["tombstoned"].as_u64().unwrap_or(0);
    let human = format!(
        "已清理任务卡：tombstoned={n}/{}（持久撤销名单，对账/重投不会复活）\n",
        ids.len()
    );
    Ok(ShareReply { json: v, human })
}

fn task_delete(p: &Parsed) -> Result<ShareReply, String> {
    let task_id = task_arg(p, "task", "用法: task delete --task <taskId>（dev 门禁：网关需 MYCO_DEV_API=1）")?;
    let v = share_call("POST", "/api/dev/deletePeerTask", Some(json!({ "taskId": task_id })))?;
    let human = format!(
        "已从本地任务库删除：{task_id}（removed={}，kept={}）\n",
        v["removed"], v["kept"]
    );
    Ok(ShareReply { json: v, human })
}

#[cfg(feature = "gui")]
fn task_youling(p: &Parsed) -> Result<ShareReply, String> {
    let want_resume = p.positional.get(1).map(String::as_str) == Some("resume");
    if want_resume {
        let v = block_on(crate::youling_tasks::youling_my_resume())?;
        let human = format!(
            "能力值/简历：{}\n",
            if v["ok"].as_bool() == Some(true) { "已拉取" } else { "暂不可用（见 JSON）" }
        );
        Ok(ShareReply { json: v, human })
    } else {
        let v = block_on(crate::youling_tasks::youling_tasks_list())?;
        let n = v
            .pointer("/data/tasks")
            .and_then(|t| t.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        let human = format!("youling 任务面：{}（tasks={n}；详情见 --json）\n",
            if v["ok"].as_bool() == Some(true) { "已拉取" } else { "暂不可用" });
        Ok(ShareReply { json: v, human })
    }
}

/// CLI/headless 变体：youling 任务/能力画像随 GUI 变体编译（tauri 命令）——明确报错。
#[cfg(not(feature = "gui"))]
fn task_youling(_p: &Parsed) -> Result<ShareReply, String> {
    Err("task youling/resume 仅 GUI 构建可用（youling_tasks 随 GUI 变体编译）".into())
}

pub fn cmd_task(p: &Parsed) -> Result<ShareReply, String> {
    match p.positional.first().map(String::as_str) {
        Some("list") | None => task_list(p),
        Some("accept") => {
            let id = task_arg(p, "task", "用法: task accept --task <taskId>")?;
            #[cfg(feature = "gui")]
            {
                let v = block_on(crate::chat_service::chat_accept_task(id.clone()))?;
                Ok(ShareReply { json: v, human: format!("已接受任务卡：{id}\n") })
            }
            #[cfg(not(feature = "gui"))]
            {
                let _ = id;
                Err("task accept 仅 GUI 构建可用".into())
            }
        }
        Some("status") => {
            let usage = "用法: task status --task <taskId> --status todo|doing|done";
            let id = task_arg(p, "task", usage)?;
            let status = task_arg(p, "status", usage)?;
            if !matches!(status.as_str(), "todo" | "doing" | "done") {
                return Err(format!("--status 只认 todo/doing/done，收到 {status:?}"));
            }
            #[cfg(feature = "gui")]
            {
                let v = block_on(crate::chat_service::chat_set_task_status(id.clone(), status.clone()))?;
                Ok(ShareReply { json: v, human: format!("任务卡状态已改：{id} → {status}\n") })
            }
            #[cfg(not(feature = "gui"))]
            {
                let _ = (id, status);
                Err("task status 仅 GUI 构建可用".into())
            }
        }
        Some("rename") => {
            let usage = "用法: task rename --task <taskId> --title <新标题>";
            let id = task_arg(p, "task", usage)?;
            let title = task_arg(p, "title", usage)?;
            #[cfg(feature = "gui")]
            {
                let v = block_on(crate::chat_service::chat_rename_task(id.clone(), title.clone()))?;
                Ok(ShareReply { json: v, human: format!("任务卡已改名：{id} → {title}\n") })
            }
            #[cfg(not(feature = "gui"))]
            {
                let _ = (id, title);
                Err("task rename 仅 GUI 构建可用".into())
            }
        }
        Some("open") => task_open(p),
        Some("tombstone") => task_tombstone(p),
        Some("delete") => task_delete(p),
        Some("youling") | Some("resume") => task_youling(p),
        Some(other) => Err(format!(
            "未知子命令 task {other}（可用: list/accept/status/rename/open/tombstone/delete/youling）"
        )),
    }
}

// ═══════════════════════════════════════════════════════════════════════
// share 扩展 —— 授权面补全（2026-11-03 主线三）
//
// 全部是「薄 HTTP 糖」：只调运行中网关的本地管理面（与 myco skill/手机同一套端点），
// 本地只做参数校验与人话组装。端点/入参以 dsh_share.rs 的 local_router 为准。
// ═══════════════════════════════════════════════════════════════════════

/// query 值百分号编码（shareId/did 里可能有 `+`/`/`，不能裸拼）。
fn pct(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

/// 生效能力四布尔 → 人话标签（只列 true 的；与 SHARE_CAP_FACES 同词表）。
fn caps_true_labels(caps: &serde_json::Value) -> Vec<&'static str> {
    SHARE_CAP_FACES
        .iter()
        .filter(|(id, _, _, _)| caps.get(*id).and_then(|b| b.as_bool()) == Some(true))
        .map(|(_, label, _, _)| *label)
        .collect()
}

/// `share grants` 人话（纯函数，单测覆盖）：协作者 + 生效能力 + 可见范围 + 转授。
fn share_grants_human(v: &serde_json::Value, share_id: &str) -> String {
    let cols = v["collaborators"].as_array().cloned().unwrap_or_default();
    if cols.is_empty() {
        return format!("分享 {share_id} 没有协作者\n");
    }
    let mut out = format!("分享 {share_id} 的协作者 {} 人\n", cols.len());
    for c in &cols {
        let name = c["name"].as_str().unwrap_or("?");
        let owner = c["isOwner"].as_bool() == Some(true);
        let labels = caps_true_labels(&c["caps"]);
        let caps = if labels.is_empty() { "（无）".to_string() } else { labels.join("、") };
        let vis = share_vis_human(&json!({ "stateVisibility": c["visibility"] }));
        let reshare = if owner {
            "—（owner）".to_string()
        } else if c["canReshare"].as_bool() == Some(true) {
            match c["reshareExp"].as_u64() {
                Some(0) | None => "可转授".to_string(),
                Some(exp) => format!("可转授（至 {exp}ms）"),
            }
        } else {
            "不可转授".to_string()
        };
        let override_note = if c.get("visibilityOverride").map(|x| !x.is_null()).unwrap_or(false) {
            "（逐人覆盖）"
        } else {
            ""
        };
        let tail = c["did"]
            .as_str()
            .map(|d| {
                let chars: Vec<char> = d.chars().collect();
                let start = chars.len().saturating_sub(8);
                format!("({}) ", chars[start..].iter().collect::<String>())
            })
            .unwrap_or_default();
        out.push_str(&format!(
            "  {} {name} {tail}\n",
            if owner { "★" } else { "•" },
        ));
        out.push_str(&format!("      能力: {caps}\n      可见: {vis}{override_note}\n      转授: {reshare}\n"));
    }
    out
}

fn share_grants_cmd(p: &Parsed) -> Result<ShareReply, String> {
    let sid = p.flags.get("share").ok_or("用法: share grants --share <id>")?;
    let v = share_call("GET", &format!("/api/dshShare/grants?shareId={}", pct(sid)), None)?;
    let human = share_grants_human(&v, sid);
    Ok(ShareReply { json: v, human })
}

fn share_caps_cmd(p: &Parsed) -> Result<ShareReply, String> {
    let usage = "用法: share caps --share <id> --caps session.read,session.input";
    let sid = p.flags.get("share").ok_or(usage)?;
    let caps = share_caps_decl(p.flags.get("caps").ok_or(usage)?)?;
    let v = share_call("POST", "/api/dshShare/caps", Some(json!({ "shareId": sid, "caps": caps })))?;
    let labels = share_caps_labels(&v["caps"]);
    let human = format!(
        "任务级能力已覆盖：{sid}\n  能力  {}\n",
        if labels.is_empty() { "（空=全关）".to_string() } else { labels.join("、") }
    );
    Ok(ShareReply { json: v, human })
}

fn share_grant_caps_cmd(p: &Parsed) -> Result<ShareReply, String> {
    let usage = "用法: share grant-caps --share <id> --did <did> --caps session.read,session.input";
    let sid = p.flags.get("share").ok_or(usage)?;
    let did = p.flags.get("did").ok_or(usage)?;
    let flags = share_caps_flags(p.flags.get("caps").ok_or(usage)?)?;
    let v = share_call(
        "POST",
        "/api/dshShare/grantCaps",
        Some(json!({ "shareId": sid, "did": did, "caps": flags })),
    )?;
    let labels = caps_true_labels(&v["caps"]);
    let human = format!(
        "逐人能力已更新：{did}\n  生效  {}\n",
        if labels.is_empty() { "（全关）".to_string() } else { labels.join("、") }
    );
    Ok(ShareReply { json: v, human })
}

fn share_revoke_all_cmd(p: &Parsed) -> Result<ShareReply, String> {
    let sid = p.flags.get("share").ok_or("用法: share revoke-all --share <id>")?;
    let v = share_call("POST", "/api/dshShare/revokeAllGrants", Some(json!({ "shareId": sid })))?;
    let human = format!(
        "已收回全部协作者授权：{sid}（revoked={}，owner 行保留）\n  提示 HTTP 面不额外通知对端删卡（已知分裂；对端下次状态同步即失效）\n",
        v["revoked"]
    );
    Ok(ShareReply { json: v, human })
}

fn share_requests_cmd(p: &Parsed) -> Result<ShareReply, String> {
    let sid = p.flags.get("share").cloned();
    let v = share_call("GET", "/api/dshShare/list", None)?;
    let mut reqs: Vec<serde_json::Value> = v["pendingRequests"].as_array().cloned().unwrap_or_default();
    if let Some(s) = &sid {
        reqs.retain(|r| r["shareId"].as_str() == Some(s.as_str()));
    }
    let human = if reqs.is_empty() {
        "没有待批申请\n".to_string()
    } else {
        let mut out = format!("待批申请 {} 条\n", reqs.len());
        for r in &reqs {
            out.push_str(&format!(
                "  {}  share={}  {}（{}）want={}\n",
                r["reqId"].as_str().unwrap_or("?"),
                r["shareId"].as_str().unwrap_or("?"),
                r["label"].as_str().or_else(|| r["did"].as_str()).unwrap_or("?"),
                r["did"].as_str().unwrap_or(""),
                r["want"].as_str().unwrap_or("?"),
            ));
        }
        out
    };
    Ok(ShareReply { json: json!({ "ok": true, "count": reqs.len(), "requests": reqs }), human })
}

fn share_req_decide_cmd(p: &Parsed) -> Result<ShareReply, String> {
    let usage = "用法: share req-decide --request <reqId> (--approve|--deny) [--remember]";
    let req = p.flags.get("request").ok_or(usage)?;
    let approve = if p.flags.contains_key("approve") {
        true
    } else if p.flags.contains_key("deny") {
        false
    } else {
        return Err(usage.into());
    };
    let body = json!({
        "reqId": req,
        "approve": approve,
        "remember": p.flags.contains_key("remember"),
    });
    let v = share_call("POST", "/api/dshShare/reqDecide", Some(body))?;
    let human = format!("申请 {req} 已{}（{}）\n", if approve { "批准" } else { "驳回" }, v["want"].as_str().unwrap_or("-"));
    Ok(ShareReply { json: v, human })
}

fn share_reshare_list_cmd(p: &Parsed) -> Result<ShareReply, String> {
    let path = match p.flags.get("share").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(sid) => format!("/api/dshShare/reshareRequests?shareId={}", pct(sid)),
        None => "/api/dshShare/reshareRequests".to_string(),
    };
    let v = share_call("GET", &path, None)?;
    let reqs = v["requests"].as_array().cloned().unwrap_or_default();
    let human = if reqs.is_empty() {
        "没有待批准的转授申请\n".to_string()
    } else {
        let mut out = format!("待批准转授申请 {} 条\n", reqs.len());
        for r in &reqs {
            out.push_str(&format!(
                "  {}  share={}  {} → {}\n",
                r["requestId"].as_str().unwrap_or("?"),
                r["shareId"].as_str().unwrap_or("?"),
                r["requesterName"].as_str().or_else(|| r["requesterDid"].as_str()).unwrap_or("?"),
                r["targetName"].as_str().or_else(|| r["targetDid"].as_str()).unwrap_or("?"),
            ));
        }
        out
    };
    Ok(ShareReply { json: v, human })
}

fn share_reshare_decide_cmd(p: &Parsed) -> Result<ShareReply, String> {
    let usage = "用法: share reshare-decide --share <id> --request <requestId> (--approve|--deny) [--remember]";
    let sid = p.flags.get("share").ok_or(usage)?;
    let rid = p.flags.get("request").ok_or(usage)?;
    let approve = if p.flags.contains_key("approve") {
        true
    } else if p.flags.contains_key("deny") {
        false
    } else {
        return Err(usage.into());
    };
    let body = json!({
        "shareId": sid, "requestId": rid, "approve": approve,
        "remember": p.flags.contains_key("remember"),
    });
    let v = share_call("POST", "/api/dshShare/reshareDecide", Some(body))?;
    let human = format!("转授申请 {rid} 已{}\n", if approve { "批准" } else { "驳回" });
    Ok(ShareReply { json: v, human })
}

fn share_can_reshare_cmd(p: &Parsed) -> Result<ShareReply, String> {
    let sid = p.flags.get("share").ok_or("用法: share can-reshare --share <id> [--did D (--on|--off) | --all (--on|--off)]")?;
    let want = if p.flags.contains_key("on") {
        Some(true)
    } else if p.flags.contains_key("off") {
        Some(false)
    } else {
        None
    };
    if let Some(on) = want {
        if p.flags.contains_key("all") {
            let g = share_call("GET", &format!("/api/dshShare/grants?shareId={}", pct(sid)), None)?;
            let mut changed: Vec<serde_json::Value> = Vec::new();
            for c in g["collaborators"].as_array().cloned().unwrap_or_default() {
                if c["isOwner"].as_bool() == Some(true) {
                    continue;
                }
                let Some(did) = c["did"].as_str() else { continue };
                let v = share_call(
                    "POST",
                    "/api/dshShare/canReshare",
                    Some(json!({ "shareId": sid, "did": did, "on": on })),
                )?;
                changed.push(v);
            }
            let human = format!("已{}全部协作者的转授权：{sid}（{} 人）\n", if on { "开启" } else { "关闭" }, changed.len());
            return Ok(ShareReply { json: json!({ "ok": true, "shareId": sid, "canReshare": on, "changed": changed }), human });
        }
        let did = p.flags.get("did").ok_or("用法: share can-reshare --share <id> --did D (--on|--off)")?;
        let v = share_call(
            "POST",
            "/api/dshShare/canReshare",
            Some(json!({ "shareId": sid, "did": did, "on": on })),
        )?;
        let human = format!("已{} {did} 的转授权（{sid}）\n", if on { "开启" } else { "关闭" });
        return Ok(ShareReply { json: v, human });
    }
    let g = share_call("GET", &format!("/api/dshShare/grants?shareId={}", pct(sid)), None)?;
    let mut lines = String::new();
    let mut n = 0;
    for c in g["collaborators"].as_array().cloned().unwrap_or_default() {
        if c["isOwner"].as_bool() == Some(true) {
            continue;
        }
        n += 1;
        lines.push_str(&format!(
            "  {}  {}\n",
            c["name"].as_str().unwrap_or("?"),
            if c["canReshare"].as_bool() == Some(true) { "可转授" } else { "不可转授" },
        ));
    }
    if n == 0 {
        lines.push_str("  （无协作者）\n");
    }
    Ok(ShareReply {
        json: g,
        human: format!("分享 {sid} 的转授权限：\n{lines}"),
    })
}

fn share_perm_cmd(p: &Parsed) -> Result<ShareReply, String> {
    let usage = "用法: share perm --share <id> --did D [--read|--no-read] [--write|--no-write] [--window-ms N|--window-full]";
    let sid = p.flags.get("share").ok_or(usage)?;
    let did = p.flags.get("did").ok_or(usage)?;
    let read = if p.flags.contains_key("read") {
        Some(true)
    } else if p.flags.contains_key("no-read") {
        Some(false)
    } else {
        None
    };
    let write = if p.flags.contains_key("write") {
        Some(true)
    } else if p.flags.contains_key("no-write") {
        Some(false)
    } else {
        None
    };
    if read.is_none() && write.is_none() && !p.flags.contains_key("window-ms") && !p.flags.contains_key("window-full") {
        return Err(usage.into());
    }
    let mut body = json!({ "shareId": sid, "did": did });
    if let Some(r) = read {
        body["read"] = json!(r);
    }
    if let Some(w) = write {
        body["write"] = json!(w);
    }
    if p.flags.contains_key("window-full") {
        body["windowMs"] = serde_json::Value::Null;
    } else if let Some(w) = p.flags.get("window-ms") {
        let ms: u64 = w.parse().map_err(|_| format!("--window-ms 须为非负整数毫秒，收到 {w:?}"))?;
        body["windowMs"] = json!(ms);
    }
    let v = share_call("POST", "/api/dshShare/perm", Some(body))?;
    let human = format!(
        "已更新实时权限：{did} @ {sid}\n  读={} 写={} 窗口={}\n",
        read.map(|r| r.to_string()).unwrap_or_else(|| "不动".into()),
        write.map(|w| w.to_string()).unwrap_or_else(|| "不动".into()),
        if p.flags.contains_key("window-full") {
            "全量".into()
        } else {
            p.flags.get("window-ms").cloned().unwrap_or_else(|| "不动".into())
        },
    );
    Ok(ShareReply { json: v, human })
}

fn share_state_cmd(p: &Parsed, action: &str) -> Result<ShareReply, String> {
    let sid = p.flags.get("share").ok_or(format!("用法: share {action} --share <id>"))?;
    let v = share_call("POST", &format!("/api/dshShare/{action}"), Some(json!({ "shareId": sid })))?;
    let human = match action {
        "suspend" => format!("已暂停分享：{sid}（全员只读，state=suspended）\n"),
        "resume" => format!("已恢复分享：{sid}（state=active）\n"),
        "complete" => format!("已标记任务完成：{sid}（state=closed；任务卡同步标 done）\n"),
        "kill" => format!("已杀掉分享实例：{sid}（分享记录保留，下次打开会重启）\n"),
        other => format!("已执行 share {other}：{sid}\n"),
    };
    Ok(ShareReply { json: v, human })
}

/// 本地现签 owner 入口（302 的 Location）；不跟随重定向。
fn share_open_location(share_id: &str) -> Result<String, String> {
    let base = share_api_base();
    let url = format!("{base}/api/dshShare/open?shareId={}", pct(share_id));
    let http = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("HTTP 客户端构造失败: {e}"))?;
    let resp = http.get(&url).send().map_err(|e| {
        if e.is_connect() {
            format!("{SHARE_DOWN_HINT}（管理面 {base} 连不上）")
        } else {
            format!("打开请求失败: {e}")
        }
    })?;
    let status = resp.status();
    if status.is_redirection() {
        if let Some(loc) = resp.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()) {
            return Ok(loc.to_string());
        }
        return Err(format!("分享入口 302 但缺 Location（HTTP {status}）"));
    }
    let text = resp.text().unwrap_or_default();
    let head: String = text.trim().chars().take(200).collect();
    Err(format!("打开分享失败（HTTP {status}）：{head}"))
}

fn share_open_cmd(p: &Parsed) -> Result<ShareReply, String> {
    let sid = p.flags.get("share").ok_or("用法: share open --share <id>")?;
    let url = share_open_location(sid)?;
    let human = format!("分享入口（本机现签，点开即进）：\n  {url}\n");
    Ok(ShareReply { json: json!({ "ok": true, "shareId": sid, "url": url }), human })
}

fn share_task_group_cmd(p: &Parsed) -> Result<ShareReply, String> {
    let sid = p.flags.get("share").ok_or("用法: share task-group --share <id>")?;
    let v = share_call("GET", &format!("/api/dshShare/taskGroup?shareId={}", pct(sid)), None)?;
    let members = v["members"].as_array().map(|a| a.len()).unwrap_or(0);
    let human = format!(
        "任务群：{}\n  成员 {} 人\n",
        v["groupId"].as_str().unwrap_or("-"),
        members
    );
    Ok(ShareReply { json: v, human })
}

fn share_ensure_group_cmd(p: &Parsed) -> Result<ShareReply, String> {
    let sid = p.flags.get("share").ok_or("用法: share ensure-group --share <id>")?;
    let v = share_call("POST", "/api/dshShare/ensureGroup", Some(json!({ "shareId": sid })))?;
    let human = format!("任务群已就绪：{}\n", v["groupId"].as_str().unwrap_or("-"));
    Ok(ShareReply { json: v, human })
}

fn share_sessions_cmd(p: &Parsed) -> Result<ShareReply, String> {
    let path = match p.flags.get("share").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(sid) => format!("/api/dshShare/sessions?shareId={}", pct(sid)),
        None => "/api/dshShare/sessions".to_string(),
    };
    let v = share_call("GET", &path, None)?;
    let list = v["sessions"].as_array().cloned().unwrap_or_default();
    let mut human = format!(
        "可授权会话 {} 条（共 {}，truncated={}）\n",
        list.len(),
        v["total"].as_u64().unwrap_or(0),
        v["truncated"].as_bool().unwrap_or(false)
    );
    for s in list.iter().take(30) {
        human.push_str(&format!(
            "  {:<40} {}\n",
            s["sessionId"].as_str().unwrap_or("?"),
            s["label"].as_str().unwrap_or("")
        ));
    }
    if list.len() > 30 {
        human.push_str(&format!("  …其余 {} 条用 --json 看\n", list.len() - 30));
    }
    Ok(ShareReply { json: v, human })
}

fn share_capabilities_cmd(p: &Parsed) -> Result<ShareReply, String> {
    let path = match p.flags.get("share").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(sid) => format!("/api/dshShare/capabilityCatalog?shareId={}", pct(sid)),
        None => "/api/dshShare/capabilityCatalog".to_string(),
    };
    let v = share_call("GET", &path, None)?;
    let caps = v["capabilities"].as_array().cloned().unwrap_or_default();
    let mut human = format!("能力目录 {} 项（source={}）\n", caps.len(), v["source"].as_str().unwrap_or("-"));
    for c in caps {
        human.push_str(&format!(
            "  {:<14} {:<28} {}\n",
            c["id"].as_str().unwrap_or("?"),
            c["label"].as_str().unwrap_or(""),
            c["direction"].as_str().unwrap_or(""),
        ));
    }
    Ok(ShareReply { json: v, human })
}

fn share_events_cmd(p: &Parsed) -> Result<ShareReply, String> {
    let mut path = String::from("/api/dshShare/events");
    let mut sep = '?';
    if let Some(sid) = p.flags.get("share").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        path.push_str(&format!("{sep}shareId={}", pct(sid)));
        sep = '&';
    }
    if let Some(ms) = p.flags.get("since-ms") {
        let ms: u64 = ms.parse().map_err(|_| format!("--since-ms 须为非负整数毫秒，收到 {ms:?}"))?;
        path.push_str(&format!("{sep}sinceMs={ms}"));
    }
    let v = share_call("GET", &path, None)?;
    let events = v["events"].as_array().cloned().unwrap_or_default();
    let mut human = format!("事件 {} 条\n", events.len());
    for e in events.iter().rev().take(40).rev() {
        human.push_str(&format!(
            "  {:<22} share={} task={}\n",
            e["type"].as_str().unwrap_or("?"),
            e["shareId"].as_str().or_else(|| e["share"].as_str()).unwrap_or("?"),
            e["taskId"].as_str().unwrap_or(""),
        ));
    }
    Ok(ShareReply { json: v, human })
}

fn share_publish_cmd(p: &Parsed) -> Result<ShareReply, String> {
    let usage = "用法: share publish --share <id> --goal G [--sla S] [--reward R]";
    let sid = p.flags.get("share").ok_or(usage)?;
    let goal = p.flags.get("goal").ok_or(usage)?;
    let mut card = share_task_card(p).ok_or(usage)?;
    // 人话与请求体都用同一条 goal（share_task_card 已带 goal；这里显式覆盖=防未来改动漂移）
    card["goal"] = json!(goal);
    let v = share_call("POST", "/api/dshShare/publish", Some(json!({ "shareId": sid, "taskCard": card })))?;
    let human = format!("已发布为公共任务：{sid}（listing=public）\n");
    Ok(ShareReply { json: v, human })
}

// ═══════════════════════════════════════════════════════════════════════
// env / vnet —— 任务卡环境入口 + 虚拟组网转发（2026-11-03 主线五）
//
// 与 share 段同一纪律：只调运行中网关的本地管理面。
// **为什么必须走 HTTP 而不是进程内调用**：隧道/租约/客户端进程都活在常驻 GUI 进程里，
// CLI 是一次性进程——本进程内开的隧道会随退出一起死（这正是 /api/env/open、
// /api/vnet/* 存在的理由：让外部调用方驱动常驻进程）。
// ═══════════════════════════════════════════════════════════════════════

/// 本地管理面调用（与 share_call 同一实现；非分享路由用这个别名表达意图）。
fn local_call(method: &str, path: &str, body: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    share_call(method, path, body)
}

fn flag_u16(p: &Parsed, key: &str) -> Result<Option<u16>, String> {
    match p.flags.get(key) {
        Some(s) => {
            let n: u16 = s.parse().map_err(|_| format!("--{key} 须为 1..65535 的端口号，收到 {s:?}"))?;
            if n == 0 {
                return Err(format!("--{key} 不能是 0"));
            }
            Ok(Some(n))
        }
        None => Ok(None),
    }
}

pub fn cmd_env(p: &Parsed) -> Result<serde_json::Value, String> {
    match p.positional.first().map(String::as_str) {
        Some("kinds") | None => Ok(json!({ "ok": true, "kinds": crate::vnet_env::ENV_KINDS })),
        Some("open") => {
            let usage = "用法: env open --kind rdp|dsh|ssh|http|stereo|adb|vnc|rustdesk --device <did> [--port P] [--local-port P] [--label L] [--entry-url U] [--card-id S] [--task-id T]";
            let kind = p.flags.get("kind").ok_or(usage)?.trim().to_ascii_lowercase();
            if !crate::vnet_env::is_known_kind(&kind) {
                return Err(format!(
                    "不支持的 --kind {kind:?}（白名单: {}）",
                    crate::vnet_env::ENV_KINDS.join("|")
                ));
            }
            let device = p.flags.get("device").ok_or(usage)?.trim().to_string();
            if !device.starts_with("did:") {
                return Err("--device 须为目标设备 DID（did: 前缀）".into());
            }
            let mut env = json!({ "kind": kind, "device": device });
            if let Some(port) = flag_u16(p, "port")? {
                env["port"] = json!(port);
            }
            if let Some(lp) = flag_u16(p, "local-port")? {
                env["localPort"] = json!(lp);
            }
            if let Some(l) = p.flags.get("label").map(|s| s.trim()).filter(|s| !s.is_empty()) {
                env["label"] = json!(l);
            }
            if let Some(u) = p.flags.get("entry-url").map(|s| s.trim()).filter(|s| !s.is_empty()) {
                env["entryUrl"] = json!(u);
            }
            let mut body = json!({ "env": env, "caps": [crate::vnet_env::CAP_VNET_FORWARD] });
            if let Some(c) = p.flags.get("card-id").map(|s| s.trim()).filter(|s| !s.is_empty()) {
                body["cardId"] = json!(c);
            }
            if let Some(t) = p.flags.get("task-id").map(|s| s.trim()).filter(|s| !s.is_empty()) {
                body["taskId"] = json!(t);
            }
            local_call("POST", "/api/env/open", Some(body))
        }
        Some(other) => Err(format!("未知子命令 env {other}（可用: kinds/open）")),
    }
}

pub fn cmd_vnet(p: &Parsed) -> Result<serde_json::Value, String> {
    let usage = "用法: vnet status|forwards|leases|netstate|ports|mdns|diag|peers|relay|stun|watch | \
vnet forward|keep|unkeep|close --device D --port P | vnet rdp --device D [--port 3389] | \
vnet tune [--batch N] [--disable-ipv6 on|off] | vnet allow-ports [--add a,b] [--remove a,b]";
    match p.positional.first().map(String::as_str) {
        Some("status") => local_call("GET", "/api/vnet/status", None),
        Some("forwards") => local_call("GET", "/api/vnet/forwards", None),
        Some("leases") => local_call("GET", "/api/vnet/leases", None),
        Some("netstate") => local_call("GET", "/api/vnet/netstate", None),
        Some("ports") => local_call("GET", "/api/vnet/ports", None),
        Some("mdns") => local_call("GET", "/api/vnet/mdns", None),
        Some("diag") => local_call("GET", "/api/vnet/diag", None),
        // ── 2026-11-06 观测面（原始 vnet 能力，vnet.exe 的镜像）──
        Some("peers") => {
            let mut v = local_call("GET", "/api/vnet/peers", None)?;
            // --names off：机器消费时去掉展示名（契约以 device DID 为键）
            if p.flags.contains_key("names-off") || p.flags.get("names").map(|s| s.trim() == "off").unwrap_or(false) {
                if let Some(arr) = v.get_mut("peers").and_then(|x| x.as_array_mut()) {
                    for it in arr.iter_mut() {
                        if let Some(o) = it.as_object_mut() {
                            o.remove("name");
                        }
                    }
                }
            }
            Ok(v)
        }
        Some("relay") => local_call("GET", "/api/vnet/relay", None),
        Some("stun") => local_call("GET", "/api/vnet/stun", None),
        Some("watch") => cmd_vnet_watch(p),
        Some("forward") | Some("keep") | Some("unkeep") | Some("close") => {
            let action = p.positional[0].clone();
            let device = p.flags.get("device").ok_or(usage)?.trim().to_string();
            if !device.starts_with("did:") {
                return Err("--device 须为目标设备 DID（did: 前缀）".into());
            }
            let port = flag_u16(p, "port")?.ok_or("缺 --port（目标设备端口）")?;
            let mut body = json!({ "device": device, "port": port });
            if action == "forward" || action == "keep" {
                if let Some(lp) = flag_u16(p, "local-port")? {
                    body["localPort"] = json!(lp);
                }
                if let Some(l) = p.flags.get("label").map(|s| s.trim()).filter(|s| !s.is_empty()) {
                    body["label"] = json!(l);
                }
            }
            local_call("POST", &format!("/api/vnet/{action}"), Some(body))
        }
        Some("rdp") => {
            let mut body = json!({});
            if let Some(d) = p.flags.get("device").map(|s| s.trim()).filter(|s| !s.is_empty()) {
                body["device"] = json!(d);
            }
            if let Some(port) = flag_u16(p, "port")? {
                body["port"] = json!(port);
            }
            if let Some(lp) = flag_u16(p, "local-port")? {
                body["localPort"] = json!(lp);
            }
            if let Some(u) = p.flags.get("user").map(|s| s.trim()).filter(|s| !s.is_empty()) {
                body["user"] = json!(u);
            }
            if p.flags.contains_key("no-launch") {
                body["noLaunch"] = json!(true);
            }
            local_call("POST", "/api/vnet/rdp", Some(body))
        }
        Some("tune") => {
            if !p.flags.contains_key("batch") && !p.flags.contains_key("disable-ipv6") {
                return local_call("GET", "/api/vnet/tune", None);
            }
            let mut body = json!({});
            if let Some(b) = p.flags.get("batch") {
                let n: u64 = b.parse().map_err(|_| format!("--batch 须为 1..=64 的整数，收到 {b:?}"))?;
                if !(1..=64).contains(&n) {
                    return Err(format!("--batch 只认 1..=64，收到 {n}"));
                }
                body["batch"] = json!(n);
            }
            if let Some(v) = p.flags.get("disable-ipv6") {
                let on = match v.trim() {
                    "1" | "on" | "true" | "yes" => true,
                    "0" | "off" | "false" | "no" => false,
                    other => return Err(format!("--disable-ipv6 只认 on/off，收到 {other:?}")),
                };
                body["disableIpv6"] = json!(on);
            }
            local_call("POST", "/api/vnet/tune", Some(body))
        }
        Some("allow-ports") => {
            if !p.flags.contains_key("add") && !p.flags.contains_key("remove") {
                return local_call("GET", "/api/vnet/allowPorts", None);
            }
            let split = |v: &String| -> Vec<u16> {
                v.split(',').filter_map(|x| x.trim().parse::<u16>().ok()).filter(|p| *p > 0).collect()
            };
            let mut body = json!({});
            if let Some(a) = p.flags.get("add") {
                body["add"] = json!(split(a));
            }
            if let Some(r) = p.flags.get("remove") {
                body["remove"] = json!(split(r));
            }
            local_call("POST", "/api/vnet/allowPorts", Some(body))
        }
        _ => Err(usage.into()),
    }
}

// ─── 2026-11-06 vnet 观测面：人话渲染 + watch ───

/// 设备 DID 短尾（人读用；契约仍以完整 DID 为键）。
fn did_tail(d: &str, n: usize) -> String {
    let chars: Vec<char> = d.chars().collect();
    let start = chars.len().saturating_sub(n);
    format!("…{}", chars[start..].iter().collect::<String>())
}

/// 解析 `--interval`：`500ms` / `1s` / 裸数字=秒。
fn parse_interval_ms(s: &str) -> Result<u64, String> {
    let t = s.trim();
    let parse = |x: &str| -> Result<u64, String> {
        x.trim()
            .parse::<u64>()
            .map_err(|_| format!("--interval 须形如 500ms / 1s / 2（收到 {s:?}）"))
    };
    if let Some(x) = t.strip_suffix("ms") {
        Ok(parse(x)?.max(100))
    } else if let Some(x) = t.strip_suffix('s') {
        Ok((parse(x)? * 1000).max(100))
    } else {
        Ok((parse(t)? * 1000).max(100))
    }
}

fn flag_names_off(p: &Parsed) -> bool {
    p.flags.contains_key("names-off") || p.flags.get("names").map(|s| s.trim() == "off").unwrap_or(false)
}

/// `vnet watch`：按间隔反复拉 peers+relay。`--count N` 到时退出，默认一直看。
fn cmd_vnet_watch(p: &Parsed) -> Result<serde_json::Value, String> {
    let every = p
        .flags
        .get("interval")
        .map(|s| parse_interval_ms(s))
        .transpose()?
        .unwrap_or(1000);
    let count: u64 = p
        .flags
        .get("count")
        .map(|s| s.parse::<u64>().map_err(|_| format!("--count 须为整数，收到 {s:?}")))
        .transpose()?
        .unwrap_or(0);
    let json = p.flags.contains_key("json");
    let mut tick = 0u64;
    loop {
        tick += 1;
        let peers = local_call("GET", "/api/vnet/peers", None)?;
        let relay = local_call("GET", "/api/vnet/relay", None)?;
        if json {
            println!(
                "{}",
                serde_json::to_string(&json!({ "ts": now_ms(), "peers": peers, "relay": relay }))
                    .unwrap_or_default()
            );
        } else {
            print!("{}", vnet_watch_text(tick, &peers, &relay));
            use std::io::Write as _;
            let _ = std::io::stdout().flush();
        }
        if count > 0 && tick >= count {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(every));
    }
    Ok(json!({ "ok": true, "ticks": tick }))
}

fn vnet_watch_text(tick: u64, peers: &serde_json::Value, relay: &serde_json::Value) -> String {
    let mut s = String::new();
    let list = peers.get("peers").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let out_n = list.iter().filter(|p| p.get("direction").and_then(|d| d.as_str()) == Some("out")).count();
    let in_n = list.len().saturating_sub(out_n);
    let neg = relay.get("negativeCache").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    let bh = relay.get("blackholes").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    s.push_str(&format!(
        "[{tick}] peers out={out_n} in={in_n} · negativeCache={neg} blackholes={bh}\n"
    ));
    for p in &list {
        let dir = p.get("direction").and_then(|x| x.as_str()).unwrap_or("?");
        let dev = p
            .get("device")
            .and_then(|x| x.as_str())
            .map(|d| did_tail(d, 6))
            .unwrap_or_else(|| "(in)".into());
        let name = p.get("name").and_then(|x| x.as_str()).unwrap_or("");
        let path = p.get("path").and_then(|x| x.as_str()).unwrap_or("-");
        let rtt = p.get("rttMs").and_then(|x| x.as_u64()).map(|v| format!("{v}ms")).unwrap_or("-".into());
        s.push_str(&format!("    {dir:<3} {dev:<10} {name:<16} path={path:<10} rtt={rtt}\n"));
    }
    s
}

fn vnet_peers_text(v: &serde_json::Value) -> String {
    let mut s = String::new();
    let list = v.get("peers").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    s.push_str(&format!("peers（schema {}，共 {} 条）\n", v.get("schema").and_then(|x| x.as_u64()).unwrap_or(0), list.len()));
    for p in &list {
        let dir = p.get("direction").and_then(|x| x.as_str()).unwrap_or("?");
        let dev = p.get("device").and_then(|x| x.as_str()).map(|d| did_tail(d, 6)).unwrap_or_else(|| "(未知)".into());
        let name = p.get("name").and_then(|x| x.as_str()).unwrap_or("");
        let path = p.get("path").and_then(|x| x.as_str()).unwrap_or("-");
        let rtt = p.get("rttMs").and_then(|x| x.as_u64()).map(|x| format!("{x}ms")).unwrap_or_else(|| "-".into());
        let pr = p.get("probeRounds").and_then(|x| x.as_u64()).unwrap_or(0);
        let req = p.get("probeReqRx").and_then(|x| x.as_u64());
        let rep = p.get("probeReplyRx").and_then(|x| x.as_u64());
        let local = p.get("localPort").and_then(|x| x.as_u64()).map(|x| x.to_string()).unwrap_or_else(|| "-".into());
        let target = p.get("targetPort").and_then(|x| x.as_u64()).map(|x| x.to_string()).unwrap_or_else(|| "-".into());
        let backoff = p.get("backoff").and_then(|x| x.as_bool()).unwrap_or(false);
        let probe = match (req, rep) {
            (Some(a), Some(b)) => format!("{a}↔{b}"),
            _ => "-".into(),
        };
        s.push_str(&format!(
            "  {dir:<3} {dev:<9} {name:<16} path={path:<10} rtt={rtt:<7} probes={pr:<5} {probe:<9} {local}→{target}{}\n",
            if backoff { "  [负缓存]" } else { "" }
        ));
    }
    if let Some(live) = v.get("liveInbound").and_then(|x| x.as_array()) {
        if !live.is_empty() {
            s.push_str("  实时入站：\n");
            for l in live {
                s.push_str(&format!(
                    "    {} age={}ms\n",
                    l.get("addr").and_then(|x| x.as_str()).unwrap_or("?"),
                    l.get("ageMs").and_then(|x| x.as_u64()).unwrap_or(0)
                ));
            }
        }
    }
    s
}

fn vnet_relay_text(v: &serde_json::Value) -> String {
    let mut s = String::new();
    s.push_str(&format!("relay = {}\n", v.get("relay").and_then(|x| x.as_str()).unwrap_or("-")));
    if let Some(cl) = v.get("clients").and_then(|x| x.as_array()) {
        s.push_str(&format!("clients（{}）：\n", cl.len()));
        for c in cl {
            s.push_str(&format!(
                "  {} port={} local={} path={} alive={}\n",
                c.get("device").and_then(|x| x.as_str()).map(|d| did_tail(d, 6)).unwrap_or_default(),
                c.get("targetPort").and_then(|x| x.as_u64()).unwrap_or(0),
                c.get("localPort").and_then(|x| x.as_u64()).unwrap_or(0),
                c.get("path").and_then(|x| x.as_str()).unwrap_or("-"),
                c.get("alive").and_then(|x| x.as_bool()).unwrap_or(false)
            ));
        }
    }
    if let Some(neg) = v.get("negativeCache").and_then(|x| x.as_array()) {
        s.push_str(&format!("negativeCache（{}）：\n", neg.len()));
        for n in neg {
            s.push_str(&format!(
                "  {} port={} scope={} 剩余 {}ms\n",
                n.get("device").and_then(|x| x.as_str()).map(|d| did_tail(d, 6)).unwrap_or_default(),
                n.get("port").and_then(|x| x.as_u64()).unwrap_or(0),
                n.get("scope").and_then(|x| x.as_str()).unwrap_or("?"),
                n.get("remainingMs").and_then(|x| x.as_u64()).unwrap_or(0)
            ));
        }
    }
    if let Some(bh) = v.get("blackholes").and_then(|x| x.as_array()) {
        if !bh.is_empty() {
            s.push_str(&format!("blackholes（{}）：\n", bh.len()));
            for b in bh {
                s.push_str(&format!(
                    "  {} count={} 窗口已 {}ms\n",
                    b.get("device").and_then(|x| x.as_str()).map(|d| did_tail(d, 6)).unwrap_or_default(),
                    b.get("count").and_then(|x| x.as_u64()).unwrap_or(0),
                    b.get("windowAgeMs").and_then(|x| x.as_u64()).unwrap_or(0)
                ));
            }
        }
    }
    s
}

fn vnet_stun_text(v: &serde_json::Value) -> String {
    if v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
        return format!(
            "NAT 探测失败：{}\n",
            v.get("error").and_then(|x| x.as_str()).unwrap_or("未知错误")
        );
    }
    format!(
        "STUN public={} mapping={} filtering={} difficulty={} strategy={} ipv6={}\n",
        v.get("publicAddr").and_then(|x| x.as_str()).unwrap_or("-"),
        v.get("mapping").and_then(|x| x.as_str()).unwrap_or("-"),
        v.get("filtering").and_then(|x| x.as_str()).unwrap_or("-"),
        v.get("difficulty").and_then(|x| x.as_str()).unwrap_or("-"),
        v.get("strategy").and_then(|x| x.as_str()).unwrap_or("-"),
        v.get("ipv6").and_then(|x| x.as_str()).unwrap_or("-"),
    )
}

/// vnet 段级收尾：能人话就人话（`--json` 一律原始）；其余子命令保持原 JSON 行为。
fn finish_vnet(r: Result<serde_json::Value, String>, json_mode: bool, watch: bool) -> ! {
    match r {
        Ok(v) => {
            if json_mode {
                out(v)
            }
            let text = if v.get("mapping").is_some() {
                Some(vnet_stun_text(&v))
            } else if v.get("relay").is_some() && v.get("clients").is_some() {
                Some(vnet_relay_text(&v))
            } else if v.get("peers").is_some() {
                Some(vnet_peers_text(&v))
            } else {
                None
            };
            match text {
                // watch 已经自己打过每拍；结尾不再重复整块 JSON
                Some(t) if !watch => {
                    print!("{t}");
                    use std::io::Write as _;
                    let _ = std::io::stdout().flush();
                    std::process::exit(0)
                }
                Some(_) | None => out(v),
            }
        }
        Err(e) => die(e),
    }
}

// ─── 分发 ───

fn dispatch(sub: &str, rest: &[String]) -> ! {
    let p = match parse_args(rest) {
        Ok(p) => p,
        Err(e) => die(e),
    };
    let r = match sub {
        "identity" => cmd_identity(&p),
        "sign" => cmd_sign(&p),
        "account" => cmd_account(&p),
        "auth" => cmd_auth(&p),
        "wallet" => cmd_wallet(&p),
        "device" => cmd_device(&p),
        "delegation" => cmd_delegation(&p),
        "attest" => cmd_attest(&p),
        "status" => cmd_status(),
        "presence" => cmd_presence(&p),
        "env" => cmd_env(&p),
        "vnet" => finish_vnet(
            cmd_vnet(&p),
            p.flags.contains_key("json"),
            p.positional.first().map(|s| s == "watch").unwrap_or(false),
        ),
        "friend" => cmd_friend(&p),
        "chat" => cmd_chat(&p),
        "p2p" => cmd_p2p(&p),
        // 段级人话输出：session/share/task 默认打人话，`--json` 打原始响应（脚本/agent 用）。
        "session" => finish_reply(cmd_session(&p), p.flags.contains_key("json")),
        "share" => finish_reply(cmd_share(&p), p.flags.contains_key("json")),
        "task" => finish_reply(cmd_task(&p), p.flags.contains_key("json")),
        "serve" => {
            let port: u16 = p.flags.get("port").and_then(|s| s.parse().ok())
                .or_else(|| std::env::var("MYCO_SERVE_PORT").ok().and_then(|s| s.parse().ok()))
                .unwrap_or(3102);
            cli_serve::run(port);
        }
        _ => usage_exit(true),
    };
    match r {
        Ok(v) => out(v),
        Err(e) => die(e),
    }
}

/// 段级收尾：人话默认 / `--json` 原始响应。返回 `!`（调用即退出），
/// 让 dispatch 的 `share/session/task` 三个分段行为逐字节一致（不再三份复制）。
fn finish_reply(r: Result<ShareReply, String>, json_mode: bool) -> ! {
    match r {
        Ok(r) => {
            if json_mode {
                out(r.json)
            } else {
                print!("{}", r.human);
                use std::io::Write as _;
                let _ = std::io::stdout().flush();
                std::process::exit(0)
            }
        }
        Err(e) => die(e),
    }
}

// ═══ 单元测试（wire 格式跨端不变量——phone cli.ts 同款断言的 Rust 侧镜像）═══

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> (String, [u8; 32]) {
        // 固定测试种子（非生产钥）；did 按 core_id 规则 did:myco:z<base58btc(0xed01+pub)>（canonical）
        let seed: [u8; 32] = [7u8; 32];
        let sk = ed25519_dalek::SigningKey::from_bytes(&seed);
        let did = core_id::did_from_public(&sk.verifying_key().to_bytes());
        (did, seed)
    }

    #[test]
    fn grant_token_wire_roundtrip() {
        let (did, seed) = root();
        let claims = GrantClaims {
            org_did: did.clone(), device_did: "did:myco:DevX".into(),
            scopes: vec!["a".into(), "b".into()],
            issued_at: 1000, expires_at: 9_000_000_000_000, sig_b64: String::new(),
        };
        let token = issue_grant(&claims, &seed);
        let (valid, reason, c) = verify_grant(&token);
        assert!(valid, "verify failed: {reason}");
        assert_eq!(c.unwrap().device_did, "did:myco:DevX");
        // 篡改负例：换 org_did（签名失配）
        let raw = b64d(&token).unwrap();
        let mut j: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        j["orgDid"] = json!("did:myco:SomeoneElse");
        let forged = b64e(&serde_json::to_vec(&j).unwrap());
        let (valid2, _, _) = verify_grant(&forged);
        assert!(!valid2, "forged token must fail");
    }

    /// spec v0.3 canonical-only：org did canonical（z multibase）签发→验证；
    /// **legacy（裸 base58）已废止 → 拒**（统一文案「不支持的 did 格式」），即便签名有效。
    #[test]
    fn grant_token_canonical_multibase_org_did() {
        let (_, seed) = root();
        let sk = ed25519_dalek::SigningKey::from_bytes(&seed);
        // canonical 构造与 core_id did_from_public 同法（did:myco:z<base58btc(ed01+pub)>）
        let canonical = core_id::did_from_public(&sk.verifying_key().to_bytes());
        assert!(canonical.starts_with("did:myco:z"));
        let claims = GrantClaims {
            org_did: canonical, device_did: "did:myco:DevZ".into(),
            scopes: vec!["s".into()], issued_at: 2000, expires_at: 9_000_000_000_000,
            sig_b64: String::new(),
        };
        let token = issue_grant(&claims, &seed);
        let (valid, reason, c) = verify_grant(&token);
        assert!(valid, "canonical org did verify failed: {reason}");
        assert_eq!(c.unwrap().device_did, "did:myco:DevZ");
        // 载荷损坏负例：z 后不是合法 multibase
        let bad = GrantClaims { org_did: "did:myco:z0OIl".into(), ..GrantClaims {
            org_did: String::new(), device_did: "d".into(), scopes: vec![], issued_at: 1, expires_at: 9_000_000_000_000, sig_b64: String::new(),
        }};
        let (valid2, reason2, _) = verify_grant(&issue_grant(&bad, &seed));
        assert!(!valid2, "非法 multibase org did 必须拒: {reason2}");
        // legacy orgDid（裸 base58 32B）已废止：真签名也拒，文案统一
        let legacy = format!("did:myco:{}", bs58::encode(sk.verifying_key().to_bytes()).into_string());
        let legacy_claims = GrantClaims {
            org_did: legacy, device_did: "did:myco:DevZ".into(),
            scopes: vec!["s".into()], issued_at: 2000, expires_at: 9_000_000_000_000,
            sig_b64: String::new(),
        };
        let (valid3, reason3, _) = verify_grant(&issue_grant(&legacy_claims, &seed));
        assert!(!valid3, "legacy org did 必须拒");
        assert!(reason3.contains("不支持的 did 格式"), "文案应统一: {reason3}");
    }

    #[test]
    fn parse_args_rules() {
        let p = parse_args(&["did".into(), "--name".into(), "n1".into(), "--no-delegation".into()]).unwrap();
        assert_eq!(p.positional, vec!["did"]);
        assert_eq!(p.flags.get("name").unwrap(), "n1");
        assert_eq!(p.flags.get("no-delegation").unwrap(), "true");
    }

    // ── share 段（纯函数：不联网、不碰 env——网关侧由实机验证覆盖）──

    /// `--caps a,b` → 五布尔对象：列出的 true、其余**显式 false**（只给这几项）。
    /// 2026-11-04：model.select 成为第 5 个可控能力（与 dsh_share::CAP_IDS 对齐）。
    #[test]
    fn share_caps_flags_whitelist() {
        let v = share_caps_flags("session.read,session.input").unwrap();
        assert_eq!(v["session.read"], json!(true));
        assert_eq!(v["session.input"], json!(true));
        assert_eq!(v["agent.view"], json!(false));
        assert_eq!(v["scope.switch"], json!(false));
        assert_eq!(v["model.select"], json!(false));
        assert_eq!(v.as_object().unwrap().len(), 5);
        assert_eq!(share_caps_flags(" agent.view ").unwrap()["agent.view"], json!(true));
        // model.select 可单独授予
        assert_eq!(share_caps_flags("model.select").unwrap()["model.select"], json!(true));
    }

    #[test]
    fn share_caps_flags_rejects_bad_input() {
        // 拼错的 id 必须本地拦下（网关的 normalize_cap_flags 会静默丢弃 → 用户以为开了）
        assert!(share_caps_flags("session.readd").unwrap_err().contains("未知能力 id"));
        assert!(share_caps_flags("").unwrap_err().contains("为空"));
        assert!(share_caps_flags(" , ").unwrap_err().contains("为空"));
    }

    #[test]
    fn share_ms_and_visibility_human() {
        assert_eq!(share_ms_human(21_600_000), "6小时");
        assert_eq!(share_ms_human(604_800_000), "7天");
        assert_eq!(share_ms_human(5_400_000), "90分钟");
        assert_eq!(share_ms_human(90_000), "90000ms");
        let s = json!({ "stateVisibility": { "space": "session",
            "sessions": ["s1", "s2"], "windowMs": 86_400_000 } });
        assert_eq!(share_vis_human(&s), "会话×2 · 最近1天");
        let d = json!({ "stateVisibility": { "space": "machine",
            "sessions": [], "windowMs": null } });
        assert_eq!(share_vis_human(&d), "整机 · 全部历史");
        // 老记录缺字段 → 默认全可见（与网关 visibility_default 同口径）
        assert_eq!(share_vis_human(&json!({})), "整机 · 全部历史");
    }

    #[test]
    fn share_list_human_shape() {
        let v = json!({
            "ok": true, "entryBase": "http://127.0.0.1:13911",
            "shares": [{
                "shareId": "sh-abc123", "title": "给小王看", "granularity": "session",
                "state": "active", "sessionId": "session-4d716240",
                "grants": [{"label": "owner"}, {"label": "小王"}],
                "stateVisibility": {"space": "project", "sessions": [], "windowMs": 21600000},
            }],
        });
        let t = share_list_human(&v);
        assert!(t.contains("分享 1 条"), "{t}");
        assert!(t.contains("sh-abc123"), "{t}");
        assert!(t.contains("授权 2"), "{t}");
        assert!(t.contains("可见: 本项目 · 最近6小时"), "{t}");
        assert!(t.contains("给小王看"), "{t}");
        assert!(t.contains("session-4d716240"), "{t}");
        assert_eq!(share_list_human(&json!({"shares": []})), "没有分享（入口 -）\n");
    }

    /// 环境卡（`--env-kind`）：与 UI「分享环境」同一条 create 通道；缺档位默认 main。
    #[test]
    fn share_create_env_card_plan() {
        let plan = |args: &[&str]| share_create_plan(&pargs(args));
        let p = plan(&[
            "create", "--env-kind", "rdp", "--env-device", "did:myco:Dev1",
            "--env-port", "3389", "--env-local-port", "23389", "--env-label", "桌面", "--title", "远程桌面",
        ]).unwrap();
        assert_eq!(p.body["granularity"], json!("main"));
        assert_eq!(p.body["env"][0], json!({
            "kind": "rdp", "device": "did:myco:Dev1", "port": 3389, "localPort": 23389, "label": "桌面",
        }));
        assert_eq!(p.env_human.as_deref(), Some("rdp → did:myco:Dev1"));
        assert!(p.declared);
        // 有 session-id 时档位仍推 session（env 不覆盖）
        let s = plan(&["create", "--session-id", "s1", "--env-kind", "dsh", "--env-device", "did:myco:Dev1"]).unwrap();
        assert_eq!(s.body["granularity"], json!("session"));
        assert_eq!(s.body["env"][0]["kind"], json!("dsh"));
        // 本地校验：成对 / kind 白名单 / device DID / 三个 env-* 只在 env-kind 下有意义
        assert!(plan(&["create", "--env-kind", "rdp"]).unwrap_err().contains("成对"));
        assert!(plan(&["create", "--env-kind", "nope", "--env-device", "did:myco:x"]).unwrap_err().contains("不支持的 --env-kind"));
        assert!(plan(&["create", "--env-kind", "rdp", "--env-device", "x"]).unwrap_err().contains("did:"));
        assert!(plan(&["create", "--granularity", "main", "--env-port", "3389"]).unwrap_err().contains("只在 --env-kind"));
        assert!(plan(&["create", "--env-kind", "rdp", "--env-device", "did:myco:x", "--env-port", "0"]).unwrap_err().contains("env-port"));
    }

    /// 缺参/档位错的用法错误必须**在出网前**返回（不需要网关在跑）。
    #[test]
    fn share_usage_errors_before_http() {
        let cas = |args: &[&str]| {
            let a: Vec<String> = args.iter().map(|s| s.to_string()).collect();
            cmd_share(&parse_args(&a).unwrap())
        };
        assert!(cas(&["create"]).unwrap_err().contains("用法: share create"));
        assert!(cas(&["create", "--granularity", "bogus"]).unwrap_err().contains("--granularity 只认"));
        assert!(cas(&["create", "--granularity", "session"]).unwrap_err().contains("--session-id"));
        assert!(cas(&["create", "--granularity", "workspace"]).unwrap_err().contains("--cwd"));
        assert!(cas(&["grant", "--label", "x"]).unwrap_err().contains("用法: share grant"));
        assert!(cas(&["grant", "--share", "sh-1"]).unwrap_err().contains("--label"));
        // 2026-11-03 语义变更：不给 --space = **读**当前可见范围（不再是用例错误）；
        // 缺 --share 仍是本地用法错误，非法 --space 仍在出网前被拦。
        assert!(cas(&["visibility"]).unwrap_err().contains("用法: share visibility"));
        assert!(cas(&["visibility", "--share", "sh-1", "--space", "org"]).unwrap_err().contains("--space 只认"));
        assert!(cas(&["revoke"]).unwrap_err().contains("用法: share revoke"));
        // 档位推断不联网也要能走到"参数齐了"这一步之后才失败——这里用非法 ttl 反证参数面
        assert!(cas(&["grant", "--share", "sh-1", "--label", "x", "--ttl-secs", "abc"])
            .unwrap_err()
            .contains("--ttl-secs"));
    }

    /// 2026-11-03：原「规划中」的 share 子命令全部落地——**缺参用法错误必须在出网前**
    /// 返回（网关没跑也能判定参数面；不在测试里联网）。
    #[test]
    fn share_new_subcommands_usage_before_http() {
        let cas = |args: &[&str]| {
            let a: Vec<String> = args.iter().map(|s| s.to_string()).collect();
            cmd_share(&parse_args(&a).unwrap())
        };
        for (args, want) in [
            (vec!["grants"], "用法: share grants"),
            (vec!["caps"], "用法: share caps"),
            (vec!["grant-caps"], "用法: share grant-caps"),
            (vec!["req-decide"], "用法: share req-decide"),
            (vec!["perm"], "用法: share perm"),
            (vec!["can-reshare"], "用法: share can-reshare"),
            (vec!["publish"], "用法: share publish"),
            (vec!["reshare-decide"], "用法: share reshare-decide"),
            (vec!["suspend"], "用法: share suspend"),
            (vec!["kill"], "用法: share kill"),
            (vec!["open"], "用法: share open"),
        ] {
            let e = cas(&args).unwrap_err();
            assert!(e.contains(want), "{args:?} → {e}");
        }
        // perm 给了 share/did 但没有任何动作 → 仍是用例错误（不发请求）
        let e = cas(&["perm", "--share", "sh-1", "--did", "did:myco:x"]).unwrap_err();
        assert!(e.contains("用法: share perm"), "{e}");
        let e = cmd_share(&parse_args(&["nope".to_string()]).unwrap()).unwrap_err();
        assert!(e.contains("未知子命令 share nope"), "{e}");
    }

    /// 生效能力四布尔 → 人话标签（未知/缺省 id 不得误报）。
    #[test]
    fn caps_true_labels_maps_fixed_ids() {
        let caps = json!({"session.read": true, "session.input": false,
                          "agent.view": true, "scope.switch": false, "bogus": true});
        assert_eq!(caps_true_labels(&caps), vec!["看会话内容", "看子 agent"]);
        assert!(caps_true_labels(&json!({})).is_empty());
    }

    /// 「谁能看」人话：owner 恒首行、能力/可见范围/转授三行都要出。
    #[test]
    fn share_grants_human_shape() {
        let v = json!({
            "ok": true,
            "collaborators": [
                {"did": "did:youling:abc", "name": "我·abc", "isOwner": true,
                 "caps": {"session.read": true, "session.input": true, "agent.view": true, "scope.switch": true},
                 "visibility": {"space": "machine", "sessions": [], "windowMs": null},
                 "visibilityOverride": null, "canReshare": false},
                {"did": "did:myco:z6Mk1234567890", "name": "小王", "isOwner": false,
                 "caps": {"session.read": true, "session.input": false, "agent.view": false, "scope.switch": false},
                 "visibility": {"space": "project", "sessions": [], "windowMs": 21600000},
                 "visibilityOverride": {"space": "project"}, "canReshare": true, "reshareExp": 0},
            ],
        });
        let t = share_grants_human(&v, "sh-1");
        assert!(t.contains("协作者 2 人"), "{t}");
        assert!(t.contains("★ 我·abc"), "{t}");
        assert!(t.contains("看会话内容、输入内容、看子 agent、切换已授权的会话/工作区"), "{t}");
        assert!(t.contains("本项目 · 最近6小时（逐人覆盖）"), "{t}");
        assert!(t.contains("可转授"), "{t}");
        assert!(t.contains("—（owner）"), "{t}");
        assert_eq!(share_grants_human(&json!({"collaborators": []}), "sh-1"), "分享 sh-1 没有协作者\n");
    }

    /// 任务卡清单人话：状态中文、shared 计数、来源与 share 标注。
    #[test]
    fn task_list_human_shape() {
        let tasks = vec![
            json!({"taskId": "peer-task-share-sh-a", "status": "pending", "title": "修 CLI",
                   "fromName": "小王", "shareId": "sh-a"}),
            json!({"taskId": "peer-task-share-sh-b", "status": "done", "title": "写文档", "from": "did:myco:x"}),
        ];
        let t = task_list_human(&tasks, 5);
        assert!(t.contains("任务卡 2 张"), "{t}");
        assert!(t.contains("3 张 shared 未显示"), "{t}");
        assert!(t.contains("[待接受] 修 CLI"), "{t}");
        assert!(t.contains("← 小王"), "{t}");
        assert!(t.contains("[已完成] 写文档"), "{t}");
        assert!(t.contains("(share sh-a)"), "{t}");
        assert_eq!(task_list_human(&[], 0), "没有任务卡（本账号共 0 张，默认隐藏 shared）\n");
    }

    /// auth/sign 的签名原文格式是跨端协议（改它=所有人登录失效）。
    #[test]
    fn auth_message_is_protocol_stable() {
        assert_eq!(auth_msg("t-123"), "myco-auth\nt-123");
        assert_eq!(pct("did:myco:a+b/c"), "did%3Amyco%3Aa%2Bb%2Fc");
    }

    /// 新增布尔 flag 都不能被当成「缺值」。
    #[test]
    fn new_bool_flags_parse() {
        for f in ["force", "delegated", "on", "off", "approve", "deny", "remember",
                  "no-broadcast", "dry-run", "window-full", "no-read", "no-write", "all"] {
            let p = parse_args(&[format!("--{f}")]).unwrap();
            assert_eq!(p.flags.get(f).map(String::as_str), Some("true"), "--{f}");
        }
    }

    /// `--json` / `--ro` 是布尔 flag（无值不报"缺值"）。
    #[test]
    fn share_bool_flags() {
        let p = parse_args(&["list".into(), "--json".into()]).unwrap();
        assert_eq!(p.flags.get("json").unwrap(), "true");
        let p = parse_args(&["grant".into(), "--share".into(), "sh-1".into(), "--label".into(), "x".into(), "--ro".into()]).unwrap();
        assert_eq!(p.flags.get("ro").unwrap(), "true");
    }

    // ═══ share create 的任务声明面（组装 + 本地校验：纯函数，不联网）═══

    fn pargs(args: &[&str]) -> Parsed {
        parse_args(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap()
    }

    /// `--caps a,b` → create 的 `{o:[{id,label,methods}],a:[…]}` 声明对象（§3.14）。
    #[test]
    fn share_caps_decl_shape() {
        let v = share_caps_decl("session.read,session.input").unwrap();
        assert_eq!(v["o"].as_array().unwrap().len(), 1, "{v}");
        assert_eq!(v["o"][0]["id"], json!("session.read"));
        assert_eq!(v["o"][0]["label"], json!("看会话内容"));
        assert_eq!(v["o"][0]["methods"], json!(["session/page", "session/list"]));
        assert_eq!(v["a"][0]["id"], json!("session.input"));
        assert_eq!(v["a"][0]["label"], json!("输入内容"));
        assert_eq!(v["a"][0]["methods"], json!(["session/prompt"]));
        // 没列出的 id **不声明**（声明面只认"有哪些"，不是四布尔）
        assert!(!v.to_string().contains("agent.view"), "{v}");
        // 某一向一个都没列 → **显式空数组**（该向全关；与 share grant --caps 的"只给这几项"同口径）
        let only = share_caps_decl("agent.view").unwrap();
        assert_eq!(only["o"][0]["id"], json!("agent.view"));
        assert_eq!(only["o"][0]["methods"], json!(["subagent/list"]));
        assert_eq!(only["a"], json!([]));
        // 四项全给 → 各归各向（o=看 / a=做）
        let all = share_caps_decl("session.read,session.input,agent.view,scope.switch").unwrap();
        let ids = |d: &str| -> Vec<String> {
            all[d].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap().to_string()).collect()
        };
        assert_eq!(ids("o"), vec!["session.read", "agent.view"]);
        assert_eq!(ids("a"), vec!["session.input", "scope.switch"]);
        assert_eq!(all["a"][1]["methods"], json!(["session/activate"]), "§3.14.1：scope.switch 只声明 session/activate");
        // 校验复用 share_caps_flags：拼错的 id / 空值都在本地拦下
        assert!(share_caps_decl("sessoin.read").unwrap_err().contains("未知能力 id"));
        assert!(share_caps_decl("").unwrap_err().contains("为空"));
        // 人话清单（O 向在前）
        assert_eq!(share_caps_labels(&v), vec!["看会话内容", "输入内容"]);
    }

    /// `--space/--sessions/--window-ms` → `stateVisibility` 对象（只下发给了的键）。
    #[test]
    fn share_state_visibility_assembly() {
        // 一个都没给 → None（不下发 = 与旧行为逐字节一致）
        assert!(share_state_visibility(&pargs(&[])).unwrap().is_none());
        // 三个都给：camelCase 键名 + 逗号值展平
        let sv = share_state_visibility(&pargs(&["--space", "session", "--sessions", "s1, s2", "--window-ms", "21600000"]))
            .unwrap()
            .unwrap();
        assert_eq!(sv, json!({"space":"session","sessions":["s1","s2"],"windowMs":21600000}));
        // 只给一部分：不替网关编其它键（缺省归 handle_create 的 visibility_default）
        assert_eq!(share_state_visibility(&pargs(&["--sessions", "s1"])).unwrap().unwrap(), json!({"sessions":["s1"]}));
        assert_eq!(share_state_visibility(&pargs(&["--window-ms", "0"])).unwrap().unwrap(), json!({"windowMs":0}));
        // 去重保序
        let dup = share_state_visibility(&pargs(&["--space", "session", "--sessions", "b,a,b"])).unwrap().unwrap();
        assert_eq!(dup["sessions"], json!(["b", "a"]));
        // 校验错误在出网前
        assert!(share_state_visibility(&pargs(&["--space", "org"])).unwrap_err().contains("--space 只认"));
        assert!(share_state_visibility(&pargs(&["--window-ms", "1h"])).unwrap_err().contains("--window-ms"));
        // 重复给 --sessions = 本地报错（HashMap 会静默只留最后一个，比报错难查得多）
        let e = parse_args(&["--sessions".into(), "a".into(), "--sessions".into(), "b".into()]).unwrap_err();
        assert!(e.contains("重复给"), "{e}");
        let e2 = parse_args(&["--sessions=a".into(), "--sessions=b".into()]).unwrap_err();
        assert!(e2.contains("重复给"), "{e2}");
    }

    /// `--goal/--sla/--reward` → taskCard；人话汇总。
    #[test]
    fn share_task_card_assembly() {
        assert!(share_task_card(&pargs(&[])).is_none());
        assert!(share_task_card(&pargs(&["--goal", "  "])).is_none(), "空串不编出空任务卡");
        let card = share_task_card(&pargs(&["--goal", "跑完第 3 期", "--sla", "≥90% 正确率", "--reward", "200"])).unwrap();
        assert_eq!(card, json!({"goal":"跑完第 3 期","sla":"≥90% 正确率","reward":"200"}));
        let only = share_task_card(&pargs(&["--goal", "G"])).unwrap();
        assert_eq!(only, json!({"goal":"G"}), "没给的不编");
        assert_eq!(share_task_card_human(&only).unwrap(), "目标已设");
        assert_eq!(share_task_card_human(&card).unwrap(), "目标/验收/奖励已设");
        assert!(share_task_card_human(&json!({})).is_none());
    }

    /// create 请求体：老用法**一个字节都不多发**；给了声明面才按 camelCase 组装。
    #[test]
    fn share_create_plan_body_and_zero_regression() {
        let plan = |args: &[&str]| share_create_plan(&pargs(args)).unwrap();
        // 老用法：body 只有老三样，声明面三个键一个都不出现（零回归的机器可验形态）
        let old = plan(&["create", "--granularity", "session", "--session-id", "s1", "--title", "T"]);
        assert!(!old.declared);
        assert_eq!(old.body, json!({"granularity":"session","sessionId":"s1","title":"T"}));
        assert!(old.notes.is_empty(), "{:?}", old.notes);
        assert!(old.grant_to.is_none());
        // 完整声明：名字 + 档位 + S/O/A + 谁能进，一条命令组装齐
        let full = plan(&[
            "create", "--granularity", "session", "--session-id", "s1", "--title", "HBL 第 3 期评测",
            "--visibility", "public",
            "--space", "session", "--sessions", "s1", "--window-ms", "21600000",
            "--caps", "session.read,session.input",
            "--goal", "跑完第 3 期", "--sla", "≥90%", "--reward", "200",
            "--grant-to", "小王", "--grant-did", "did:myco:W",
        ]);
        assert!(full.declared);
        // 发布面（字符串）与状态空间可见范围（对象，走 stateVisibility 别名）**同时给、互不覆盖**
        assert_eq!(full.body["visibility"], json!("public"));
        assert_eq!(full.body["stateVisibility"], json!({"space":"session","sessions":["s1"],"windowMs":21600000}));
        assert_eq!(full.body["taskCard"], json!({"goal":"跑完第 3 期","sla":"≥90%","reward":"200"}));
        assert_eq!(full.body["caps"]["o"][0]["id"], json!("session.read"));
        assert_eq!(full.body["caps"]["a"][0]["id"], json!("session.input"));
        assert_eq!(full.grant_to.as_deref(), Some("小王"));
        assert!(full.notes.is_empty(), "{:?}", full.notes);
        // 提示（不拦）：窄窗 / sessions 与 space 不搭 / space session 白名单空
        let n1 = plan(&["create", "--granularity", "session", "--session-id", "s1", "--space", "session", "--window-ms", "30000"]);
        assert!(n1.notes.iter().any(|n| n.contains("白名单空")), "{:?}", n1.notes);
        assert!(n1.notes.iter().any(|n| n.contains("60000")), "{:?}", n1.notes);
        let n2 = plan(&["create", "--granularity", "session", "--session-id", "s1", "--space", "machine", "--sessions", "s1"]);
        assert!(n2.notes.iter().any(|n| n.contains("只在 --space session 下生效")), "{:?}", n2.notes);
        // 人话块：任务声明面各段都在，且不是 JSON
        let human = share_create_human_declared(
            "sh-x",
            &json!({
                "granularity": "session", "entryBase": "http://127.0.0.1:13911",
                "urlPath": "/gw/sh-x/", "localOpenUrl": "http://127.0.0.1:3102/api/dshShare/open?shareId=sh-x",
                "caps": full.body["caps"].clone(),
            }),
            &full,
            None,
        );
        assert!(human.starts_with("任务已声明"), "{human}");
        assert!(human.contains("HBL 第 3 期评测"), "{human}");
        assert!(human.contains("会话×1 · 最近6小时"), "{human}");
        assert!(human.contains("看会话内容、输入内容"), "{human}");
        assert!(human.contains("目标/验收/奖励已设"), "{human}");
        assert!(human.contains("http://127.0.0.1:13911/gw/sh-x/"), "{human}");
        assert!(!human.contains("\"ok\""), "{human}");
        // 邀请链接行只在 --grant-to 时出现
        let with_invite = share_create_human_declared(
            "sh-x",
            &json!({"granularity":"session","entryBase":"http://e","urlPath":"/gw/sh-x/","localOpenUrl":"l","caps":json!({"o":[],"a":[]})}),
            &full,
            Some(&json!({"url":"http://e/gw/sh-x/?mt=T"})),
        );
        assert!(with_invite.contains("邀请链接      http://e/gw/sh-x/?mt=T"), "{with_invite}");
        assert!(with_invite.contains("邀请标签      小王"), "{with_invite}");
        // 老用法的人话与补齐前**逐字节一致**
        let legacy = share_create_human_legacy("sh-x", &json!({"granularity":"session","ownerUrl":"o","localOpenUrl":"l"}));
        assert_eq!(
            legacy,
            "分享已创建\n  shareId       sh-x\n  档位          session\n  ownerUrl      o\n  localOpenUrl  l\n  提示          发给别人: myco cli share grant --share sh-x --label <名>"
        );
    }

    /// 声明面的参数校验错误必须**在出网前**返回（不需要网关在跑）。
    #[test]
    fn share_create_declare_validation_errors() {
        let e = |args: &[&str]| share_create_plan(&pargs(args)).unwrap_err();
        let base = ["create", "--granularity", "session", "--session-id", "s1"];
        let with = |extra: &[&str]| {
            let mut a = base.to_vec();
            a.extend_from_slice(extra);
            e(&a)
        };
        assert!(with(&["--visibility", "bogus"]).contains("--visibility 只认"));
        // --visibility 的合法值不报错（private 走发布面，不需要网关在跑）
        assert!(share_create_plan(&pargs(&["create", "--granularity", "session", "--session-id", "s1", "--visibility", "private"])).is_ok());
        assert!(with(&["--space", "org"]).contains("--space 只认"));
        assert!(with(&["--window-ms", "1h"]).contains("--window-ms"));
        assert!(with(&["--sessions", "s1", "--window-ms", "-5"]).contains("--window-ms"));
        assert!(with(&["--caps", "sessoin.read"]).contains("未知能力 id"));
        assert!(with(&["--caps", ""]).contains("为空"));
        assert!(with(&["--grant-to", " "]).contains("--grant-to"));
        assert!(with(&["--grant-did", "did:myco:X"]).contains("--grant-did"));
        // 老校验一字不改
        assert!(e(&["create"]).contains("用法: share create"));
        assert!(e(&["create", "--granularity", "bogus"]).contains("--granularity 只认"));
        assert!(e(&["create", "--granularity", "session"]).contains("--session-id"));
        assert!(e(&["create", "--granularity", "workspace"]).contains("--cwd"));
    }

    // ═══ session 组（纯函数：不联网、不碰 env——DSH_SESSION_ID 由参数注入）═══

    fn sess(id: &str, name: &str) -> serde_json::Value {
        json!({ "sessionId": id, "name": name })
    }

    /// 发送方身份：env 缺省 → myco；env 命中清单 → 会话名（裸 uuid 与
    /// `session-<uuid>` 两种形态都认）；查不到 → id 尾 8；空白串视为缺省。

    // ── 2026-10-19 v6 充要头（纯函数） ──
    #[test]
    fn chat_header_is_minimal_and_reply_target_exact() {
        let sid = "session-cd8a3c33-c0f3-4843-ade3-55fd603bf5db";
        let h = format_chat_header("DSH协议应用", Some(sid), false);
        let lines: Vec<&str> = h.lines().collect();
        assert_eq!(lines.len(), 2, "只允许两行（from + reply-to）：{h}");
        assert!(lines[0].starts_with("[from: DSH协议应用 · "), "人读名字：{h}");
        assert!(lines[0].ends_with(']'), "第一行以 ] 收尾，body 从下一行起：{h}");
        assert_eq!(lines[1], format!("reply-to: {sid}"), "回信地址=完整 sessionId（精确、可复制）");
        // 不再有冗余字段
        assert!(!h.contains("reply-to-name"), "名字已在 from 里，不再重复");
        assert!(!h.contains('…'), "不再有 id 尾（reply-to 全覆盖）");
        assert!(!h.contains("via "), "通道是实现细节，不进头部");
        assert!(!h.contains("---"), "两行前缀自识别，不需要分隔线");
        // 子代理：名字带 /子代理（必要信息），reply-to 仍可寻址
        let sub = format_chat_header("群体智能/子代理", Some("70f04816"), false);
        assert!(sub.starts_with("[from: 群体智能/子代理 · "), "{sub}");
        assert!(sub.contains("reply-to: session-70f04816"), "裸 id 补 session- 前缀");
        // steer 插队标记（被打断是必要信息）
        let urgent = format_chat_header("助手", Some(sid), true);
        assert!(urgent.starts_with("[from: 助手 · ⚡插队 · "), "{urgent}");
        // 拿不到 sessionId → 只出 from 行（宁缺勿错，不猜目标）
        let no_sid = format_chat_header("某会话", None, false);
        assert_eq!(no_sid.lines().count(), 1, "{no_sid}");
        assert!(!no_sid.contains("reply-to"), "{no_sid}");
        // 名字为空 → myco（myco 自己发的，没有会话身份）
        assert!(format_chat_header("", Some(sid), false).starts_with("[from: myco · "));
    }

    // ── 2026-10-19 Fix：fork 会话补全（merge 纯函数） ──
    #[test]
    fn merge_session_lists_adds_fork_only_entries_and_dedupes() {
        let filtered = vec![
            serde_json::json!({"sessionId": "session-a", "name": "群体智能"}),
            serde_json::json!({"sessionId": "session-b", "name": "周报"}),
        ];
        let full = vec![
            serde_json::json!({"sessionId": "session-a", "name": "群体智能"}),
            serde_json::json!({"sessionId": "session-fork-55babc93", "name": "申诉管理"}),
            serde_json::json!({"sessionId": "session-agent-70f04816", "name": "群体智能/子代理"}),
        ];
        let merged = merge_session_lists(&filtered, &full);
        assert_eq!(merged.len(), 4, "只追加过滤清单没有的会话（fork/子代理）");
        assert_eq!(merged[0]["sessionId"], "session-a", "过滤清单顺序在前");
        assert!(merged.iter().any(|s| s["name"] == "申诉管理"), "fork 会话必须可被署名解析找到");
        // 重复合并幂等
        let again = merge_session_lists(&merged, &full);
        assert_eq!(again.len(), 4);
    }


    // ── 2026-10-19 补充：HTTP action 路径（dispatch_structured）同样用这份判定 ──
    #[test]
    fn sender_missing_from_list_detects_fork_sessions() {
        let filtered = vec![sess("session-a", "群体智能")];
        assert!(!sender_missing_from_list(&filtered, Some("群体智能"), None), "清单内名字不触发刷新");
        assert!(sender_missing_from_list(&filtered, Some("申诉管理"), None), "fork 会话名 miss → 需刷新完整清单");
        assert!(!sender_missing_from_list(&filtered, None, Some("a")), "session-<id> 命中");
        assert!(sender_missing_from_list(&filtered, None, Some("55babc93-fork")), "fork sid miss → 需刷新");
        assert!(!sender_missing_from_list(&[], None, None), "无身份信息不触发");
    }    #[test]
    fn session_sender_name_variants() {
        let list = vec![
            json!({ "sessionId": "session-3799abcd-1111", "name": "myco-cli-session" }),
            sess("abc22222-3333", "另一个会话"),
        ];
        assert_eq!(session_sender_name(None, &list), "myco");
        assert_eq!(session_sender_name(Some("  "), &list), "myco");
        // 裸 uuid 命中 session-<uuid> 形态的行
        assert_eq!(session_sender_name(Some("3799abcd-1111", ), &list), "myco-cli-session");
        assert_eq!(session_sender_name(Some("session-3799abcd-1111", ), &list), "myco-cli-session");
        // 精确 sessionId（非 session- 前缀形态）
        assert_eq!(session_sender_name(Some("abc22222-3333", ), &list), "另一个会话");
        // 查不到：id 尾 8（按字符）
        assert_eq!(session_sender_name(Some("did-not-exist-abcdef12", ), &list), "abcdef12");
        // 空清单同理
        assert_eq!(session_sender_name(Some("xyz-12345678", ), &[]), "12345678");
        // 尾 8 不足 8 位原样
        assert_eq!(session_sender_name(Some("ab", ), &[]), "ab");
    }


    // ── 2026-10-19 Bug 回归：from 头部必须显示发件人（不是收件人/上一次的 to） ──
    #[test]
    fn sender_label_from_path_uses_sender_not_recipient_or_env() {
        // 用例 A/C：from=申诉管理，env 指向 DSH协议应用（myco 由那个会话拉起）
        let (name, sid) = sender_label_parts(
            "from",
            "申诉管理",
            "DSH协议应用",
            Some("session-55babc93-db28-40cc-8a6d-660270f04816"),
            Some("603bf5db-1111"),
        );
        assert_eq!(name, "申诉管理", "from 路径必须用 from，不能用 env/收件人");
        assert_eq!(sid.as_deref(), Some("session-55babc93-db28-40cc-8a6d-660270f04816"));
        // 连续第二次发送 to=抽检管理，from 仍是申诉管理 → 头部仍必须是申诉管理
        let (name2, _) = sender_label_parts("from", "申诉管理", "DSH协议应用", None, Some("603bf5db-1111"));
        assert_eq!(name2, "申诉管理", "不得复用上一次的 to");
        // from 在清单里没有映射时不硬借 env 的 id 尾
        let (name3, sid3) = sender_label_parts("from", "申诉管理", "myco", None, Some("603bf5db-1111"));
        assert_eq!(name3, "申诉管理");
        assert!(sid3.is_none());
        // 用例 B（sessionId 路径）保持不变
        let (name4, sid4) = sender_label_parts(
            "sessionId",
            "申诉管理",
            "申诉管理",
            None,
            Some("55babc93-db28-40cc-8a6d-660270f04816"),
        );
        assert_eq!(name4, "申诉管理");
        assert_eq!(sid4.as_deref(), Some("55babc93-db28-40cc-8a6d-660270f04816"));
    }

    #[test]
    fn sessions_refresh_noop_when_sid_already_present() {
        let sessions = vec![json!({"sessionId": "session-a", "name": "已存在"})];
        let out = sessions_with_refresh_for_sid(sessions, Some("a"));
        assert_eq!(out.len(), 1, "sid 已在清单里 → 不刷新、原样返回");
        assert_eq!(out[0]["name"], "已存在");
    }
    /// whoami：**显式 sessionId 优先**（myco 是独立进程、正常启动没有 DSH 环境，
    /// 靠 env 必退化成 myco——did 会话回信 myco·x7oj 的真案）；未解析时 resolved=false
    /// 且人话提示"请传 sessionId"。
    #[test]
    fn session_whoami_resolves_explicit_sid() {
        let list = vec![sess("session-385f19bf-1a13", "did")];
        // 显式 sessionId（裸 uuid 形态）→ 命中名字
        let r = session_whoami(&list, Some("385f19bf-1a13")).unwrap();
        assert_eq!(r.json["name"], json!("did"));
        assert_eq!(r.json["resolved"], json!(true));
        assert_eq!(r.json["sessionId"], json!("session-385f19bf-1a13"));
        assert!(!r.human.contains("身份未解析"), "{}", r.human);
        // 清单里没有的 id → id 尾 8 兜底 + resolved=false + 提示
        let r2 = session_whoami(&[], Some("deadbeef-12345678")).unwrap();
        assert_eq!(r2.json["name"], json!("12345678"));
        assert_eq!(r2.json["resolved"], json!(false));
        assert!(r2.human.contains("身份未解析"), "{}", r2.human);
    }

    /// 身份解析 v3：sessionId 权威 > from 必须可验证 > env 未验证 > 拒绝。
    /// 驱动真案："基础设施"/"镜像模式重构线" 都是 agent 编的名字（用户两次实测问题）。
    #[test]
    fn resolve_sender_v3_rules() {
        let list = vec![
            sess("session-385f19bf-1111", "did"),
            sess("abc22222-3333", "有灵线上运维"),
        ];
        // ① sessionId 命中 → 权威名字 + verified
        assert_eq!(
            resolve_sender(&list, None, Some("385f19bf-1111"), None).unwrap(),
            ("did".into(), "sessionId", true)
        );
        // ①b sessionId 查不到 → id 尾8（如实，不编）+ 未验证
        let (n, src, ok) = resolve_sender(&list, None, Some("deadbeef-99999999"), None).unwrap();
        assert_eq!((n.as_str(), src, ok), ("99999999", "sessionId", false));
        // ② from 命中清单 → verified
        assert_eq!(
            resolve_sender(&list, Some("有灵线上运维"), None, None).unwrap(),
            ("有灵线上运维".into(), "from", true)
        );
        // ②b from 编名字 → **拒绝**（不再照发）
        let e = resolve_sender(&list, Some("镜像模式重构线"), None, None).unwrap_err();
        assert!(e.contains("不在本机会话清单里"), "{e}");
        let e2 = resolve_sender(&list, Some("基础设施"), None, None).unwrap_err();
        assert!(e2.contains("不在本机会话清单里"), "{e2}");
        // ②c 清单不可用（DSH 没跑）→ 放行但未验证（不挡跨设备投递）
        let (n2, src2, ok2) = resolve_sender(&[], Some("某人"), None, None).unwrap();
        assert_eq!((n2.as_str(), src2, ok2), ("某人", "from", false));
        // ③ 只有 env（可能继承自别的会话）→ 未验证
        let (n3, src3, ok3) = resolve_sender(&list, None, None, Some("385f19bf-1111")).unwrap();
        assert_eq!((n3.as_str(), src3, ok3), ("did", "env", false));
        // ④ 都没有 → 拒绝
        let e3 = resolve_sender(&list, None, None, None).unwrap_err();
        assert!(e3.contains("缺身份"), "{e3}");
    }

    /// 手写头部自动剥掉（防双层头部——真案：did 会话手写 `[from: myco]`）。
    #[test]
    fn strip_handwritten_header_cases() {
        assert_eq!(strip_handwritten_header("[from: myco]\n---\n正文"), "正文");
        assert_eq!(
            strip_handwritten_header("  [from: x via myco]\n---\n\n正文\n多行"),
            "正文\n多行"
        );
        // 非头部形态 → 原样（不误伤正文）
        assert_eq!(strip_handwritten_header("正文 [from: x]"), "正文 [from: x]");
        assert_eq!(strip_handwritten_header("[from: x]\n没有分隔线"), "[from: x]\n没有分隔线");
        assert_eq!(strip_handwritten_header("普通正文"), "普通正文");
    }

    /// --to 解析链：sessionId 精确 → 名字精确（大小写不敏感）→ 名字唯一子串 →
    /// sessionId 唯一前缀；歧义/落空都有人话（附候选）。
    #[test]
    fn session_resolve_target_chain() {        let list = vec![
            sess("sess-alpha-001", "发题器运维"),
            sess("sess-alpha-002", "发题器监控"),
            sess("sess-beta-003", "周报"),
        ];
        // ① sessionId 精确
        assert_eq!(session_resolve_target(&list, "sess-beta-003").unwrap(), ("sess-beta-003".into(), "周报".into()));
        // ② 名字精确
        assert_eq!(session_resolve_target(&list, "周报").unwrap(), ("sess-beta-003".into(), "周报".into()));
        // 大小写不敏感（名字精确）
        assert_eq!(
            session_resolve_target(&vec![sess("s1", "Weekly Report")], "weekly report").unwrap(),
            ("s1".into(), "Weekly Report".into())
        );
        // ③ 名字唯一子串
        assert_eq!(session_resolve_target(&list, "监控").unwrap(), ("sess-alpha-002".into(), "发题器监控".into()));
        // ④ sessionId 唯一前缀
        assert_eq!(session_resolve_target(&list, "sess-beta").unwrap(), ("sess-beta-003".into(), "周报".into()));
        // 歧义：名字子串多个
        let e = session_resolve_target(&list, "发题器").unwrap_err();
        assert!(e.contains("匹配到 2 个") && e.contains("发题器监控"), "{e}");
        // 歧义：sessionId 前缀多个
        let e2 = session_resolve_target(&list, "sess-alpha-0").unwrap_err();
        assert!(e2.contains("匹配到 2 个") && e2.contains("sess-alpha-001"), "{e2}");
        // 落空
        assert!(session_resolve_target(&list, "不存在的会话").unwrap_err().contains("没有叫"));
        // 空清单
        assert!(session_resolve_target(&[], "x").unwrap_err().contains("清单为空"));
    }

    /// `session list` 人话表：计数 + 名字 + sessionID + 投递提示；空清单给人话。
    #[test]
    fn session_list_human_shape() {
        let v = json!({ "count": 2, "sessions": [
            sess("3799abcd-1111", "myco-cli-session"),
            sess("sess-beta-003", "周报"),
        ]});
        let t = session_list_human(&v);
        assert!(t.contains("会话 2 条"), "{t}");
        assert!(t.contains("myco-cli-session"), "{t}");
        assert!(t.contains("3799abcd-1111"), "{t}");
        assert!(t.contains("sess-beta-003"), "{t}");
        assert!(t.contains("session send --to"), "{t}");
        assert_eq!(session_list_human(&json!({ "sessions": [] })), "本机没有可见会话（打开 DSH 桌面版后这里会出清单）\n");
    }

    /// send 的用法错误必须在**出网前**返回（不需要 DSH 在跑）。
    #[test]
    fn session_send_usage_errors_before_http() {
        let cas = |args: &[&str]| {
            let a: Vec<String> = args.iter().map(|s| s.to_string()).collect();
            session_send(&parse_args(&a).unwrap())
        };
        assert!(cas(&["send"]).unwrap_err().contains("缺投递目标"));
        assert!(cas(&["send", "--text", "hi"]).unwrap_err().contains("缺投递目标"));
        assert!(cas(&["send", "--to", "x"]).unwrap_err().contains("--text"));
        assert!(cas(&["send", "--task", "sh-1"]).unwrap_err().contains("--text"));
        assert!(cas(&["send", "--to", "x", "--task", "sh-1", "--text", "hi"]).unwrap_err().contains("只能给一个"));
        let long = "字".repeat(8001);
        assert!(cas(&["send", "--to", "x", "--text", &long]).unwrap_err().contains("太长"));
        // 未知子命令
        let e = cmd_session(&pargs(&["nope"])).unwrap_err();
        assert!(e.contains("未知子命令 session nope"), "{e}");
    }
    /// 2026-10-19 同名歧义护栏：`--from <名字>` 可能对应**多个同名会话**
    /// （真案：本机清单里「申诉管理」有两条）——reply-to 一旦指错，
    /// 回信就进了别人的会话。规则：唯一命中才采信；多个命中只认 env/explicit sid。
    #[test]
    fn from_sid_for_label_refuses_ambiguous_same_name() {
        let s = |id: &str, name: &str| serde_json::json!({"sessionId": id, "name": name});
        let list = vec![
            s("session-aaa-00000001", "申诉管理"),
            s("session-bbb-00000002", "申诉管理"),
            s("session-ccc-00000003", "助手"),
        ];
        // 多个同名、又没有 env sid 消歧 → 不猜（宁可不给 id 尾，也不指错会话）
        assert_eq!(from_sid_for_label(&list, "申诉管理", None), None);
        // env sid 指向其中之一（真正的发信会话）→ 采信它
        assert_eq!(
            from_sid_for_label(&list, "申诉管理", Some("session-bbb-00000002")).as_deref(),
            Some("session-bbb-00000002")
        );
        // env 给裸 uuid（无 session- 前缀）也要认得
        assert_eq!(
            from_sid_for_label(&list, "申诉管理", Some("bbb-00000002")).as_deref(),
            Some("session-bbb-00000002")
        );
        // 唯一命中 → 直接用
        assert_eq!(
            from_sid_for_label(&list, "助手", None).as_deref(),
            Some("session-ccc-00000003")
        );
        // 名字查不到 → None（不硬借 env 的会话）
        assert_eq!(from_sid_for_label(&list, "不存在", Some("session-aaa-00000001")), None);
        // 前后空格不敏感
        assert_eq!(
            from_sid_for_label(&list, " 助手 ", None).as_deref(),
            Some("session-ccc-00000003")
        );
    }

    #[test]
    fn device_rename_requires_name_flag() {
        // 不带 --name：用法错误（不触碰文件系统；写入路径由 core 单测覆盖）
        let argv: Vec<String> = vec!["device".to_string(), "rename".to_string()];
        let p = crate::cli::parse_args(&argv).expect("parse");
        assert!(cmd_device_rename(&p).is_err());
    }

    // ── 2026-11-06 vnet 观测面（peers/relay/stun/watch）──

    #[test]
    fn vnet_status_kv_parser_ignores_noise() {
        let kv = crate::vnet::connection::parse_status_kv(
            "role=client\n\npath = Relay\nnonsense line\nlast_rtt_ms=-\n",
        );
        assert_eq!(kv.len(), 3, "空行/无等号行必须跳过: {kv:?}");
        assert_eq!(kv[0], ("role".into(), "client".into()));
        assert_eq!(kv[1].0, "path");
        assert_eq!(kv[1].1, "Relay");
    }

    #[test]
    fn vnet_did_tail_and_interval_parsing() {
        assert_eq!(did_tail("did:myco:abcdef", 3), "…def");
        assert_eq!(did_tail("short", 0), "…");
        assert_eq!(parse_interval_ms("500ms").unwrap(), 500);
        assert_eq!(parse_interval_ms("2s").unwrap(), 2000);
        assert_eq!(parse_interval_ms("3").unwrap(), 3000);
        assert_eq!(parse_interval_ms("1ms").unwrap(), 100, "下限 100ms（防打爆管理面）");
        assert!(parse_interval_ms("abc").is_err());
    }

    /// 契约：peers 只以设备 DID（did:myco）为键；name 只是可选展示名；
    /// 入站拿不到 DID 时 device=null。人话渲染不得凭空造账号层 DID。
    #[test]
    fn vnet_peers_contract_device_only() {
        let v = json!({"ok":true,"schema":1,"peers":[
            {"direction":"out","device":"did:myco:zOutDevice","name":"DESKTOP-KJS1H2L",
             "path":"Relay","rttMs":12,"probeRounds":3,"probeReqRx":2,"probeReplyRx":1,
             "localPort":23911,"targetPort":13911,"backoff":false},
            {"direction":"in","device":null,"peerId":1953146044,"targetPort":13911}
        ]});
        let t = vnet_peers_text(&v);
        assert!(t.contains("…Device"), "设备 DID 尾应可见: {t}");
        assert!(t.contains("DESKTOP-KJS1H2L"), "本地名册名应可见: {t}");
        assert!(t.contains("2↔1"), "双向探测计数应可见: {t}");
        assert!(t.contains("(未知)"), "入站未知设备必须显示未知而非编造: {t}");
        assert!(!t.contains("did:youling"), "vnet 契约不得混入账号层 DID: {t}");
    }

    #[test]
    fn vnet_relay_text_reports_negative_cache() {
        let v = json!({"ok":true,"schema":1,"relay":"myco.youling.cc:28322",
            "clients":[{"device":"did:myco:zOutDevice","targetPort":13911,"localPort":23911,"path":"Relay","alive":true}],
            "negativeCache":[{"device":"did:myco:zOutDevice","port":13911,"scope":"port","remainingMs":45000}],
            "blackholes":[]});
        let t = vnet_relay_text(&v);
        assert!(t.contains("myco.youling.cc:28322"), "{t}");
        assert!(t.contains("negativeCache（1）"), "{t}");
        assert!(t.contains("剩余 45000ms"), "{t}");
    }

    #[test]
    fn vnet_stun_text_handles_failure() {
        let bad = json!({"ok":false,"schema":1,"error":"NAT 探测超时（15s）"});
        assert!(vnet_stun_text(&bad).contains("NAT 探测超时"));
        let ok = json!({"ok":true,"schema":1,"publicAddr":"1.2.3.4:5","mapping":"EIM",
            "filtering":"APDF","difficulty":"Easy","strategy":"direct"});
        let t = vnet_stun_text(&ok);
        assert!(t.contains("public=1.2.3.4:5") && t.contains("mapping=EIM"), "{t}");
    }
}


