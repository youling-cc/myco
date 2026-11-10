//! p2p_e2e.rs — 第84轮：PC↔PC 双实例 P2P 直连 E2E（对拍式测试）。
//!
//! 手动成对跑（两个终端，wall-clock 对齐）：
//!   终端 A：MYCO_P2P_PORT=9100 cargo test --test p2p_e2e -- p2p_e2e_a --nocapture
//!   终端 B：MYCO_P2P_PORT=9105 cargo test --test p2p_e2e -- p2p_e2e_b --nocapture
//! （MYCO_CONFIG_DIR 在测试内按角色自设：A=D:\myco-dev-p2pa，B=D:\myco-dev-chat）
//!
//! 时序（秒）：双端 t=0 起 p2p 服务器+presence 上报 → A t=12 发消息（P2P 直推）→
//! B t=25 断言收件+回复 → A t=40 断言收到回复 → 双端主动对账 → 打印会话指纹 F
//! （人肉/脚本比对两侧 F hex 相同 = "活的历史"收敛）。
//!
//! 断言全在本进程本地存储；跨进程最终一致由两侧打印的 F_e2e 行比对。

//! 同 tests/p2p_e2e.rs 的逻辑，bin 形态（libtest harness 在无控制台环境异常静默，
//! bin + println 最直接）。用法：
//!   P2P_E2E_ROLE=a MYCO_P2P_PORT=9100 myco-p2p-e2e.exe
//!   P2P_E2E_ROLE=b MYCO_P2P_PORT=9105 myco-p2p-e2e.exe

use myco_home_lib::chat_service;
use myco_home_lib::p2p_client;
use myco_home_lib::p2p_server;
use serde_json::json;

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

/// 本侧角色（P2P_E2E_ROLE=a|b，缺省 a）。
fn role() -> String {
    std::env::var("P2P_E2E_ROLE").unwrap_or_else(|_| "a".into())
}

fn peer_account() -> String {
    // 对拍写死：A 侧对端 = B 账号（D:\myco-dev-chat 的 7S2Y…）；
    // B 侧对端 = A 账号（DC8T…）。与两目录 accounts.json 一致。
    match role().as_str() {
        "a" => "did:myco:7S2YE7Q6g2vx9mqZ4PsXUhszXJhjqCbFKnutmHhQ4cgb".into(),
        _ => "did:myco:DC8TKs2hbAZTfkuAWgSV3QuDPZBW1faiiKRiDyCpwE7L".into(),
    }
}

fn t_wait(sec: u64) {
    std::thread::sleep(std::time::Duration::from_secs(sec));
}

fn conv_of(peer: &str) -> String {
    peer.replace([':', '/'], "_")
}

/// 通用前置：隔离配置目录 + 起 p2p 服务器 + presence 立即上报（保在线）。
async fn setup() {
    let dir = match role().as_str() {
        "a" => "D:\\myco-dev-p2pa",
        _ => "D:\\myco-dev-chat",
    };
    std::env::set_var("MYCO_CONFIG_DIR", dir);
    // p2p 服务器（端口 MYCO_P2P_PORT）
    tokio::spawn(async move {
        let state: p2p_server::P2pState = p2p_server::P2pState {};
        let _ = state;
    });
    // 上面的空 spawn 只占位——真正服务器：
    tokio::spawn(async {
        // start_p2p_server 自带 bind 顺延与 P2P_PORT 写入
        let dummy: Option<tauri::AppHandle> = None;
        let _ = dummy;
        // 需要一个 AppHandle 参数——测试环境给 None 通道：
        <()>::default();
    });
}

fn main() {
    let rt = tokio::runtime::Runtime::new().expect("tokio rt");
    let side = role();
    let ch = if side == "a" { 'a' } else { 'b' };
    rt.block_on(async move {
        run_side(ch).await;
    });
    println!("[e2e-{}] done", ch);
}

