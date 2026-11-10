//! presence_sched_diag.rs — 2026-10-09 灭灯修复的冒烟诊断（非产品码，可整段删除）。
//!
//! 用途：在**计划任务环境**里跑产线同款心跳循环（presence::heartbeat_loop），
//! 验证 20s 周期心跳在「启动后无人触碰」的机器上持续落表——旧实现（select 里每轮
//! 重建 sleep(20s)，被 2s 状态轮询饿死）只有启动首报一拍，90s TTL 后出表灭灯，
//! 这正是「计划任务启动 presence 不工作、双击正常」（伪相关：交互掩盖饥饿）的根因。
//!
//! 编排（三个角色）：
//!   ① 本地 identity-svc（绝不碰生产）：
//!      PORT=18321 DB_PATH=<临时> node services/identity-svc/identity-server.mjs
//!   ② 注册计划任务跑本 bin（与用户 myco-test 同款 principal）：
//!      presence_sched_diag.exe --config-dir <隔离目录> --base http://127.0.0.1:18321 --run-secs 100
//!   ③ 本 bin 每 10s 签名查 /presence/list 打印自己 lastSeen 的推进轨迹；结束时给
//!      online 判决（run-secs > 90s TTL：旧实现此刻必 offline——首报已出表；
//!      修复后 lastSeen 距今 ≤20s、online=true）。
//!
//! --config-dir/--base 经参数注入后 set_var（计划任务进程拿不到 shell 会话 env；
//! presence.rs 的 base_url()/core 的 config_dir() 每次现读 env，无缓存，set 后生效）。

use base64::Engine as _;
use ed25519_dalek::Signer as _;
use myco_home_lib::presence;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 签名查 /presence/list，返回自己条目的 (online, lastSeen)。签名材料与
/// presence.rs signed_post 同构：X-Myco-Auth = did.ts.sig，签 `did\nts\nrawBody`。
async fn list_self(base: &str, did: &str, seed_b64: &str) -> Result<Option<(bool, u64)>, String> {
    use base64::engine::general_purpose::STANDARD as b64;
    let seed = b64.decode(seed_b64).map_err(|e| e.to_string())?;
    let arr: [u8; 32] = seed.try_into().map_err(|_| "seed != 32B".to_string())?;
    let sk = ed25519_dalek::SigningKey::from_bytes(&arr);
    let raw = "{}";
    let ts = now_ms();
    let sig = sk.sign(format!("{did}\n{ts}\n{raw}").as_bytes());
    let auth = format!("{did}.{ts}.{}", b64.encode(sig.to_bytes()));
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let r = http
        .post(format!("{base}/presence/list"))
        .header("X-Myco-Auth", auth)
        .header("content-type", "application/json")
        .body(raw)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = r.status();
    let text = r.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("list status={status} body={}", &text[..text.len().min(120)]));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let now = now_ms();
    let me = v["data"]
        .as_array()
        .and_then(|a| a.iter().find(|e| e["did"].as_str() == Some(did)))
        .map(|e| (true, e["lastSeen"].as_u64().unwrap_or(0)));
    Ok(me.map(|(_, ls)| (now.saturating_sub(ls) < 90_000, ls)))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let get = |k: &str| {
        args.iter()
            .position(|a| a == k)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let cfg = get("--config-dir").expect("--config-dir <dir> 必填（隔离身份域，绝不碰真实 %APPDATA%\\youling）");
    let base = get("--base").expect("--base <url> 必填（指向本地 identity-svc，绝不碰生产）");
    let run_secs: u64 = get("--run-secs")
        .map(|s| s.parse().expect("--run-secs <u64>"))
        .unwrap_or(100);
    // 必须在任何 config_dir()/base_url() 调用前设置（二者每次现读 env）
    std::env::set_var("MYCO_CONFIG_DIR", &cfg);
    std::env::set_var("MYCO_DID_BASE", &base);
    println!("[diag] config-dir={cfg} base={base} run-secs={run_secs}");
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    rt.block_on(async move {
        let (did, seed_b64) = myco_core::identity::device_identity().expect("device_identity");
        println!("[diag] did={did}（隔离目录首次运行会生成新设备钥）");
        // 观察者：每 10s 记一次服务端视角的 lastSeen 推进轨迹（心跳节律的服务器真值）
        let obs = tokio::spawn({
            let did = did.clone();
            let base = base.clone();
            let seed_b64 = seed_b64.clone();
            async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    match list_self(&base, &did, &seed_b64).await {
                        Ok(Some((online, ls))) => println!(
                            "[diag][t+10s] server: online={online} lastSeenAge={}s",
                            (now_ms().saturating_sub(ls)) / 1000
                        ),
                        Ok(None) => println!("[diag][t+10s] server: 不在 presence 表（已出表/从未入表）"),
                        Err(e) => println!("[diag][t+10s] list 查询失败: {e}"),
                    }
                }
            }
        });
        // 产线同款心跳循环，限定运行窗口（heartbeat_loop 永不返回，select 抢占结束）
        let hb = tokio::spawn(presence::heartbeat_loop());
        tokio::time::sleep(std::time::Duration::from_secs(run_secs)).await;
        hb.abort();
        obs.abort();
        // 终局判决：run_secs > 90s TTL 时，旧实现此刻必然 offline（首报已出表）
        match list_self(&base, &did, &seed_b64).await {
            Ok(Some((online, ls))) => println!(
                "[diag] 判决: online={online} lastSeenAge={}s（修复预期 online=true 且 age≤20s；旧实现 age>{run_secs}s）",
                (now_ms().saturating_sub(ls)) / 1000
            ),
            Ok(None) => println!("[diag] 判决: 不在 presence 表 → 灭灯（旧实现的行为）"),
            Err(e) => println!("[diag] 判决查询失败: {e}"),
        }
    });
}