async fn run_side(side: char) {
    std::env::set_var(
        "MYCO_CONFIG_DIR",
        if side == 'a' { "D:\\myco-dev-p2pa" } else { "D:\\myco-dev-chat" },
    );
    let peer = peer_account();
    let peer_conv = conv_of(&peer);
    println!("[e2e-{}] side start peer={}", side, peer.chars().take(28).collect::<String>());

    // ① 起 p2p 服务器（axum 后台）
    tokio::spawn(async { p2p_server::start_p2p_server_for_test().await });
    // ② presence 立即上报 + 周期保活（对端寻址靠它）
    tokio::spawn(async {
        loop {
            myco_home_lib::presence::refresh().await;
            tokio::time::sleep(std::time::Duration::from_secs(15)).await;
        }
    });
    // 等端口就绪
    for _ in 0..20 {
        if p2p_server::p2p_port() > 0 { break }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    println!("[e2e-{}] p2p port = {}", side, p2p_server::p2p_port());
    assert!(p2p_server::p2p_port() > 0, "p2p 服务器未起");

    if side == 'a' {
        // t=12：发消息（P2P 直推，B 应在 presence）
        t_wait(12);
        let mut delivered = false;
        let mut msg_id = String::new();
        for _ in 0..3 {
            let text = format!("第84轮 P2P E2E（A→B 直推）ts={}", now());
            let r = chat_service::chat_send(
                peer.clone(),
                "text".into(),
                json!({ "text": text }),
            ).await;
            match r {
                Ok(v) => {
                    delivered = v.get("delivered").and_then(|x| x.as_bool()).unwrap_or(false);
                    msg_id = v.get("msgId").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    println!("[e2e-a] sent msgId={} delivered={}", msg_id.chars().take(18).collect::<String>(), delivered);
                    break;
                }
                Err(e) => println!("[e2e-a] send err: {e}"),
            }
            t_wait(3);
        }
        assert!(!msg_id.is_empty(), "A 发送失败");
        // delivered 可能 false（B 未及时上线）——不 assert，靠对账兜底验证
        let _ = delivered;

        // t=40：应收到 B 回复（直推 或 对账）
        t_wait(28);
        let msgs = chat_service::conv_load_raw(&peer_conv);
        let got_reply = msgs.iter().any(|m| m.get("dir").and_then(|d| d.as_str()) == Some("in")
            && m.get("kind").and_then(|k| k.as_str()) == Some("text"));
        for m in &msgs { println!("[e2e-a] conv: {} {} {} {}", m.get("msgId").and_then(|x| x.as_str()).unwrap_or("?").chars().take(10).collect::<String>(), m.get("dir").and_then(|x| x.as_str()).unwrap_or("?"), m.get("kind").and_then(|x| x.as_str()).unwrap_or("?"), m.pointer("/payload/text").and_then(|x| x.as_str()).unwrap_or("")); }
        assert!(got_reply, "A 未收到 B 回复（直推+对账都未达）");

        // 主动对账 + 打印指纹（两轮：第二轮在对端保活窗口内）
        let got = p2p_client::sync_with_account(&peer).await;
        t_wait(6);
        let got2 = p2p_client::sync_with_account(&peer).await;
        let meta = myco_home_lib::p2p_sync::load_meta(&peer_conv);
        println!("[e2e-a] F_e2e={} n={} (sync got {}/{})", meta.f_hex, meta.n, got, got2);
    } else {
        // B 侧：t=25 检查收件 + 回复
        t_wait(25);
        let msgs = chat_service::conv_load_raw(&peer_conv);
        let recv = msgs.iter().find(|m| m.get("dir").and_then(|d| d.as_str()) == Some("in")
            && m.get("kind").and_then(|k| k.as_str()) == Some("text"));
        for m in &msgs { println!("[e2e-b] conv: {} {} {} {}", m.get("msgId").and_then(|x| x.as_str()).unwrap_or("?").chars().take(10).collect::<String>(), m.get("dir").and_then(|x| x.as_str()).unwrap_or("?"), m.get("kind").and_then(|x| x.as_str()).unwrap_or("?"), m.pointer("/payload/text").and_then(|x| x.as_str()).unwrap_or("")); }
        assert!(recv.is_some(), "B 未收到 A 直推消息");
        let r = chat_service::chat_send(peer.clone(), "text".into(), json!({ "text": format!("B→A 回复 ts={}", now()) })).await;
        println!("[e2e-b] reply delivered={:?}", r.ok().and_then(|v| v.get("delivered").and_then(|x| x.as_bool())));

        // 主动对账 + 打印指纹（与 A 侧 F_e2e 比对）
        t_wait(10);
        let got = p2p_client::sync_with_account(&peer).await;
        let meta = myco_home_lib::p2p_sync::load_meta(&peer_conv);
        println!("[e2e-b] F_e2e={} n={} (sync got {})", meta.f_hex, meta.n, got);
        // 再对账一轮（A 侧的同步窗口在 t≈41——B 保活到 t≈65 让 A 连得上）
        t_wait(8);
        let got2 = p2p_client::sync_with_account(&peer).await;
        let meta2 = myco_home_lib::p2p_sync::load_meta(&peer_conv);
        println!("[e2e-b] F_e2e_final={} n={} (sync2 got {})", meta2.f_hex, meta2.n, got2);
        t_wait(10);
    }
}
