//! vnet connection manager - racing + continuous probing + auto-switching
//! One process = one relay socket = one registered address.
//! All threads share this socket so the relay always knows where to send data.

use crate::pathpipe::{index_of, PathPipe, PipeKind, RPolicy};
use crate::relay::RelayClient;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// 进程启动时刻（轨迹日志的相对时间基准）
static BOOT_AT: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

/// 带毫秒时间戳的连接级轨迹日志。
/// 目的：RDP 卡顿时能对齐「哪一条连接、哪一秒、卡在哪个阶段」，
/// 不再靠一堆无时间戳的 println 猜。只在关键事件打，不刷屏。
#[macro_export]
macro_rules! tracelog {
    ($($arg:tt)*) => {{
        let boot = $crate::connection::boot_instant();
        let ms = boot.elapsed().as_millis();
        println!("  [T+{:>7}ms] {}", ms, format!($($arg)*));
    }};
}

/// relay 侧 ARQ srtt（ms），0 = 未知。由 keepalive 线程每秒发布。
/// 为什么需要它：relay pipe 没有自己的探针，`rtt_evidence_ms()` 永远 None →
/// RTT 倒挂防御（p2p > 1.5×relay 则留 relay）的 `(Some, Some)` 永不成立。
/// 2026-11-09 DSH F2 实测暴露：path=P2P IPv6 且 pipe_v6 rtt=86ms，而 relay 只有 35ms，
/// 防御没触发（relay 基线缺失），把用户切到一条慢 2.5× 的路径上。
static RELAY_RTT_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
// 2026-11-13 DSH 审计：IPv6 探测发包成败计数（原来 `let _ = send_to` 静默吞）。
// 作用：pipe_v6 req>0 但 rep=0 时区分「对端不应答」vs「本机发包即失败」。
static V6_SEND_OK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static V6_SEND_FAIL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
// 2026-11-13 DSH 判读需求：server 侧 per-path 收包字节计数。
// 用途：两端「path 显示不一致」时用实际字节流归因——p2p_rx_bytes 涨 = 数据真走 P2P。
static SRV_P2P_RX_BYTES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static SRV_RELAY_RX_BYTES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 发布 relay RTT 基线（keepalive 线程调用）
pub fn note_relay_rtt(ms: u64) {
    RELAY_RTT_MS.store(ms, std::sync::atomic::Ordering::Relaxed);
}

/// 读取 relay RTT 基线（0 = 未知）
pub fn relay_rtt_ms() -> Option<u64> {
    match RELAY_RTT_MS.load(std::sync::atomic::Ordering::Relaxed) {
        0 => None,
        ms => Some(ms),
    }
}
pub fn boot_instant() -> Instant {
    *BOOT_AT.get_or_init(Instant::now)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DataPath {
    Relay,
    P2PUdp,
    P2PIpv6,
}

impl DataPath {
    pub fn name(&self) -> &'static str {
        match self {
            DataPath::Relay => "Relay",
            DataPath::P2PUdp => "P2P UDP",
            DataPath::P2PIpv6 => "P2P IPv6",
        }
    }
    pub fn is_direct(&self) -> bool { !matches!(self, DataPath::Relay) }
}

/// DataPath <-> PipeKind 映射（决策层只认 PipeKind，执行层只认 DataPath）
fn data_path_kind(p: DataPath) -> PipeKind {
    match p {
        DataPath::Relay => PipeKind::Relay,
        DataPath::P2PUdp => PipeKind::P2pV4,
        DataPath::P2PIpv6 => PipeKind::P2pV6,
    }
}

/// A（动作执行体）：把 pick_pipe 的决议落到 path / p2p 通道上。
/// - Relay：直接切（清 P2P 通道，复用「P2P->Relay 清通道」既有语义）
/// - 直连：目标族通道存在才切（Relay->P2p 由通道存在性决定）；
///   首选族暂无通道、但现有通道族仍可选时，落到现有通道族（直连优先，下一事件再升级）
/// 锁纪律：逐条获取、立即释放，绝不嵌套（RDV6 verify 块存在 p2p->path 序，反向嵌套会死锁）。
/// 切换计数（path_switches）由本函数统一维护——「含义不变，只改由谁递增」。
fn apply_decision(
    pipes: &Arc<Mutex<Vec<PathPipe>>>,
    policy: &RPolicy,
    path: &Arc<Mutex<DataPath>>,
    p2p: &Arc<Mutex<P2pRegistry>>,
    switches: &Arc<Mutex<u32>>,
) {
    let pick = {
        let mut ps = pipes.lock().unwrap();
        for p in ps.iter_mut() {
            p.update_derived(policy);
        }
        crate::pathpipe::pick_pipe(&ps, policy)
    };
    let cur_kind = data_path_kind(*path.lock().unwrap());
    if pick == cur_kind {
        // 稳定在同一选择 → 重置待定计数（防偶发抖动累积）
        STABLE_PICK_COUNT.store(0, Ordering::Relaxed);
        return;
    }
    // ── 滞回（hysteresis）：升级需连续 N 次同一选择才执行，降级立即 ──
    // 场景：P2P 证据短暂波动导致 pick 在 Relay/P2P 间快速跳变。
    // 不加这个，实测 1675 轮探测产生 15539 次切换（≈9 次/轮）。
    if pick != PipeKind::Relay {
        let prev = STABLE_PENDING_KIND.load(Ordering::Relaxed);
        if prev == pick as u64 {
            let cnt = STABLE_PICK_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
            if cnt < HYSTERESIS_N {
                return; // 还不够稳定，继续等
            }
        } else {
            STABLE_PENDING_KIND.store(pick as u64, Ordering::Relaxed);
            STABLE_PICK_COUNT.store(1, Ordering::Relaxed);
            return; // 第一次选它，从 1 开始计
        }
    } else {
        // 降级到 Relay：立即执行，不等（数据面停滞不能多等）
        STABLE_PICK_COUNT.store(0, Ordering::Relaxed);
    }
    // VNET_NO_P2P=1 诊断门：绝不升级离 Relay（纯中继对照语义）。
    // 中央 choke 点——无论哪个线程的观察/调用，诊断开关全局成立。降级不受影响。
    if pick != PipeKind::Relay
        && std::env::var("VNET_NO_P2P").unwrap_or_default() == "1"
    {
        return;
    }
    // ── RTT 倒挂防御（2026-11-09，BANDWIDTH §3.4 推论）──
    // 跨 ISP 直连 RTT 可能高于中继（如移动↔电信 v6 绕行 80–120ms vs relay ~40ms）。
    // P2P RTT > 1.5× relay RTT 时不升级——留在中继（数据面更快）。
    // 仅在两端 RTT 证据齐备时比较；任一缺失 = 不比较（保持既有行为）。
    if pick != PipeKind::Relay {
        let (relay_rtt, p2p_rtt) = {
            let ps = pipes.lock().unwrap();
            let relay_rtt = ps.iter()
                .find(|p| p.kind == PipeKind::Relay)
                .and_then(|p| p.rtt_evidence_ms());
            let p2p_rtt = ps.iter()
                .find(|p| p.kind == pick)
                .and_then(|p| p.rtt_evidence_ms());
            (relay_rtt, p2p_rtt)
        };
        // relay pipe 没有自己的探针 → rtt_evidence_ms() 恒 None，防御永不触发（2026-11-09
        // DSH F2 实际撞上：path=P2P IPv6、直连 86ms，而 relay 只有 35ms）。用 keepalive
        // 发布的 relay ARQ srtt 兜底。
        let relay_rtt = relay_rtt.or_else(relay_rtt_ms);
        if crate::pathpipe::rtt_inversion(relay_rtt, p2p_rtt) {
            println!("  [PATH] RTT inversion guard: p2p={:?}ms > relay={:?}ms×1.5 -> stay relay",
                p2p_rtt, relay_rtt);
            return;
        }
    }
    // 黑盒回归修复：只认**已通过双向验证的通道**（REQUEST 敲门创建的未验证通道
    // 不承载业务——管道级 verified 可能来自另一个 socket 的证据，不能背书槽内通道）
    // 不再要求 active：active 只在 EXP2 verify PASS 设置，打洞胜出的已验证通道
    // 从不经 EXP2，按 active 判定会把「打洞成功但 path 永远 Relay」锁死。
    let chan_kind = {
        let g = p2p.lock().unwrap();
        let cands = g.verified_candidates();
        if cands.iter().any(|c| c.is_ipv6) {
            Some(PipeKind::P2pV6)
        } else if !cands.is_empty() {
            Some(PipeKind::P2pV4)
        } else {
            None
        }
    };
    // 通道约束下的有效目标
    let want = match pick {
        PipeKind::Relay => Some(PipeKind::Relay),
        k => {
            if chan_kind == Some(k) {
                Some(k)
            } else if let Some(ck) = chan_kind {
                // 首选族无通道：现有通道族仍可选则先用它（直连优先）
                let selectable = {
                    let ps = pipes.lock().unwrap();
                    let pp = &ps[index_of(ck)];
                    pp.s_selectable && pp.o_ack_ratio >= policy.r_min_ack_ratio
                };
                if selectable { Some(ck) } else { None }
            } else {
                None
            }
        }
    };
    let want = match want {
        Some(k) if k != cur_kind => k,
        _ => return,
    };
    let new_path = match want {
        PipeKind::Relay => DataPath::Relay,
        PipeKind::P2pV4 => DataPath::P2PUdp,
        PipeKind::P2pV6 => DataPath::P2PIpv6,
    };
    *path.lock().unwrap() = new_path;
    // 黑盒回归修复：证据降级不清 P2P 通道（与原 30s 兜底语义一致）。清通道 =
    // ARQ 序号归零，对端在途流在 64 窗口内把新包全判重复吞掉（5/5 超时的
    // 另一台发动机）。真死通道由调用方在调用点清（watchdog 停滞 / forward 发送失败）。
    *switches.lock().unwrap() += 1;
    println!("  [PATH] decision: {:?} -> {:?} (evidence-based)", cur_kind, want);
}

/// 黑盒回归修复（跨流污染）：收到密封数据帧的 socket 与槽内通道的 socket 不一致时，
/// 该帧属于已被替换/已清掉的旧通道（对端旧流的残余重传）——用新流的接收器处理它
/// 只会把幽灵包灌进乱序缓存、污染接收窗，把后续真包永远堵在缓存里。丢弃（限流打印）。
fn drop_ghost(tag: &str) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let k = N.fetch_add(1, Ordering::Relaxed);
    if k < 3 {
        println!("  [PATH] drop frame for foreign channel ({})", tag);
    }
}

/// 多连接数据分发中心。
///
/// 背景：早期实现里客户端是「accept → forward()（阻塞跑完）→ 再 accept」，
/// 只要有一条连接的对端不发 EOF（例如客户端进程挂住、socket 未关），
/// up 线程就会永远自旋，forward() 永不返回，accept 循环被永久堵死，
/// 整条隧道数据面卡死（30 分钟验收实测在第 2111 条连接后复现）。
///
/// 现在每条连接有自己的队列，accept 循环把 forward 丢到线程里，互不阻塞。
///
/// 路由（2026-11-08 R12 正修）：relay 路径的下行按 **stream id** 入队——
/// 每条应用连接一个 id（ARQ 载荷带 3 字节内层头 [tag][stream:2]），
/// 不同连接的字节流互不可见。旧「owner = 最近上行发送者」路由是 R12 RED 的根因之一：
/// 同 peer 第二条连接 accept 即抢走 owner，在服务连接的回包被偷进新连接的队列。
/// P2P 路径暂保留 owner 语义（单连接假设，多路复用 phase 2 落地后退役）。
pub struct StreamQ {
    pub queue: std::collections::VecDeque<Vec<u8>>,
    /// 收到对端 STREAM_END(stream)：队列排空后由 down 线程优雅关闭
    pub ended: bool,
    /// 观测：本连接上行进入 ARQ 的应用字节（回答「上行发了多少」）
    pub up_bytes: u64,
    /// 观测：本连接下行交付到应用的字节（回答「下行到了多少」）
    pub down_bytes: u64,
    /// 内存安全 cap（2026-11-10）：队列当前字节数。超过 HUB_STREAM_CAP_BYTES
    /// 时打 WARN 并拒绝入队（背压信号——发送端因 ACK 停滞自动减速）。
    /// 默认 4MB/流：20 并发峰值实测 ~9MB，4MB/流 × 20 流 = 80MB 上限。
    pub queued_bytes: usize,
}

/// Hub 每流队列内存上限（字节）。可用 VNET_HUB_CAP_MB 覆盖（单位 MB）。
fn hub_stream_cap_bytes() -> usize {
    std::env::var("VNET_HUB_CAP_MB").ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(4) * 1024 * 1024
}

impl StreamQ {
    fn new() -> Self {
        Self { queue: std::collections::VecDeque::new(), ended: false, up_bytes: 0, down_bytes: 0, queued_bytes: 0 }
    }
}

pub struct ConnHub {
    next_id: u16,
    /// P2P 路径（phase 2 前）的下行路由：最近一次经直连上行的连接
    p2p_owner: Option<u16>,
    streams: std::collections::HashMap<u16, StreamQ>,
}

impl ConnHub {
    /// 流 id 基点随机化（2026-11-10 串扰事故）：
    /// 两个 vnet 进程的流 id 都从 1 顺序编号，同 peer_id 互抢路由时错端帧
    /// 会精确落进对端的同号活流（替换型损坏：同字节数不同 SHA）。基点随机
    /// = 每个连接实例把身份藏进每帧的 [tag][stream:2]（零线上格式变更），
    /// 错端帧几乎必然命中未知流被丢弃——损坏从「静默替换」降级为「可检测截断」。
    /// 这与 relay 侧占位退位是两层独立防线（本层兜住跨机同 peer_id 残留）。
    fn random_stream_base() -> u16 {
        use std::hash::Hasher;
        use std::sync::atomic::{AtomicU64, Ordering};
        static CTR: AtomicU64 = AtomicU64::new(0);
        let mut h = std::collections::hash_map::DefaultHasher::new();
        h.write_u32(std::process::id());
        h.write_u64(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64).unwrap_or(0));
        h.write_u64(CTR.fetch_add(1, Ordering::Relaxed));
        let v = h.finish() as u16;
        if v == 0 { 1 } else { v }   // 0 保留给 relay-socket P2P 入站聚合
    }

    pub fn new() -> Self {
        Self { next_id: Self::random_stream_base(), p2p_owner: None, streams: std::collections::HashMap::new() }
    }
    /// 注册一条应用连接，返回它的 stream id（线上身份）。
    /// u16 环绕；跳过 0（0 保留给 relay-socket P2P 入站聚合）与在用 id。
    pub fn register(&mut self) -> u16 {
        loop {
            self.next_id = self.next_id.wrapping_add(1);
            if self.next_id != 0 && !self.streams.contains_key(&self.next_id) {
                let id = self.next_id;
                self.streams.insert(id, StreamQ::new());
                return id;
            }
        }
    }
    pub fn unregister(&mut self, id: u16) {
        self.streams.remove(&id);
        if self.p2p_owner == Some(id) { self.p2p_owner = None; }
    }
    /// relay 路径：按 stream id 入队（多路复用核心）
    pub fn push_stream(&mut self, stream: u16, data: Vec<u8>) {
        use std::sync::atomic::Ordering as DO;
        let pn = DIAG_HUB_PUSH.fetch_add(1, DO::Relaxed);
        if data.len() > 1100 || pn < 20 {
            println!("  [DIAG] HUB_PUSH#{}: {}B stream={}",
                pn, data.len(), stream);
        }
        tracelog!("[cli] downlink deliver {}B stream={}", data.len(), stream);
        // 防泄漏：ARQ ACK 帧头（type=2, 11 字节全零头）绝不该出现在应用载荷中。
        // 极低频出现（2/~500 连接），根因疑似通道重建 + ARQ reset 时序竞争导致
        // verify 的 ACK 帧被误交付。过滤并打日志，不清根因但保证应用面干净。
        if data.len() == 11 && data[0] == 0x02 && data[1..11] == [0u8; 10] {
            eprintln!("[HUB-LEAK] filtered ARQ ACK frame header from app payload");
            return;
        }
        if let Some(q) = self.streams.get_mut(&stream) {
            // 内存安全 cap（2026-11-10）：down 线程写慢时队列堆积防护。
            // 超限时拒绝入队 + WARN——发送端因接收端 ACK 停滞自然减速（背压）。
            // 丢的帧会导致该流字节流断裂，但比 OOM 崩溃好得多。
            let cap = hub_stream_cap_bytes();
            if q.queued_bytes + data.len() > cap {
                static CAP_WARN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
                let w = CAP_WARN.fetch_add(1, DO::Relaxed);
                if w < 10 || w % 100 == 0 {
                    eprintln!("[HUB-CAP] stream={} queued={}B + {}B > cap={}B — dropping (backpressure, warn#{})",
                        stream, q.queued_bytes, data.len(), cap, w);
                }
                return; // 拒绝入队：丢这一帧，发送端会因 ACK 停滞减速
            }
            q.queued_bytes += data.len();
            q.down_bytes += data.len() as u64;
            q.queue.push_back(data);
        }
        // 未知 stream（对端残留旧流/已关闭）：静默丢弃并留观测
        else if pn < 20 || pn % 100 == 0 {
            println!("  [HUB] drop {}B for unknown stream={}", data.len(), stream);
        }
    }
    /// P2P 路径（phase 2 多路复用）：解内层帧按流分发。
    /// 对端（server）下行的每个交付项都是完整内层帧（client 发送侧按
    /// stream_chunk() 包帧 + TunnelStream 分块 1100/1200 > 帧长，边界不拆）。
    /// 未成帧字节（旧版本对端）回落 owner 队列——兼容窗口内单连接仍可用。
    pub fn push_p2p_frame(&mut self, data: Vec<u8>) {
        match crate::transport::parse_stream_frame(&data) {
            Some((crate::transport::STREAM_TAG_DATA, sid, rest)) => {
                self.push_stream(sid, rest.to_vec());
            }
            Some((crate::transport::STREAM_TAG_STREAM_END, sid, _)) => {
                self.mark_ended(sid);
            }
            Some((_other_tag, _sid, _)) => {
                // server 不会下行 SESSION_START/FIN；未知 tag 静默（观测在 push_stream）
            }
            None => {
                // 旧对端裸字节：回落 owner（单连接兼容）
                self.push_owner(data);
            }
        }
    }
    /// P2P 路径（兼容保留）：投给最近经直连上行的连接
    pub fn push_owner(&mut self, data: Vec<u8>) {
        if let Some(id) = self.p2p_owner {
            self.push_stream(id, data);
        }
    }
    /// P2P 路径上行时认领 owner
    pub fn claim_owner(&mut self, id: u16) { self.p2p_owner = Some(id); }
    /// 对端 STREAM_END(stream)：标记该流排空后关闭
    pub fn mark_ended(&mut self, stream: u16) {
        if let Some(q) = self.streams.get_mut(&stream) { q.ended = true; }
    }
    pub fn is_ended(&self, stream: u16) -> bool {
        self.streams.get(&stream).map(|q| q.ended).unwrap_or(true)
    }
    pub fn add_up_bytes(&mut self, stream: u16, n: u64) {
        if let Some(q) = self.streams.get_mut(&stream) { q.up_bytes += n; }
    }
    pub fn pop(&mut self, id: u16) -> Option<Vec<u8>> {
        let item = self.streams.get_mut(&id).and_then(|q| q.queue.pop_front());
        if let Some(ref d) = item {
            if let Some(q) = self.streams.get_mut(&id) {
                q.queued_bytes = q.queued_bytes.saturating_sub(d.len());
            }
        }
        item
    }
    pub fn pending(&self, id: u16) -> usize {
        self.streams.get(&id).map(|q| q.queue.len()).unwrap_or(0)
    }
    /// 观测：连接关闭时取回双向字节计数（一行回答「上行多少/下行多少」）
    pub fn take_counters(&mut self, id: u16) -> (u64, u64) {
        self.streams.get(&id).map(|q| (q.up_bytes, q.down_bytes)).unwrap_or((0, 0))
    }
}

/// 运行态状态文件路径。`VNET_STATUS_FILE` 可覆盖，默认写到系统临时目录。
/// 供 `vnet status` 读取——运行中的进程每秒刷新一次。
pub fn status_file_path() -> std::path::PathBuf {
    match std::env::var("VNET_STATUS_FILE") {
        Ok(p) if !p.is_empty() => std::path::PathBuf::from(p),
        _ => std::env::temp_dir().join("vnet-status.txt"),
    }
}

/// 按 role+peer_id 分文件，避免同机多实例（server/client）互相覆盖。
/// 之前只用单一 vnet-status.txt，server 不写、client 写，导致 `vnet status`
/// 在 server 机器上读到的是历史残留的 client 文件（已实测踩到）。
/// ── 同进程 peer_id 冲突防护（2026-11-10 串扰经验沉淀）──
/// 同一进程内两个 Connection 用同一 peer_id → relay 路由互抢 → 帧串扰 →
/// 替换型数据损坏（同字节数不同 SHA）。创建时即拒绝重复 peer_id。
static ACTIVE_PEER_IDS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<u32>>> =
    std::sync::OnceLock::new();

fn active_peer_ids() -> &'static std::sync::Mutex<std::collections::HashSet<u32>> {
    ACTIVE_PEER_IDS.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

fn peer_id_try_acquire(peer_id: u32) -> anyhow::Result<()> {
    let mut ids = active_peer_ids().lock().unwrap();
    if ids.contains(&peer_id) {
        anyhow::bail!(
            "PEER_ID_IN_USE: peer_id {} already has an active Connection in this process. \
             Two Connections with the same peer_id will fight over the relay's routing table \
             (cross-talk: frames delivered to wrong endpoint, data corruption). \
             Use a unique peer_id per Connection.",
            peer_id
        );
    }
    ids.insert(peer_id);
    Ok(())
}

fn peer_id_release(peer_id: u32) {
    active_peer_ids().lock().unwrap().remove(&peer_id);
}
/// FFI 宿主显式释放 server 侧注册占位（peer_id + target_port 表）。
///
/// 为什么必须有（2026-11-12 真机 ADB 卡 stop→start 恒定 rc=4 实案）：FFI 的
/// `vnet_server_stop` 只置 run 标志，而 [`Connection::stop`] 才是 `peer_id_release`
/// 的唯一调用点。`start_server_full` 构造成功后把守卫所有权交给 Connection，但
/// FFI 只保存 run 标志、Connection 随即 drop → `stop()` 永远不被调用 → peer_id
/// 永久留在集合里 → 同进程第二次 start 恒 `PEER_ID_IN_USE`（rc=4）。客户端路径
/// 因为持有 Connection 并调 `conn.stop()` 不受影响。
pub(crate) fn release_server_registrations(peer_id: u32) {
    peer_id_release(peer_id);
    server_port_unregister(peer_id);
}

/// 构造期 peer_id 占位的 RAII 守卫（2026-11-11 手机 rc=4 真案）。
///
/// 事故：`peer_id_try_acquire` 把 id 塞进全局集合，只有 `Connection::stop()` 才
/// 释放。而 [`Connection::with_secret_and_port`] 在 acquire 之后还有 relay 注册
/// （5 次退避重试）与 STUN 公告——任何一步失败都走 `?` 提前返回，id 便永久留在
/// 集合里；之后同 id 的每次 start 都在第一行秒失败 `PEER_ID_IN_USE`，宿主只看到
/// 一个恒定的 rc=4（VNET_ERR_INTERNAL），永远自愈不了（手机端实测 4/4 全失败）。
///
/// 约定：构造成功即把所有权**交接**给 Connection（此后由 stop() 释放）；
/// 构造失败则 Drop 自动释放，下一次尝试仍然有机会。
struct PeerIdGuard {
    peer_id: u32,
    armed: bool,
}

impl PeerIdGuard {
    fn acquire(peer_id: u32) -> anyhow::Result<Self> {
        peer_id_try_acquire(peer_id)?;
        Ok(Self { peer_id, armed: true })
    }

    /// 所有权交接给 Connection：Drop 不再释放。
    fn hand_off(mut self) {
        self.armed = false;
    }
}

impl Drop for PeerIdGuard {
    fn drop(&mut self) {
        if self.armed {
            peer_id_release(self.peer_id);
        }
    }
}

/// ── 同进程 target_port 冲突防护（2026-11-11 DSH 坏包定位）──
/// myco embedding 中固定口隧道 server 与 multi-forward server 可能并存且
/// 都指向同一个上游端口（如 13911）。两条 server 的 up-thread 各自连上游，
/// 上游的 keep-alive 连接池在两条 server 的 upstream TCP 间摆动 → 同一 HTTP
/// 响应的不同部分经不同 server 发给客户端 → 32KB（2×16KB 读块）交织坏包。
/// vnet 侧防护：检测到同进程两条 server 指向同 target_port → WARN（不阻止，
/// 因为 multi-forward 场景下多 server 同口是合法的——但 embedding 需要知道）。
static ACTIVE_SERVER_PORTS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<u16, Vec<u32>>>> =
    std::sync::OnceLock::new();

fn active_server_ports() -> &'static std::sync::Mutex<std::collections::HashMap<u16, Vec<u32>>> {
    ACTIVE_SERVER_PORTS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn server_port_register(peer_id: u32, target_port: u16) {
    let mut ports = active_server_ports().lock().unwrap();
    let peers = ports.entry(target_port).or_insert_with(Vec::new);
    if !peers.contains(&peer_id) {
        peers.push(peer_id);
        if peers.len() > 1 {
            eprintln!("  [WARN] SERVER-PORT-OVERLAP: {} vnet servers now target port {} (peer_ids: {:?}) — \
                if upstream uses connection pooling, responses may be split across servers causing data interleaving",
                peers.len(), target_port, peers);
        }
    }
}

fn server_port_unregister(peer_id: u32) {
    let mut ports = active_server_ports().lock().unwrap();
    for (_, peers) in ports.iter_mut() {
        peers.retain(|&p| p != peer_id);
    }
    ports.retain(|_, peers| !peers.is_empty());
}

// ── 同机跨进程 peer_id 冲突防护（2026-11-10 串扰经验沉淀）──
// 同进程防护见 peer_id_try_acquire；这里是跨进程面。事故链（实测 same_peer 复现）：
//   同机两个 vnet 进程用同一 peer_id 注册 relay（旧进程残留 + 新进程启动）
//   → relay peer 表 last-write-wins，双方 5s 周期续租互抢映射
//   → server 下行帧在两个地址间振荡投递；两进程的流 id 都从 1 编号，
//     错端帧精确落进对端同号活流 = 替换型数据损坏（同字节数不同 SHA）
//   → 错端还替正主 ACK → server 清掉在途帧 → 正主流永久空洞（截断）。
// relay（C 二进制）无法区分同 peer_id 的两个地址，vnet 侧唯一可靠共享事实是
// 「同一台机器」——用本机占位文件做 newcomer-wins 交接（与 relay 语义一致）：
//   启动 steal：无条件覆盖现存占位 = 新进程接管；
//   运行 poll：持有人每周期心跳续写；连续 3 次看到「别的活进程的新鲜占位」
//     → 本进程退位（停续租、关监听、注销），让 relay 映射稳定在新进程上；
//   自愈：占位超过新鲜窗无心跳 = 持有人已死 → 自动夺回继续服务。
// 边界：仅覆盖同机同用户（%TEMP% 共享）；跨机同 peer_id 仍需 relay 侧
// 连接身份（见随机流 id 基点的兜底防线）。
const CLAIM_FRESH: Duration = Duration::from_secs(10);
const CLAIM_YIELD_AFTER: u32 = 3;

/// 占位体检结果
#[derive(Debug, PartialEq, Eq)]
enum ClaimPoll {
    /// 占位是自己的（或不存在）→ 已心跳/重占
    Hold,
    /// 别的活进程持有（计入退位倒计时，尚未到阈值）
    ForeignLive,
    /// 连续多次发现别的活进程占位 → 必须退位
    Superseded,
    /// 原持有人已死，占位被本进程夺回
    Retaken,
    /// 文件暂不可读（并发写的瞬态）→ 本轮跳过
    Unknown,
}

/// 同机 peer_id 占位监视器。一个 Connection/server 实例一个。
struct PeerClaim {
    path: std::path::PathBuf,
    my_pid: u32,
    /// 连续看到「别的活进程新鲜占位」的次数（见到自己/死占位即清零）
    foreign_streak: u32,
}

/// 读占位文件：返回 (pid, 占位年龄)。None = 文件缺失/瞬态不可读/格式坏。
fn read_claim(path: &std::path::Path, now: std::time::SystemTime) -> Option<(u32, Duration)> {
    let meta = std::fs::metadata(path).ok()?;
    let pid = std::fs::read_to_string(path).ok()?
        .lines()
        .find_map(|l| l.strip_prefix("pid=").and_then(|v| v.trim().parse::<u32>().ok()))?;
    let age = meta.modified().ok()
        .and_then(|m| now.duration_since(m).ok())
        .unwrap_or(Duration::ZERO);
    Some((pid, age))
}

/// 原子写占位（tmp + rename，读端不会看到半截文件）。
/// pid 由调用者给定（生产 = 本进程 pid；单测注入不同 pid 模拟跨进程）。
fn write_claim(path: &std::path::PathBuf, pid: u32, role: &str) {
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, format!("pid={}\nrole={}\n", pid, role)).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

impl PeerClaim {
    fn path_for(dir: &std::path::Path, peer_id: u32) -> std::path::PathBuf {
        dir.join(format!("vnet-peer-claim-{}.txt", peer_id))
    }

    /// 启动即占位（newcomer-wins：无条件覆盖现存占位，与 relay last-write-wins 一致）。
    fn steal(dir: &std::path::Path, peer_id: u32, role: &str) -> Self {
        Self::steal_with_pid(dir, peer_id, std::process::id(), role)
    }

    /// 单测注入 pid 模拟「另一个进程」。
    fn steal_with_pid(dir: &std::path::Path, peer_id: u32, pid: u32, role: &str) -> Self {
        let path = Self::path_for(dir, peer_id);
        if let Some((old_pid, age)) = read_claim(&path, std::time::SystemTime::now()) {
            if old_pid != pid && age < CLAIM_FRESH {
                println!("  [CLAIM] peer_id {} held by live pid={} ({:?} ago) — taking over (newcomer wins)",
                    peer_id, old_pid, age);
            }
        }
        write_claim(&path, pid, role);
        Self { path, my_pid: pid, foreign_streak: 0 }
    }

    /// 周期体检（可注入时钟便于单测）。
    fn poll_at(&mut self, now: std::time::SystemTime) -> ClaimPoll {
        match read_claim(&self.path, now) {
            // 自己持有：心跳续写，清零倒计时
            Some((pid, _)) if pid == self.my_pid => {
                self.foreign_streak = 0;
                write_claim(&self.path, self.my_pid, "hb");
                ClaimPoll::Hold
            }
            // 别的进程持有且占位新鲜 = 它活着 → 退位倒计时
            Some((pid, age)) if age < CLAIM_FRESH => {
                let _ = pid;
                self.foreign_streak += 1;
                if self.foreign_streak >= CLAIM_YIELD_AFTER {
                    ClaimPoll::Superseded
                } else {
                    ClaimPoll::ForeignLive
                }
            }
            // 别的进程持有但占位过期 = 它死了 → 夺回
            Some((pid, _)) => {
                println!("  [CLAIM] holder pid={} stale — retaking", pid);
                self.foreign_streak = 0;
                write_claim(&self.path, self.my_pid, "retake");
                ClaimPoll::Retaken
            }
            // 文件缺失（被清理/首次）也重占：本进程仍是唯一主张者
            None => {
                self.foreign_streak = 0;
                write_claim(&self.path, self.my_pid, "reclaim");
                ClaimPoll::Hold
            }
        }
    }

    fn poll(&mut self) -> ClaimPoll {
        self.poll_at(std::time::SystemTime::now())
    }

    /// 停机清理：占位仍属于本进程时删除；被抢走后不删别人的。
    fn release_if_mine(&self) {
        if let Some((pid, _)) = read_claim(&self.path, std::time::SystemTime::now()) {
            if pid == self.my_pid {
                let _ = std::fs::remove_file(&self.path);
            }
        }
    }
}

pub fn status_file_path_for(role: &str, peer_id: u32) -> std::path::PathBuf {
    // VNET_STATUS_FILE（精确路径）> VNET_STATUS_DIR（目录，Android 可读位置）
    // > temp_dir（默认）。2026-11-12 手机观测盲区：Android temp_dir =
    // /data/local/tmp 无权限，宿主设 VNET_STATUS_DIR=app files dir 即可读。
    if let Ok(p) = std::env::var("VNET_STATUS_FILE") {
        if !p.is_empty() {
            return std::path::PathBuf::from(p);
        }
    }
    if let Ok(d) = std::env::var("VNET_STATUS_DIR") {
        if !d.is_empty() {
            return std::path::Path::new(&d).join(format!("vnet-status-{}-{}.txt", role, peer_id));
        }
    }
    std::env::temp_dir().join(format!("vnet-status-{}-{}.txt", role, peer_id))
}

/// 列出临时目录下所有 vnet 状态文件（供 `vnet status` 全量展示）
pub fn list_status_files() -> Vec<std::path::PathBuf> {
    let dir = std::env::temp_dir();
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with("vnet-status") && name.ends_with(".txt") {
                out.push(e.path());
            }
        }
    }
    out
}

/// 写运行态状态（key=value 每行一条）。失败静默——状态输出不该影响隧道。
pub fn write_status(fields: &[(&str, String)]) {
    write_status_at(&status_file_path(), fields);
}

/// 写到指定路径（server/client 各用不同文件名，互不覆盖）
pub fn write_status_at(path: &std::path::Path, fields: &[(&str, String)]) {
    let kv: Vec<(String, String)> = fields.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
    write_status_kv(path, &kv);
}

/// key 为 String 的变体：multi-forward 的 `forward.<local_port>` 这类动态 key 用它
pub fn write_status_kv(path: &std::path::Path, fields: &[(String, String)]) {
    let mut body = String::new();
    for (k, v) in fields {
        body.push_str(&format!("{}={}\n", k, v.replace('\n', " ")));
    }
    let _ = std::fs::write(path, body);
}


/// 绑定 IPv6 监听 socket，并强制 IPV6_V6ONLY。
///
/// Linux/Android 下 `[::]` 默认双栈，若同一端口已被 `0.0.0.0` 占用，
/// 绑定会报 EADDRINUSE（os error 98）导致进程直接退出。
/// Windows 默认 IPV6_V6ONLY=1 所以不会暴露这个问题——这是跨平台陷阱。
/// NAT 过滤类型检测的证据位（RFC 4787 §5 的 EIF/ADF/APDF 判定）。
///
/// 判据：如果我们的 NAT **允许了一个我们从未向其发送过的源（IP:port）**的入站包，
/// 说明过滤是按 IP 做的（ADF）或完全不滤（EIF）；
/// 如果只允许我们发过包的那个精确 IP:port（APDF，俗称"端口受限"），
/// 那么来自同一 IP 但不同端口的包会被丢弃。
///
/// 实现：把「对端公告的监听端口」与「实际收到包的源端口」对比 ——
/// 打洞引擎会用临时端口发包，这些端口我们从未发过，
/// 所以能收到它们就证明不是 APDF。
static FILTER_EV: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);
/// 对端公告的监听端口（0=未知）。用于过滤类型判定：收到源端口 ≠ 此值的包即为证据。
/// 服务端从「中继转发来的数据」里学到的对端 peer_id。
/// 家宽路由器拦入站 → 客户端无法主动摸到服务端监听口，P2P 只能服务端发起；
/// 而客户端是动态 peer_id。它一旦通过中继发过数据，就记下来供打洞线程反向敲。
static STABLE_PICK_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
static STABLE_PENDING_KIND: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const HYSTERESIS_N: u32 = 3;

/// relay 路径按流分块的上限：ARQ chunk 上限扣掉 3 字节内层头。
/// 「先按此切块再包装」保证每个 ARQ 交付项恰好一个内层头（边界不被内部分块打断）。
/// 跟随 `VNET_CHUNK` 运行时联动（缺省 1000-3=997）。
fn stream_chunk() -> usize {
    crate::relay_arq::chunk_size() - crate::transport::STREAM_FRAME_HEAD
}

/// conn_flags 表的 key（进程内唯一即可，不承载线上身份；
/// stream id 是 u16 会环绕，复用同一 key 空间会在 close_all_conns 时误关新连接）
fn next_conn_flag_key() -> u64 {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}


// ── 诊断计数器（大 payload 死锁排查）──
static DIAG_SEND: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static DIAG_RX: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static DIAG_TICK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static DIAG_HUB_PUSH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static DIAG_HUB_POP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 热路径诊断总开关（每包 println），默认关：P2P 数据面每包打印会直接压低吞吐
/// （实测同链路 512KB：P2P 1477ms vs relay 671ms，其中一项就是每包格式化+I/O）。
fn diag_hot() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("VNET_DIAG").unwrap_or_default() == "1")
}

static LEARNED_PEERS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<u32>>> =
    std::sync::OnceLock::new();

/// 服务端入站 P2P 活跃对端注册表（addr → last_seen）
/// P2P 处理线程在通道建立时插入，status 写入器读取（30s 内活跃视为在连）
static P2P_INBOUND: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, std::time::Instant>>> =
    std::sync::OnceLock::new();
fn p2p_inbound() -> &'static std::sync::Mutex<std::collections::HashMap<String, std::time::Instant>> {
    P2P_INBOUND.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}
/// P2P 处理线程调用：记录/刷新一个入站对端
pub fn note_p2p_inbound(addr: &std::net::SocketAddr) {
    p2p_inbound().lock().unwrap().insert(addr.to_string(), std::time::Instant::now());
}

/// 解析状态文件的 kv 行（`k=v`，忽略空行/无等号行）。
pub fn parse_status_kv(body: &str) -> Vec<(String, String)> {
    body.lines()
        .filter_map(|l| {
            let (k, v) = l.split_once('=')?;
            let k = k.trim();
            if k.is_empty() { None } else { Some((k.to_string(), v.trim().to_string())) }
        })
        .collect()
}

/// 读取一个角色的状态文件并解析为 kv（宿主对账用；文件不存在 → None）。
/// 2026-11-12 修复：host 侧 `vnet_forward.rs` 引用了本函数但 vnet 从未提供
/// （历史分支断档），补等价读面。
pub fn read_status_file(role: &str, peer_id: u32) -> Option<Vec<(String, String)>> {
    let body = std::fs::read_to_string(status_file_path_for(role, peer_id)).ok()?;
    Some(parse_status_kv(&body))
}

/// 列出临时/状态目录下全部 vnet 状态快照：(路径, kv)。
/// 宿主 peers 视图用它枚举 server 实例（比进程内表更全，跨进程可见）。
pub fn list_status_snapshots() -> Vec<(std::path::PathBuf, Vec<(String, String)>)> {
    list_status_files()
        .into_iter()
        .filter_map(|p| {
            let body = std::fs::read_to_string(&p).ok()?;
            Some((p, parse_status_kv(&body)))
        })
        .collect()
}

/// 进程内实时入站 P2P 对端快照：(addr, 静默毫秒)。
/// 比状态文件（5s 粒度 + 可能被双写者覆盖）更实时；宿主"in 入站视图"用它。
/// 只返回最近 120s 内活跃的条目（陈旧残留不展示）。
pub fn p2p_inbound_snapshot() -> Vec<(String, u64)> {
    let now = std::time::Instant::now();
    let g = p2p_inbound().lock().unwrap();
    let mut out: Vec<(String, u64)> = g
        .iter()
        .filter_map(|(addr, at)| {
            let age_ms = now.saturating_duration_since(*at).as_millis() as u64;
            if age_ms <= 120_000 { Some((addr.clone(), age_ms)) } else { None }
        })
        .collect();
    out.sort_by_key(|(_, age)| *age);
    out
}

fn learned_peers() -> &'static std::sync::Mutex<std::collections::HashSet<u32>> {
    LEARNED_PEERS.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

static PEER_LISTEN_PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);

pub fn note_peer_listen_port(p: u16) {
    PEER_LISTEN_PORT.store(p, std::sync::atomic::Ordering::Relaxed);
}

fn peer_listen_port_known() -> u16 {
    PEER_LISTEN_PORT.load(std::sync::atomic::Ordering::Relaxed)
}

pub fn filter_evidence() -> &'static str {
    match FILTER_EV.load(std::sync::atomic::Ordering::Relaxed) {
        1 => "ip-based(ADF/EIF)",
        2 => "port-based(APDF)",
        _ => "unknown",
    }
}

fn note_filter_evidence_ip_based() {
    FILTER_EV.store(1, std::sync::atomic::Ordering::Relaxed);
}

/// per-peer 新建流速率上限（安全网，防连接洪流烧穿对端网关）。
/// 阈值来源（实测，非拍数）：
/// - DSH 2026-11-08 keeper 探针环峰值 12.4 conn/s（干净业务 <2/s）
/// - DSH 2026-11-09 02:25 SPA 页面加载突发 30–50 conn/s（30–80 个无 keep-alive
///   静态资源并发）——缺省 15 会误杀 → clean-proxy 502（笔记本 list 502 实锤）；
///   VNET_CONN_RATE=60 后全绿。
/// 缺省 60 覆盖页面加载突发 + 探针环；DSH 侧 clean-proxy 复用落地后可收紧。
/// `VNET_CONN_RATE`：数值=每 peer 每秒新建流上限；0=关闭。固定 1s 窗口（安全网
/// 不追求平滑，追求可预测）。
pub(crate) fn conn_rate_limit() -> u32 {
    static R: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *R.get_or_init(|| {
        std::env::var("VNET_CONN_RATE").ok().and_then(|v| v.parse().ok()).unwrap_or(60)
    })
}

/// 突发额度（token bucket 容量）。默认 128 ≥ 一页 SPA 的资源数，让「页面加载」
/// 这种合法突发通过，同时持续洪流仍被 `conn_rate_limit()` 按住。
/// 反面证据（2026-11-09 DSH 43KB/s 复现）：固定窗口 60/s 把 81 个资源/0.35s 的
/// 正常页突发判成洪流（一次加载 52 次 RATE-LIMIT），客户端只能重试 → 表现为
/// 「每资源 ~500ms、有效吞吐 ~43KB/s」。纯洪流场景（R13）用 VNET_CONN_BURST=rate
/// 把突发额度也压掉，保持二值硬门语义不变。
pub(crate) fn conn_burst_cap() -> u32 {
    static B: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *B.get_or_init(|| {
        std::env::var("VNET_CONN_BURST").ok().and_then(|v| v.parse().ok()).unwrap_or(128)
    })
}

/// token bucket（per peer）：按 `conn_rate_limit()` 每秒回填，桶容量 `conn_burst_cap()`。
/// 超限 = 拒绝建流并显式回 STREAM_END，client 侧表现为「连接立即关闭可重试」，绝不静默。
#[derive(Clone)]
pub(crate) struct ConnRate {
    tokens: f64,
    last: std::time::Instant,
}

impl ConnRate {
    pub(crate) fn new() -> Self {
        Self { tokens: conn_burst_cap() as f64, last: std::time::Instant::now() }
    }
    pub(crate) fn allow(&mut self) -> bool {
        Self::allow_at(self, std::time::Instant::now(), conn_rate_limit(), conn_burst_cap())
    }
    /// 纯逻辑（时间注入，供单测）：按经过时间回填令牌（上限=桶容量），消费一个。
    fn allow_at(&mut self, now: std::time::Instant, rate: u32, burst: u32) -> bool {
        if rate == 0 {
            return true;
        }
        let cap = burst.max(1) as f64;
        let dt = now.duration_since(self.last).as_secs_f64().max(0.0);
        self.tokens = (self.tokens + dt * rate as f64).min(cap);
        self.last = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// multi-forward 上游端口白名单：默认只允许 server 自己的 `--target-port`；
/// 额外端口由 `VNET_TARGET_PORTS`（逗号分隔）声明。
/// 越权必须显式拒绝 —— 否则 multi-forward 就变成客户端可指定服务端上游端口的 SSRF 面。
fn mf_target_allowed(port: u16, default_port: u16) -> bool {
    if port == default_port {
        return true;
    }
    // 2026-11-13 卡驱动放行（宿主立法「端口由任务卡决定」，dsh_share 注入）：
    // 活跃分享卡声明的目标端口与静态 env 白名单取并集；默认拒绝语义不变。
    // 本块与 vendored 副本（apps/home/src-tauri/src/vnet）保持逐字一致，
    // 同步脚本不再覆盖丢失（历史：vendored 同步曾吞掉宿主侧新增）。
    if mf_card_ports_contains(port) {
        return true;
    }
    static EXTRA: std::sync::OnceLock<Vec<u16>> = std::sync::OnceLock::new();
    let extra = EXTRA.get_or_init(|| {
        std::env::var("VNET_TARGET_PORTS")
            .ok()
            .map(|s| s.split(',').filter_map(|x| x.trim().parse::<u16>().ok()).collect())
            .unwrap_or_default()
    });
    extra.contains(&port)
}

/// 卡声明端口集（宿主注入；RwLock 而非 OnceLock——建卡/撤卡会变）。
static MF_CARD_PORTS: std::sync::RwLock<Option<Vec<u16>>> = std::sync::RwLock::new(None);

/// 宿主注入活跃分享卡声明的目标端口全集（myco dsh_share 建卡/撤卡/启动时调）。
pub fn set_mf_card_ports(ports: Vec<u16>) {
    if let Ok(mut g) = MF_CARD_PORTS.write() {
        *g = Some(ports);
    }
}

fn mf_card_ports_contains(port: u16) -> bool {
    if let Ok(g) = MF_CARD_PORTS.read() {
        if let Some(v) = g.as_ref() {
            return v.contains(&port);
        }
    }
    false
}

// ── per-peer 身份（identity.rs 的 server 侧接线；task.md §11 H.3.1）──

/// 处理连接级 AUTH 帧：tag 匹配则验签并记录身份，返回 true（调用方 continue）。
/// relay 路径额外校验「帧内声明 sender == 信封 src_peer」。
#[allow(clippy::too_many_arguments)]
fn srv_handle_auth(
    tag: u8,
    payload: &[u8],
    my_peer_id: u32,
    envelope_src_peer: Option<u32>,
    auth_slot: &mut Option<crate::identity::PeerIdentity>,
    auth_at: &mut Option<std::time::Instant>,
) -> bool {
    if tag != crate::identity::STREAM_TAG_AUTH {
        return false;
    }
    match crate::identity::verify_auth_frame(payload, my_peer_id) {
        Ok(id) => {
            if let Some(env_peer) = envelope_src_peer {
                if env_peer != id.peer_id {
                    println!("  [AUTH] DENY code=PEER_ID_MISMATCH env={} declared={}", env_peer, id.peer_id);
                    return true;
                }
            }
            println!("  [AUTH] peer verified did={} key_id={} (pid={})", id.did, id.key_id, id.peer_id);
            *auth_slot = Some(id);
            *auth_at = Some(std::time::Instant::now());
        }
        Err(_) => { /* identity::verify 内部已记 [AUTH] DENY + 计数 */ }
    }
    true
}

/// 流开放前的身份闸门：未启用认证 = legacy 放行；启用 = 必须已验证且在 TTL 内，
/// 然后过宿主授权钩子。Ok(Some(id)) = 通过且带身份（VNETP 用）。
fn srv_auth_gate(
    auth: &Option<crate::identity::PeerIdentity>,
    auth_at: &Option<std::time::Instant>,
    target_port: u16,
    path: &str,
) -> Result<Option<crate::identity::PeerIdentity>, &'static str> {
    if !crate::identity::enabled() {
        return Ok(None); // 本端未设置身份 = 认证关闭 = legacy 行为（回归绿的前提）
    }
    // 2026-11-12 ADB P0：显式 PSK-only 模式（手机 JNI 无 resolver 入口的场景）。
    // 原实现：无 resolver → verify_auth_frame fail-closed（UnknownKey）→ auth=None
    // → AUTH_REQUIRED 全拒。显式开关降级（而非自动）：保持有 resolver 宿主的严格语义。
    if !crate::identity::has_resolver() && crate::identity::gate_psk_only() {
        return Ok(auth.clone()); // PSK 已验证网络准入；AUTH 声明的身份仅作 advisory
    }
    let Some(id) = auth else { return Err("AUTH_REQUIRED") };
    // AUTH 周期重发（client 2s）；120s 未刷新 = 视为失效
    let fresh = auth_at.map(|t| t.elapsed() < Duration::from_secs(120)).unwrap_or(false);
    if !fresh {
        return Err("AUTH_EXPIRED");
    }
    match crate::identity::authorize(id, target_port, path) {
        Ok(()) => Ok(Some(id.clone())),
        Err((code, _)) => Err(code),
    }
}

/// 解析一条流要连接的上游端口。`Err(reason)` = 必须显式拒绝该流
/// （旧端不认识载荷时宁可失败也不静默误路由到默认口）。
fn mf_resolve_target(payload: &[u8], default_port: u16) -> Result<u16, &'static str> {
    use crate::transport::SessionStartTarget as S;
    match crate::transport::parse_session_start_target(payload) {
        S::Legacy => Ok(default_port),
        S::Target(p) if mf_target_allowed(p, default_port) => Ok(p),
        S::Target(_) => Err("MF_TARGET_DENIED"),
        S::Malformed => Err("MF_BAD_FRAME"),
    }
}

/// multi-forward 能力协商（task.md §11 H.2）：client 在 add_forward 建 route 前校验
/// 对端 NetStatus 公告的 caps 位。`add_forward` 持 remote_net_status 锁后调用的就是本函数。
/// - 对端已公告（version>0）且缺 CAP_MULTI_FORWARD → `MF_UNSUPPORTED` 显式失败：
///   旧 server 会忽略 targeted 载荷、静默连自己的默认口（误路由），必须在建 route 前拦下；
/// - version==0 = 尚未收到对端任何公告（announce 经 relay 异步到达）→ 放行并告警
///   （Option B 向后兼容：旧端根本不公告 NetStatus；enable_multi_forward 闸门仍在兜底）。
///
/// 债 2（2026-11-11/12 生产事故）：version==0 的放行本质是 fail-open——旧对端会静默
/// 误路由。同步判定保持不变（放行 + WARN，向后兼容不得收紧），但 add_forward 会在
/// 放行的同时起一个 5s 的 relay ARQ PING/PONG 后台探测（probe_peer_alive）：
/// PONG 到 = 对端活着，转发保持；超时 = 对端不可达/不支持，记 ERROR 并对该
/// forward 的流显式 STREAM_END。探测结果只异步经日志交付，不改本函数返回值。
fn mf_caps_check(remote: &crate::netstatus::NetStatus) -> anyhow::Result<()> {
    if remote.version == 0 {
        println!("  [FWD] WARN: remote NetStatus not arrived yet (version=0) — \
                  caps check skipped (legacy compat, mf_enabled gate still applies)");
        return Ok(());
    }
    if remote.caps & crate::netstatus::CAP_MULTI_FORWARD == 0 {
        anyhow::bail!(
            "MF_UNSUPPORTED: remote peer does not advertise multi_forward capability (caps=0x{:x})",
            remote.caps
        );
    }
    Ok(())
}

/// 债 3：confirm_forward 的 4 字节探测头魔数（VNET CoNfirm Forward，0x564E4346）。
/// 选 ASCII "VNCF"：固定 4 字节、可读、不与既有线上帧头冲突。
/// 注意：探测字节会经全路径（本地 listener → 隧道 → 对端 → upstream）到达真实
/// 上游服务——垃圾输入由 upstream 自行处理/关闭，这正是「数据真的流过全路径」
/// 的证据本身。
const FORWARD_CONFIRM_MAGIC: [u8; 4] = *b"VNCF";

/// 债 3（2026-11-11/12 生产事故）的探测体（独立成自由函数：无需真实 relay 即可单测）：
/// 1. 连 127.0.0.1:local_port（forward 的本地 listener）；
/// 2. 发 4 字节探测头（FORWARD_CONFIRM_MAGIC）；
/// 3. 探测字节经 本地 listener → 隧道 → 对端 → target_port upstream 全路径；
/// 4. timeout 内等任一响应或连接关闭；
/// 5. 超时无响应 → Err("forward unreachable")（本地 bind 成功 ≠ 隧道可达，
///    静默黑洞必须在这里显式暴露，不能等上层协议超时才发现）。
fn confirm_forward_probe(local_port: u16, timeout: Duration) -> anyhow::Result<()> {
    // 连不上本地 listener = 转发根本没起来（bind 失败/已被 remove），立即显式失败
    let mut sock = TcpStream::connect(("127.0.0.1", local_port)).map_err(|e| {
        anyhow::anyhow!("forward unreachable: connect 127.0.0.1:{} failed: {:#}", local_port, e)
    })?;
    // 探测全程以 timeout 为上限：任何一步都不许无限挂起（G6 显式失败）
    sock.set_read_timeout(Some(timeout))?;
    sock.set_write_timeout(Some(timeout))?;
    // 探测头必须走完全路径才可能拿到响应
    sock.write_all(&FORWARD_CONFIRM_MAGIC)?;
    // 等任一响应（或连接关闭）。静默黑洞（对端死/隧道断）在这里超时暴露。
    let mut buf = [0u8; 16];
    match sock.read(&mut buf) {
        // 对端干净关闭 = 探测字节到达对端并被 upstream 处理后关闭（路径走通）
        Ok(0) => Ok(()),
        // 收到任意字节 = 全路径有数据流动
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock
            || e.kind() == std::io::ErrorKind::TimedOut => {
            anyhow::bail!(
                "forward unreachable: no response within {:?} \
                 (local bind ok but tunnel path dead — silent blackhole suspected)",
                timeout
            );
        }
        Err(e) => {
            anyhow::bail!("forward unreachable: read 127.0.0.1:{} failed: {:#}", local_port, e)
        }
    }
}

/// 打洞探测节拍（client/server 两侧共用；EasyTier 对照：首轮立即 + 短退避）。
/// 1–30 轮 150ms（前 ~4.5s 高密度交叉），31–90 轮 500ms，其后回落 1s（旧行为）。
/// 实测背景（2026-11-08）：固定 1s 下电信蜂窝 109 轮/移动 242 轮才收敛——
/// 蜂窝 NAT 映射窗常短于 1s，每秒仅一次双向交叉命中概率低；高密度早期探测
/// 把收敛压进映射窗存活期。环境阀 `VNET_PUNCH_CADENCE_MS` 固定节拍（对照实验用）。
fn punch_cadence_ms(round: u64) -> u64 {
    if let Ok(v) = std::env::var("VNET_PUNCH_CADENCE_MS") {
        if let Ok(n) = v.parse::<u64>() {
            if n > 0 {
                return n;
            }
        }
    }
    match round {
        0..=30 => 150,
        31..=90 => 500,
        _ => 1000,
    }
}

fn bind_v6_only(port: u16) -> Option<UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};
    let sock = Socket::new(Domain::IPV6, Type::DGRAM, Some(Protocol::UDP)).ok()?;
    sock.set_only_v6(true).ok()?;
    let addr: std::net::SocketAddr = format!("[::]:{}", port).parse().ok()?;
    sock.bind(&addr.into()).ok()?;
    let udp: UdpSocket = sock.into();
    // 直连 socket 缓冲随窗口配套（与 relay socket 同款；否则提窗后突发打穿
    // OS 默认 64KB 接收缓冲，静默丢包在直连路径复现）
    crate::relay::apply_tunable_buffers(&udp);
    udp.set_nonblocking(true).ok();
    Some(udp)
}

struct P2pChannel {
    socket: Arc<UdpSocket>,
    peer_addr: std::net::SocketAddr,
    is_ipv6: bool,
    /// 通道级双向验证位（黑盒回归修复核心）：REQUEST 敲门只证明「对端→我」，
    /// 这样创建的通道为 false（verify ACK 到达才置 true）；REPLY 往返 / 打洞胜出 /
    /// score>=3 证据创建的通道直接 true。apply_decision 只选 verified 通道承载业务，
    /// 否则管道级 verified（可能来自另一个 socket 的证据）会把未验证通道顶上数据面。
    /// Cell<bool>：允许通过 &self 修改（注册表 active_channel 返回 &P2pChannel）
    verified: std::cell::Cell<bool>,
    /// 可靠流（ARQ）。通道建立时创建，自己持有 socket+peer，ACK 从同一通道回。
    stream: Arc<Mutex<crate::tunnel::TunnelStream>>,
    #[allow(dead_code)] id: u64,
    #[allow(dead_code)] verify_since: Option<Instant>,
}

impl P2pChannel {
    fn new(
        socket: Arc<UdpSocket>,
        peer_addr: std::net::SocketAddr,
        is_ipv6: bool,
        crypto: Option<Arc<Mutex<crate::crypto::SessionCrypto>>>,
        verified: bool,
    ) -> Self {
        let stream = crate::tunnel::TunnelStream::new(socket.clone(), peer_addr, crypto);
        Self { socket, peer_addr, is_ipv6, verified: std::cell::Cell::new(verified), stream: Arc::new(Mutex::new(stream)), id: { static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1); N.fetch_add(1, std::sync::atomic::Ordering::Relaxed) }, verify_since: None }
    }

    /// 通道身份匹配：socket + peer 四元组
    #[allow(dead_code)]
    fn matches(&self, sock: &Arc<UdpSocket>, from: std::net::SocketAddr) -> bool {
        Arc::ptr_eq(&self.socket, sock) && self.peer_addr == from
    }
}

/// P2P 数据面 verify 探测字节。旧实现发 `\x00` 且接收端把它当应用字节入 hub——
/// 现在改成显式标记，接收端识别后只回 ACK、不进应用流（防 1 字节污染 G2）。
const P2P_VERIFY_TAG: &[u8] = b"VNETVRF1";

/// 通道注册表：多槽并存，每条候选路径独立验证、独立失败、独立回收
/// 替代旧的单槽 Option<P2pChannel>（候选互相覆盖 = 状态空间维度缺失）
#[allow(dead_code)]
struct P2pRegistry {
    channels: HashMap<u64, P2pChannel>,
    active: Option<u64>,
}

#[allow(dead_code)]
impl P2pRegistry {
    fn new() -> Self { Self { channels: HashMap::new(), active: None } }
    fn find(&self, sock: &Arc<UdpSocket>, from: std::net::SocketAddr) -> Option<&P2pChannel> {
        self.channels.values().find(|c| c.matches(sock, from))
    }
    fn get(&self, id: u64) -> Option<&P2pChannel> { self.channels.get(&id) }
    fn upsert(&mut self, ch: P2pChannel) -> u64 {
        if let Some(existing) = self.channels.values().find(|c| c.matches(&ch.socket, ch.peer_addr)) {
            return existing.id;
        }
        let id = ch.id;
        self.channels.insert(id, ch);
        id
    }
    /// 已验证通道晋升为 active（数据发送路径按 active 选通道）。
    /// 旧代码 active 只在 EXP2 verify PASS 一处设置，而 verify PASS 又要求
    /// 帧能进 on_packet——帧路由却要求通道已 active：鸡生蛋死锁，
    /// 打洞成功的已验证通道也永远成不了 active。
    fn promote_verified(&mut self, id: u64) {
        let should = match self.channels.get(&id) {
            Some(c) if c.verified.get() => match self.active.and_then(|a| self.channels.get(&a)) {
                Some(cur) if cur.verified.get() => false, // 已有已验证通道在位，不抢
                _ => true,
            },
            _ => false,
        };
        if should { self.active = Some(id); }
    }
    fn remove(&mut self, id: u64) {
        self.channels.remove(&id);
        if self.active == Some(id) { self.active = None; }
    }
    fn active_channel(&self) -> Option<&P2pChannel> {
        self.active.and_then(|id| self.channels.get(&id))
    }
    fn verified_candidates(&self) -> Vec<&P2pChannel> {
        self.channels.values().filter(|c| c.verified.get()).collect()
    }
}
/// 通道重建判据（黑盒回归修复）：
/// - 对端 IP 变了 → 重建（真换端；真换端口由 watchdog 停滞清通道后重建兜底）
/// - 同 IP、槽内通道**未验证**、新证据是**已验证**通道（REPLY 往返/打洞胜出）→ 顶替
/// - 其余同 IP 情况（对端打洞引擎扫描端口的敲门/回包）→ 绝不重建
///   （全地址比较会让通道每秒重建、ARQ 归零，对端在途流全判重复吞掉）
fn chan_rebuild_needed(existing: &P2pChannel, from: std::net::SocketAddr, new_verified: bool) -> bool {
    if existing.peer_addr.ip() != from.ip() {
        return true;
    }
    new_verified && !existing.verified.get()
}

/// 数据面静默恢复梯（`task.md` §3.1 第 6/7 条）。
///
/// 只在 `expect_data == true`（有应用字节排队或在途未确认）时工作；
/// 空闲 TCP 两者都为空，永远不会被判成黑洞。
#[derive(Default)]
struct SilenceLadder {
    /// 已发出的探测次数（只用于日志/证据）
    round: u8,
    last_probe_at: Option<std::time::Instant>,
    last_peer_map: Option<std::net::SocketAddr>,
    /// 一旦由“最近有下行交付”或“上行有待交付”进入监控，就保持到有进展或判死，
    /// 否则 5 秒活跃窗一过就会自我解除，永远走不到结论（R10 实测的红例形态）。
    armed: bool,
    /// 武装时刻：静默只从这一刻起算（长空闲后第一笔在途数据不该被即刻判死）。
    /// 没有它时，长时间空闲（如 RDP 空闲 60s）后第一笔在途数据会因 `silent_for`
    /// 早已超过预算而被**立刻**判死——那是另一个方向的误杀。
    armed_at: Option<std::time::Instant>,
}

/// 契约阈值：连续 3 秒无有效交付/探测回包即触发 `A_probe_data_plane`
const SILENCE_TRIGGER: Duration = Duration::from_secs(3);
/// 探测间隔：远大于 1 个 RTT，12 秒预算内可取得 ~6 次独立往返证据
const PROBE_INTERVAL: Duration = Duration::from_secs(2);
/// 下行活跃窗：最近一次把字节交给应用后，这段时间内算“流还在动”。
/// 取 5s = 3s 检测阈值 + 一次探测余量；超过后下行静默与“应用本来空闲”不可区分，
/// 因此不再监控（否则空闲 RDP 会话会被无端判死）。
const DOWNLINK_ACTIVE_WINDOW: Duration = Duration::from_secs(5);


/// 现场 A/B 旋钮（启动读一次即固定；不设 = 沿用事故调参后的默认值）。
/// 为什么要旋钮：静默预算这类阈值只能在真机链路上试（蜂窝/家宽差异大），
/// 出问题时必须能不重新编译就调，否则每次验证都要等一轮出包。
fn env_duration_ms(name: &str, default: Duration) -> Duration {
    match std::env::var(name).ok().and_then(|v| v.trim().parse::<u64>().ok()) {
        Some(ms) if ms > 0 => Duration::from_millis(ms),
        _ => default,
    }
}

/// 静默触发阈值（默认 3s）。
fn silence_trigger() -> Duration {
    static V: std::sync::OnceLock<Duration> = std::sync::OnceLock::new();
    *V.get_or_init(|| env_duration_ms("VNET_SILENCE_TRIGGER_MS", SILENCE_TRIGGER))
}

/// 探测节拍（默认 2s）。
fn silence_probe_interval() -> Duration {
    static V: std::sync::OnceLock<Duration> = std::sync::OnceLock::new();
    *V.get_or_init(|| env_duration_ms("VNET_SILENCE_PROBE_MS", PROBE_INTERVAL))
}

/// 静默预算覆盖（默认 None = 用 ARQ 的 `retry_budget()`，与本实现同源）。
fn silence_budget_override() -> Option<Duration> {
    static V: std::sync::OnceLock<Option<Duration>> = std::sync::OnceLock::new();
    *V.get_or_init(|| {
        std::env::var("VNET_SILENCE_BUDGET_MS")
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|ms| *ms > 0)
            .map(Duration::from_millis)
    })
}

/// Per-stream retry budget（Phase 1，缺省 12s，`VNET_STREAM_BUDGET_MS` 覆盖）。
/// 单流 pending 卡死超过该预算 → 只终结该流（pending 原地换成 STREAM_END，
/// 帧数/位置不变，seq 连续性保持），不再连坐同隧道的其他流——
/// RDP P0 根因正是一条卡死流触发整条 ARQ reset + `close_all_conns` 全杀。
/// 缺省与整体 ARQ 预算同源（G4 的 15s − 3s 检测 = 12s，见 relay_arq.rs）；
/// Phase 2（inflight 耗尽整体预算 → reset_stream + close_all_conns）保持不变，
/// 作为「对端真不可达」时的兜底（R9 全死场景仍走完整判死路径）。
fn stream_budget() -> Duration {
    static V: std::sync::OnceLock<Duration> = std::sync::OnceLock::new();
    *V.get_or_init(|| env_duration_ms("VNET_STREAM_BUDGET_MS", Duration::from_millis(12_000)))
}

/// 静默梯当前该做什么（**纯函数**，单测直击）。
#[derive(Debug, PartialEq, Eq)]
enum SilenceVerdict {
    /// 不监控：没有在途/待发字节（空闲是合法状态，RDP 空闲期不该被拆），或静默未达阈值。
    Idle,
    /// 在途字节静默超阈值但未耗尽预算 → 探测 + 取往返证据。
    Probe,
    /// 预算耗尽仍无进展 → 重置传输并显式关闭应用连接。
    Reset,
}

/// 判定核：**只有确有在途/待发字节才可能 Probe/Reset**。
///
/// `effective_silent` 已由调用方按"武装时刻"裁剪过（见 `silence_ladder_tick`）。
fn silence_verdict(
    has_inflight: bool,
    effective_silent: Duration,
    trigger: Duration,
    budget: Duration,
) -> SilenceVerdict {
    if !has_inflight {
        return SilenceVerdict::Idle; // 纯空闲：永不重置
    }
    if effective_silent < trigger {
        return SilenceVerdict::Idle;
    }
    if effective_silent >= budget {
        return SilenceVerdict::Reset;
    }
    SilenceVerdict::Probe
}

/// 探测超时 = 2×RTO，逐轮翻倍（有界退避）。
/// RTO 来自 ARQ 实测 EWMA（RFC 6298），不是拍出来的常数；
/// 下界 400ms 覆盖一次往返，上界 4s 保证总预算远小于 G4 的 15 秒。
fn probe_timeout_ms(rto_ms: u64, round: u8) -> u64 {
    let base = rto_ms.saturating_mul(2).clamp(400, 2000);
    base.saturating_mul(1u64 << round.saturating_sub(1).min(3)).min(4000)
}

/// `A_close_explicitly`：把本隧道所有应用连接显式关闭。
/// 应用随即收到 FIN/RST —— 这比“连接还在但永远没有数据”诚实。
fn close_all_conns(conns: &Arc<Mutex<std::collections::HashMap<u64, Arc<AtomicBool>>>>) -> usize {
    let flags: Vec<Arc<AtomicBool>> = conns.lock().unwrap().values().cloned().collect();
    for flag in &flags {
        flag.store(false, Ordering::Relaxed);
    }
    flags.len()
}

fn silence_ladder_tick(
    arq: &Arc<std::sync::Mutex<crate::relay_arq::RelayArq>>,
    relay: &Arc<RelayClient>,
    target: u32,
    conns: &Arc<Mutex<std::collections::HashMap<u64, Arc<AtomicBool>>>>,
    stream_flags: &Arc<Mutex<HashMap<u16, Arc<AtomicBool>>>>,
    down_recent: bool,
    st: &mut SilenceLadder,
) {
    let (has_inflight, silent_for, abandoned, rto_ms, budget) = {
        let a = arq.lock().unwrap();
        (
            // `expect_data()` = pending 非空 或 inflight 非空 ⇒ 确有在途/待发字节，
            // 这才是"数据面需要盯"的唯一充分条件。
            a.expect_data(),
            a.silent_for(),
            a.abandoned_bytes(),
            a.rto_ms(),
            silence_budget_override().unwrap_or_else(|| a.retry_budget()),
        )
    };
    let trigger = silence_trigger();
    let probe_interval = silence_probe_interval();

    // ⓪ Per-stream retry budget（Phase 1，RDP P0）：单流 pending 卡死超过
    //    per-stream 预算 → 只终结该流——ARQ 把它的 pending 帧原地替换成
    //    STREAM_END（同帧数/同位置，seq 连续性保持，不 reset、不换 epoch），
    //    client 侧再把受害连接关掉（只关这些，不动其他流——尤其不动健康的
    //    RDP 流）。这是对下方 ①「整条 ARQ 判死」的第一道闸：一条卡死流
    //    不再连坐整条 Connection。
    //    注意：这里不 return——继续走后续静默检测逻辑（其他流可能还健康，
    //    也可能整体已死要交给 ① 兜底）。
    {
        let exhausted = {
            let mut a = arq.lock().unwrap();
            a.exhausted_streams(stream_budget())
        };
        for &sid in &exhausted {
            // client 侧：把受害流从开关表里关掉（按 stream id 查表；
            // conn_flags 的 key 是独立 u64 计数，不能直接拿 sid 查）
            if let Some(flag) = stream_flags.lock().unwrap().get(&sid) {
                flag.store(false, Ordering::Relaxed);
                println!("  [A_close_explicitly] cause=stream_budget_exhausted stream={}", sid);
            }
        }
    }

    // ① ARQ 已放弃字节 = 字节流中段永久缺失（放弃预算已耗尽）。
    //    此时任何"重建/续传"都是假修复，唯一诚实动作是显式失败。
    //    （Phase 2 兜底：Phase 1 只终结单流；若对端真不可达，全部 inflight
    //    帧终将耗尽整体预算走到这里——reset + close_all_conns 照旧，
    //    R9「全死场景 ≤15s 显式失败」不受影响。2026-11-12 RDP P0 排查时
    //    曾因 epoch 变更影响所有流而放弃 per-stream 关闭；现行两阶段方案
    //    由 Phase 1 在不换 epoch 的前提下先行剪除受害流。）
    if abandoned > 0 {
        // 仍取走 abandoned_streams 防重复触发（server 主循环也在消费同一口径）
        let _ = { let mut a = arq.lock().unwrap(); a.take_abandoned_streams() };
        println!("  [A_reset_transport] cause=retry_budget_exhausted dropped={}B", abandoned);
        arq.lock().unwrap().reset_stream();
        println!("  [A_close_explicitly] cause=retry_budget_exhausted");
        let closed = close_all_conns(conns);
        println!("  [A_close_explicitly] conns_closed={}", closed);
        st.round = 0;
        st.last_probe_at = None;
        st.armed = false;
        st.armed_at = None;
        return;
    }

    // ② 武装口径（2026-11-12 修，手机→PC 3389 真案）：
    //    只有"确有在途/待发字节"（`expect_data()`）才进入监控。
    //    原实现里 `down_recent`（近 5s 交付过下行字节）**单独也能武装** ——
    //    纯空闲连接（RDP 已把画面交付完、无在途数据）因此会被 12s 静默判死，
    //    现场表现就是"一跳 3389 就断 / 读 0 字节"，而同一链路上短请求-应答的
    //    9100/13911/15200 在 12s 预算内早已完成 —— 这正是"只有 RDP 不行"的机制。
    //    真黑洞不受影响：对端收不到时我方字节必然滞留在 pending/inflight，
    //    `expect_data()` 照样为真。
    if has_inflight {
        if !st.armed {
            st.armed = true;
            // 静默从"武装那一刻"起算：长时间空闲后第一笔在途数据不该被即刻判死。
            st.armed_at = Some(std::time::Instant::now());
        }
    } else {
        st.armed = false;
        st.armed_at = None;
    }
    let armed_for = st.armed_at.map(|t| t.elapsed()).unwrap_or(silent_for);
    let effective_silent = silent_for.min(armed_for);

    match silence_verdict(has_inflight, effective_silent, trigger, budget) {
        SilenceVerdict::Idle => {
            if st.round > 0 {
                println!("  [A_probe_data_plane] recovered after probes={} silent={}ms",
                    st.round, silent_for.as_millis());
            }
            st.round = 0;
            st.last_probe_at = None;
            arq.lock().unwrap().clear_probe();
            return;
        }
        SilenceVerdict::Reset => {
            let inflight = arq.lock().unwrap().inflight_bytes();
            println!("  [A_reset_transport] cause=silence_budget_exhausted silent={}ms dropped={}B down_recent={}",
                effective_silent.as_millis(), inflight, down_recent);
            arq.lock().unwrap().reset_stream();
            println!("  [A_close_explicitly] cause=silence_budget_exhausted");
            let closed = close_all_conns(conns);
            println!("  [A_close_explicitly] conns_closed={}", closed);
            st.round = 0;
            st.last_probe_at = None;
            st.armed = false;
            st.armed_at = None;
            return;
        }
        SilenceVerdict::Probe => {}
    }

    // ④ 首次触发：探一次 + 问一次映射 + 立刻把在途字节重发一遍（字节保留）
    if st.round == 0 {
        let frame = arq.lock().unwrap().start_probe();
        if !frame.is_empty() {
            let _ = relay.send_to_peer(target, &frame);
        }
        println!("  [A_probe_data_plane] silent={}ms expect_data=true round=1",
            silent_for.as_millis());

        // `A_lookup_peer`：从已注册的共享 socket 发 LOOKUP，由接收线程投递应答。
        // 旧 `lookup_peer()` 用临时端口，relay 按零放大纪律直接丢弃 → 永远拿不到映射。
        relay.request_lookup(target);
        let wait = Duration::from_millis(probe_timeout_ms(rto_ms, 1));
        let deadline = std::time::Instant::now() + wait;
        let mut ack: Option<Vec<u8>> = None;
        while std::time::Instant::now() < deadline {
            if let Some(p) = relay.take_control_ack(crate::relay::PacketType::LookupAck as u8) {
                ack = Some(p);
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        match ack.as_deref().and_then(RelayClient::parse_lookup_ack) {
            Some(addr) => {
                let changed = st.last_peer_map.is_some() && st.last_peer_map != Some(addr);
                println!("  [A_lookup_peer] peer={} map={} changed={}", target, addr, changed);
                st.last_peer_map = Some(addr);
            }
            None => {
                // 控制面无应答 = 连 relay 都不回 LOOKUP → 立刻续租，这是唯一能自救的动作
                println!("  [A_lookup_peer] peer={} no_answer -> control plane down", target);
                relay.renew_registration();
                println!("  [A_register] lease renewal requested after lookup miss");
            }
        }

        // 字节保留的重发：不丢任何应用字节，所以可以在流未断时安全使用
        let frames = arq.lock().unwrap().retransmit_all();
        let count = frames.len();
        for frame in &frames {
            let _ = relay.send_to_peer(target, frame);
        }
        println!("  [A_retransmit_all] frames={}", count);

        st.round = 1;
        st.last_probe_at = Some(std::time::Instant::now());
        return;
    }

    // ⑤ 预算内持续取往返证据；不重复强制重发（交给 ARQ 的指数退避，避免风暴）
    let due = st.last_probe_at.map_or(true, |at| at.elapsed() >= probe_interval);
    if due {
        arq.lock().unwrap().clear_probe();
        let frame = arq.lock().unwrap().start_probe();
        if !frame.is_empty() {
            let _ = relay.send_to_peer(target, &frame);
        }
        st.round = st.round.saturating_add(1);
        st.last_probe_at = Some(std::time::Instant::now());
        println!("  [A_probe_data_plane] round={} silent={}ms", st.round, silent_for.as_millis());
    }
}
pub struct Connection {
    /// 显式 P2P 监听端口覆盖（宿主分配；None 时读 VNET_P2P_PORT / 默认 9100）
    p2p_port_override: Option<u16>,
    pub my_peer_id: u32,
    pub target_peer_id: u32,
    relay: Arc<RelayClient>,
    p2p: Arc<Mutex<P2pRegistry>>,
    path: Arc<Mutex<DataPath>>,
    running: Arc<AtomicBool>,
    relay_packets: Arc<AtomicU64>,
    p2p_packets: Arc<AtomicU64>,
    /// P2P 对端地址（探测响应确认打通后设置）
    p2p_peer: Arc<Mutex<Option<std::net::SocketAddr>>>,
    /// 多连接下行数据分发中心
    hub: Arc<Mutex<ConnHub>>,
    /// 最近一次收到 P2P 探测回复的时刻（IPv4/IPv6 共用，供 watchdog 判定）
    last_p2p_reply: Arc<Mutex<std::time::Instant>>,
    /// 路径切换迟滞：连续收到多少次探测回复才允许切到 P2P（A9，防抖动）
    switch_score: Arc<Mutex<u32>>,
    /// 路径切换次数（G2 路径历史）
    path_switches: Arc<Mutex<u32>>,
    /// 最近一次路径切换时刻（冷却用，避免有损链路横跳）
    last_switch_at: Arc<Mutex<std::time::Instant>>,
    /// 累计 P2P 探测回复数（配合 probe_rounds 算丢包率）
    p2p_replies: Arc<AtomicU64>,
    /// 打洞引擎一旦建立通道就锁定，简单探测不得覆盖
    /// （否则两边抢同一个 p2p 通道，服务端按 A socket 回包、客户端从 B socket 发，会丢一半）
    /// 监听 socket 累计收包数（动态证据：一直为 0 说明入站被拦或对端未发）
    listen_rx: Arc<AtomicU64>,
    /// 宿主调用 stop() 的次数（诊断：区分「宿主主动停」与「进程死了」）
    stop_calls: Arc<AtomicU64>,
    /// 本地代理实际绑定的端口（宿主传 0 时由系统分配；0 = 尚未绑定）
    local_port: Arc<AtomicU32>,
    /// Rendezvous 固定监听 socket（客户端也监听，供对端直连）
    listen_sock: Option<Arc<UdpSocket>>,
    /// 探测可观测计数（per-Connection）：收到 REQUEST / REPLY / 验签失败
    probe_req_rx: Arc<AtomicU64>,
    probe_reply_rx: Arc<AtomicU64>,
    probe_verify_fail: Arc<AtomicU64>,

    /// 该监听 socket 的公网映射（STUN 学出，经中继公告）
    listen_pub: Arc<Mutex<Option<std::net::SocketAddr>>>,
    announced_v6: Arc<Mutex<Option<std::net::SocketAddr>>>,
    /// IPv6 监听 socket（双栈；对端会往 [::]:port 发）
    listen_sock_v6: Option<Arc<UdpSocket>>,
    punch_locked: Arc<std::sync::atomic::AtomicBool>,
    /// S：每条候选管道一个 PathPipe（Relay/P2pV4/P2pV6，固定下标见 pathpipe::index_of）。
    /// ENV 各接收/探测线程持续更新 o_*（shadow），决策层读 s_selectable 做裁决。
    pipes: Arc<Mutex<Vec<PathPipe>>>,
    /// R：路径决策评价指标（用户可调旋钮，FFI 将来注入；见 PATH-STRATEGY.md）
    policy: RPolicy,
    threads_alive: Arc<AtomicU64>,
    /// 本端网络能力画像（持续感知更新）
    pub local_net_status: Arc<std::sync::Mutex<crate::netstatus::NetStatus>>,
    /// relay 路径的 ARQ（中继模式下提供重传保障）
    pub relay_arq: Arc<std::sync::Mutex<crate::relay_arq::RelayArq>>,
    /// 每个应用连接的“存活开关”。`A_close_explicitly` 从监控线程把这些开关置 false，
    /// up/down 线程下一轮轮询即退出并释放 TcpStream → 应用看到 FIN/RST 而不是无限挂起。
    conn_flags: Arc<Mutex<std::collections::HashMap<u64, Arc<AtomicBool>>>>,
    /// 流 id → 该连接存活开关（Phase 1 按流终结用）。`conn_flags` 的 key 是独立
    /// u64 计数（不复用 stream id 空间，见 [`next_conn_flag_key`]），单流终结需要
    /// 按 sid 找到开关，故另立本表：随连接注册/注销同生命周期维护（注销先于 hub
    /// unregister 且用 Arc 身份核对），sid 环绕复用不会残留错映射。
    stream_flags: Arc<Mutex<HashMap<u16, Arc<AtomicBool>>>>,
    /// 最近一次把下行字节真正交给应用的时刻。
    /// 纯下行静默（画面流断掉而本端上行空闲）只能靠“刚才还在交付”这个事实来发现：
    /// 上行 expect_data 为假时，它是唯一能证明“这里本该有数据在流”的证据。
    last_down: Arc<Mutex<Option<std::time::Instant>>>,
    /// 对端网络能力画像（从 announce/probe 学到）
    pub remote_net_status: Arc<std::sync::Mutex<crate::netstatus::NetStatus>>,
    /// multi-forward 客户端监听表（task.md §11 H.2.1；默认空 = 行为与旧版完全一致）
    forwards: Arc<crate::forward::ForwardTable>,
    /// multi_forward 显式开关（默认 false）；开启后 add_forward 仍会做 caps 协商——
    /// 对端公告缺 bit0 时报 MF_UNSUPPORTED（见 mf_caps_check），对端未公告时本闸门兜底。
    mf_enabled: Arc<AtomicBool>,
    /// 债 2：multi-forward 流归属表 stream_id → target_port。
    /// version==0 放行后的 5s 探测失败时，按 target_port 找到该 forward 的全部
    /// 活跃流，显式发 STREAM_END（本地排空关闭 + 通知对端），不留静默黑洞。
    mf_stream_targets: Arc<Mutex<HashMap<u16, u16>>>,
    /// 观测：forward_targeted 开流计数 + 最近一次开流信息（Android 无 stdout，靠状态文件供数）
    mf_opened: Arc<AtomicU64>,
    mf_last_open_info: Arc<Mutex<String>>,
    /// 同机 peer_id 占位（跨进程串扰防护，见 [`PeerClaim`]）：
    /// keepalive 线程周期体检，发现被新进程接管即退位。
    claim: Arc<std::sync::Mutex<PeerClaim>>,
}

impl Connection {
    pub fn new(relay_addr: &str, my_peer_id: u32, target_peer_id: u32) -> anyhow::Result<Self> {
        Self::with_secret(relay_addr, my_peer_id, target_peer_id, None)
    }

    /// 带端到端加密构造（client 角色）。
    /// `secret` 为 None 时明文传输，仅用于对比测试。
    pub fn with_secret(
        relay_addr: &str,
        my_peer_id: u32,
        target_peer_id: u32,
        secret: Option<&str>,
    ) -> anyhow::Result<Self> {
        Self::with_secret_and_port(relay_addr, my_peer_id, target_peer_id, secret, None)
    }

    /// 与 with_secret 相同，但由宿主显式指定 P2P 监听端口：
    /// 拿不到（被占）时自动回落随机口并公告**实际端口**——
    /// 多实例宿主（myco）用它给每个实例分配不冲突的端口，避免抢 9100。
    pub fn with_secret_and_port(
        relay_addr: &str,
        my_peer_id: u32,
        target_peer_id: u32,
        secret: Option<&str>,
        preferred_p2p_port: Option<u16>,
    ) -> anyhow::Result<Self> {
        // 同进程 peer_id 冲突防护（2026-11-10 串扰事故）：
        // 两个 Connection 用同一 peer_id → relay 路由互抢 → 帧串扰 → 数据损坏。
        // 创建时立即拒绝，不让带病运行。
        // 2026-11-11：改为 RAII 守卫——构造期任何一步失败都自动释放，
        // 否则 id 永久泄漏，之后同 id 每次 start 都秒失败（手机 rc=4 真案）。
        let peer_guard = PeerIdGuard::acquire(my_peer_id)?;
        // 同机跨进程占位（newcomer-wins）：新进程接管本 peer_id，
        // 旧进程在 keepalive 体检里发现后退位，不再互抢 relay 映射。
        let claim = PeerClaim::steal(&std::env::temp_dir(), my_peer_id, "client");

        // 启动即自检入站可达性：被防火墙拦时 P2P 必然失败，必须主动报出来
        crate::fwcheck::spawn_check();

        let crypto = secret.map(|s| {
            use crate::crypto::{Role, SessionCrypto};
            SessionCrypto::new(&SessionCrypto::key_from_secret(s), Role::Client)
        });
        let encrypted = crypto.is_some();
        let relay = Arc::new(RelayClient::with_crypto(relay_addr, my_peer_id, crypto, secret)?);
        // 客户端注册退避重试（高铁/网络不稳定场景：首次注册可能因 CGN/切换失败）
        {
            let mut delay = Duration::from_secs(1);
            let mut attempt = 0;
            loop {
                attempt += 1;
                match relay.register() {
                    Ok(()) => break,
                    Err(e) => {
                        if attempt >= 5 || delay >= Duration::from_secs(16) {
                            return Err(e);
                        }
                        eprintln!("  [CLI] relay register attempt {} failed: {:#} — retry in {:?}", attempt, e, delay);
                        thread::sleep(delay);
                        delay *= 2;
                    }
                }
            }
        }
        if encrypted {
            println!("  [OK] End-to-end encryption: AES-256-GCM (PSK)");
        } else {
            println!("  [!!] WARNING: no --secret given, tunnel data is PLAINTEXT");
        }

        // 通告 STUN 发现的公网出口 IP（多出口 ISP 场景：可能与 relay 观察到的 IP 不同）
        // 端口用 relay socket 的本地端口（NAT 端口保留时即公网端口）
        // Rendezvous: 绑定固定监听端口，用「它自己」做 STUN 学出公网映射并公告。
        // NAT 映射绑在 socket 上，必须用监听 socket 本身探测。
        let p2p_port: u16 = preferred_p2p_port
            .or_else(|| std::env::var("VNET_P2P_PORT").ok().and_then(|v| v.parse().ok()))
            .unwrap_or(9100);
        let listen_rx_cnt = Arc::new(AtomicU64::new(0));
        let listen_sock = UdpSocket::bind(format!("0.0.0.0:{}", p2p_port))
            .or_else(|_| UdpSocket::bind("0.0.0.0:0"))
            .ok()
            .map(Arc::new);
        // IPv6 监听：PC→笔记本 的 IPv6 方向是通的（家宽拦入站只拦反方向），
        // 但必须真有 IPv6 socket 在这个端口上听，否则对端发来的 v6 包全被内核丢弃。
        // 注意：必须 IPV6_V6ONLY，否则与上面的 0.0.0.0:port 冲突（Linux/Android 上直接崩溃）
        // 多实例：9100 被占时回退随机口（公告必须用实际端口，见下方 announce）
        let listen_sock_v6: Option<Arc<UdpSocket>> = bind_v6_only(p2p_port)
            .or_else(|| bind_v6_only(0))
            .map(Arc::new);
        // v6 公告（原在绑定前、且 get_my_ipv6 写死 :9100 —— 多实例下会公告错端口）
        {
            let actual_v6_port = listen_sock_v6.as_ref()
                .and_then(|s| s.local_addr().ok()).map(|a| a.port());
            let ip_str = std::env::var("VNET_ANNOUNCE_V6").ok().filter(|s| !s.is_empty())
                .or_else(|| get_my_ipv6().map(|a| a.ip().to_string()))
                .filter(|ip| !ip.is_empty() && ip != "::" && ip != "0:0:0:0:0:0:0:0");
            if let (Some(port), Some(ip)) = (actual_v6_port, ip_str) {
                // VNET_ANNOUNCE_V6 可能带端口（完整 [addr]:port）也可能是裸地址
                let s = if ip.contains(']') {
                    ip.clone()
                } else {
                    format!("[{}]:{}", ip, port)
                };
                let _ = relay.announce_ipv6(&s);
                println!("  [OK] Announced IPv6: {}", s);
            }
        }
        // ── STUN 公网映射公告：纯优化，必须离开构造关键路径 ──
        // 2026-11-11 手机真案：这 3 个 STUN 服务器各自 3s 上限、串行查询，全在
        // `with_secret_and_port` 里同步跑；嵌入方（Android JNI / 浏览器 JS 桥）从
        // 调用线程进来时，UI 线程被冻住十几分钟。STUN 只决定「P2P 直连能不能用」，
        // 中继路径不依赖它——所以改成后台线程异步学映射、学到再补公告。
        let listen_pub_arc: Arc<Mutex<Option<std::net::SocketAddr>>> =
            Arc::new(Mutex::new(None));
        if let Some(ref s) = listen_sock {
            s.set_nonblocking(true).ok();
            let sock_bg = s.clone();
            let relay_bg = relay.clone();
            let pub_bg = listen_pub_arc.clone();
            let _ = std::thread::Builder::new()
                .name("vnet-stun-announce".into())
                .spawn(move || {
                    let lp = sock_bg.local_addr().map(|a| a.port()).unwrap_or(0);
                    for srv in ["stun.chat.bilibili.com:3478", "stun.hitv.com:3478", "stun.miwifi.com:3478"] {
                        if let Ok(pubaddr) = crate::stun::query_stun_on_socket(srv, &sock_bg) {
                            *pub_bg.lock().unwrap() = Some(pubaddr);
                            let _ = relay_bg.announce_ipv4(&pubaddr.to_string());
                            println!("  [RDV] Listen {} -> public {}, announced", lp, pubaddr);
                            return;
                        }
                    }
                    println!("  [RDV] WARN: listen {} STUN failed", lp);
                });
        }

        // 构造成功：peer_id 所有权交接给 Connection（此后由 stop() 释放）
        peer_guard.hand_off();
        Ok(Self {
            my_peer_id,
            target_peer_id,
            relay,
            p2p: Arc::new(Mutex::new(P2pRegistry::new())),
            path: Arc::new(Mutex::new(DataPath::Relay)),
            running: Arc::new(AtomicBool::new(true)),
            relay_packets: Arc::new(AtomicU64::new(0)),
            p2p_packets: Arc::new(AtomicU64::new(0)),
            p2p_peer: Arc::new(Mutex::new(None)),
            hub: Arc::new(Mutex::new(ConnHub::new())),
            listen_rx: listen_rx_cnt.clone(),
            stop_calls: Arc::new(AtomicU64::new(0)),
            local_port: Arc::new(AtomicU32::new(0)),
            probe_req_rx: Arc::new(AtomicU64::new(0)),
            probe_reply_rx: Arc::new(AtomicU64::new(0)),
            probe_verify_fail: Arc::new(AtomicU64::new(0)),
            listen_sock: listen_sock.clone(),
            listen_pub: listen_pub_arc,
            announced_v6: Arc::new(Mutex::new(None)),
            p2p_port_override: preferred_p2p_port,
            listen_sock_v6: listen_sock_v6.clone(),
            last_p2p_reply: Arc::new(Mutex::new(std::time::Instant::now())),
            switch_score: Arc::new(Mutex::new(0)),
            path_switches: Arc::new(Mutex::new(0)),
            last_switch_at: Arc::new(Mutex::new(std::time::Instant::now())),
            p2p_replies: Arc::new(AtomicU64::new(0)),
            punch_locked: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            pipes: Arc::new(Mutex::new(crate::pathpipe::std_pipes())),
            policy: RPolicy::default(),
            threads_alive: Arc::new(AtomicU64::new(0)),
            local_net_status: Arc::new(std::sync::Mutex::new(crate::netstatus::NetStatus::default())),
            relay_arq: Arc::new(std::sync::Mutex::new(crate::relay_arq::RelayArq::new())),
            conn_flags: Arc::new(Mutex::new(std::collections::HashMap::new())),
            stream_flags: Arc::new(Mutex::new(HashMap::new())),
            last_down: Arc::new(Mutex::new(None)),
            remote_net_status: Arc::new(std::sync::Mutex::new(crate::netstatus::NetStatus::default())),
            forwards: Arc::new(crate::forward::ForwardTable::new()),
            mf_enabled: Arc::new(AtomicBool::new(false)),
            mf_stream_targets: Arc::new(Mutex::new(HashMap::new())),
            mf_opened: Arc::new(AtomicU64::new(0)),
            mf_last_open_info: Arc::new(Mutex::new(String::new())),
            claim: Arc::new(std::sync::Mutex::new(claim)),
        })
    }

    /// 常驻接收线程：唯一从 relay socket 收包的地方
    /// 控制包（探测）就地处理，数据包入队
    fn spawn_receiver(&self) {
        let relay = self.relay.clone();
        let rx_relay_arq = self.relay_arq.clone();
        let rx_target = self.target_peer_id;
        let path = self.path.clone();
        let p2p = self.p2p.clone();
        let p2p_peer = self.p2p_peer.clone();
        let running = self.running.clone();
        let queue = self.hub.clone();
        let score_arc = self.switch_score.clone();
        let switches_arc = self.path_switches.clone();
        let last_switch_at_arc = self.last_switch_at.clone();
        let p2p_replies_arc = self.p2p_replies.clone();
        let punch_locked = self.punch_locked.clone();
        let last_reply = self.last_p2p_reply.clone();
        let score_wd = self.switch_score.clone();
        let switches_wd = self.path_switches.clone();
        let last_switch_wd = self.last_switch_at.clone();
        let pipes_rx = self.pipes.clone();
        let policy_rx = self.policy.clone();
        let down_activity = self.last_down.clone();
        let conn_flags_rx = self.conn_flags.clone();

        thread::spawn(move || {
            while running.load(Ordering::Relaxed) {
                match relay.try_recv_kind() {
                    crate::relay::RecvKind::RelayData(src, data) => {
                        // ── 串扰防护（2026-11-10）：本连接的 relay 数据只可能来自目标 peer ──
                        // 其它源（异 peer 干扰/串扰）绝不能进本连接 ARQ——外来帧的
                        // epoch/seq 会复位接收状态，把已交付字节流打乱（替换型损坏）。
                        if src != rx_target {
                            use std::sync::atomic::{AtomicU64, Ordering as OX};
                            static XT: AtomicU64 = AtomicU64::new(0);
                            let n = XT.fetch_add(1, OX::Relaxed);
                            if n < 10 || n % 100 == 0 {
                                eprintln!("  [CROSSTALK-DROP] RelayData from peer {} (target={}) — dropped #{}",
                                    src, rx_target, n + 1);
                            }
                            continue;
                        }
                        // relay ARQ：解帧 → 交付数据 + 回 ACK + 快速重传
                        let (deliver, ack_frame, fast_retransmit) = {
                            let mut raq = rx_relay_arq.lock().unwrap();
                            raq.on_packet(&data)
                        };
                        {
                            use std::sync::atomic::{AtomicU64, Ordering as OD};
                            static DBG_RX: AtomicU64 = AtomicU64::new(0);
                            let k = DBG_RX.fetch_add(1, OD::Relaxed);
                            if k < 12 {
                                println!("  [DBG-RX] RelayData#{} src={} wire={}B deliver={} ack={} fast={}",
                                    k, src, data.len(), deliver.len(), ack_frame.is_some(), fast_retransmit.len());
                            }
                        }
                        if let Some(ack) = ack_frame {
                            let _ = relay.send_to_peer(src, &ack);
                        }
                        // 快速重传：立即发送缺失帧（不等 RTO 超时）
                        for frame in fast_retransmit {
                            let _ = relay.send_to_peer(src, &frame);
                        }
                        // XPATH isolation (2026-11-10): when P2P is the active path,
                        // relay stream payloads come from stale server upstreams
                        // (server hasn't cleaned them up) → drop payloads, keep ARQ
                        // healthy (ACKs sent above). Only P2P data reaches the hub.
                        let path_is_direct = path.lock().unwrap().is_direct();
                        if path_is_direct && !deliver.is_empty() {
                            use std::sync::atomic::{AtomicU64, Ordering as XP};
                            static XP_DROP: AtomicU64 = AtomicU64::new(0);
                            let n = XP_DROP.fetch_add(1, XP::Relaxed);
                            if n < 10 || n % 100 == 0 {
                                println!("  [XPATH-DROP] P2P active, dropped {} relay payloads #{}",
                                    deliver.len(), n + 1);
                            }
                            continue;
                        }
                        // 记“下行刚交付过”：纯下行静默检测的唯一依据
                        let delivered = !deliver.is_empty();
                        // 连接多路复用：每个交付项带内层头 [tag][stream:2]，按流分发
                        for d in deliver {
                            match crate::transport::parse_stream_frame(&d) {
                                Some((crate::transport::STREAM_TAG_DATA, sid, rest)) => {
                                    queue.lock().unwrap().push_stream(sid, rest.to_vec());
                                }
                                Some((crate::transport::STREAM_TAG_STREAM_END, sid, rest)) => {
                                    // 优雅关闭：不立即置 conn_active=false（那会丢弃队列里
                                    // 还没写给应用的数据）。标记 ended，down 线程排空后退出。
                                    // 2026-11-12：payload 携带对端关流原因（如 "AUTH_REQUIRED"
                                    // / "MF_TARGET_DENIED" / "RATE-LIMIT"）——打出原因让
                                    // "优雅关流但 0 字节" 类问题 30 秒定位（ADB P0 教训）。
                                    let reason = if rest.is_empty() {
                                        String::new()
                                    } else {
                                        format!(" reason={:?}", String::from_utf8_lossy(rest))
                                    };
                                    tracelog!("[cli] STREAM_END stream={} (ARQ-ordered) -> graceful close{}", sid, reason);
                                    queue.lock().unwrap().mark_ended(sid);
                                }
                                Some((tag, sid, _)) => {
                                    println!("  [HUB] unexpected relay frame tag={} stream={} from peer={}",
                                        tag, sid, src);
                                }
                                None => {
                                    eprintln!("[HUB] malformed relay frame ({}B) dropped", d.len());
                                }
                            }
                        }
                        if delivered {
                            *down_activity.lock().unwrap() = Some(std::time::Instant::now());
                        }
                    }
                    crate::relay::RecvKind::RelayAck(pkt_type, payload) => {
                        // 控制面应答交给请求方（A_lookup_peer / 中继映射观察）判读
                        relay.push_control_ack(pkt_type, payload);
                    }
                    crate::relay::RecvKind::P2pData(from, data) => {
                        // 记录 P2P 来源（回包用）
                        *p2p_peer.lock().unwrap() = Some(from);
                        // P2P 数据同样端到端加密；解不开直接丢弃。
                        // phase 2：解内层帧按流分发（未成帧旧字节回落 owner）。
                        if let Some(plain) = relay.unseal(&data) {
                            queue.lock().unwrap().push_p2p_frame(plain);
                        }
                    }
                    crate::relay::RecvKind::ProbeReply(addr) => {
                        // 每次收到回复都刷新 P2P 对端地址（服务端重启后端口会变）
                        *p2p_peer.lock().unwrap() = Some(addr);
                        *last_reply.lock().unwrap() = std::time::Instant::now();
                        // 打洞引擎已建立通道时不得覆盖（否则两条路径抢同一通道）
                        if !punch_locked.load(std::sync::atomic::Ordering::Relaxed) {
                            // 黑盒回归修复（通道抖动引擎）：与 R25-修2 同款纪律。
                            // relay-socket 探测回包只算弱证据：通道以未验证身份入槽
                            // （其 socket 承载的 ARQ 帧对端不按流处理，不直接承载业务），
                            // 待 REPLY/打洞类的已验证通道同 IP 顶替。数据面在验证
                            // 完成前保持中继路径。
                            let need_a = match p2p.lock().unwrap().active_channel() {
                                Some(ch) => chan_rebuild_needed(ch, addr, false),
                                None => true,
                            };
                            if need_a {
                                p2p.lock().unwrap().upsert(P2pChannel::new(
                                    relay.shared_socket(),
                                    addr,
                                    false,
                                    relay.crypto_arc(),
                                    false,
                                ));
                            }
                        }
                        // A9 迟滞：连续 N 次探测回复才切换，避免路径抖动来回跳
                        p2p_replies_arc.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let mut score = score_arc.lock().unwrap();
                        *score += 1;
                        let ready = *score >= 3;
                        drop(score);
                        // O(shadow)：relay-socket 探测回包 → P2pV4 观察。
                        // 探测包出 + 签名回包入 = 双向证据；score>=3 的迟滞沿用为
                        // verified 的证据累积门槛。
                        {
                            let mut ps = pipes_rx.lock().unwrap();
                            let p4 = &mut ps[index_of(PipeKind::P2pV4)];
                            p4.o_reply_rx += 1;
                            if ready {
                                p4.mark_verified();
                            }
                            p4.update_derived(&policy_rx);
                        }
                        // 切换冷却：避免「切→丢→回→切」高频横跳（蜂窝链路实测 42 次）
                        let cooled = last_switch_at_arc.lock().unwrap().elapsed()
                            >= Duration::from_secs(30);
                        let p = path.lock().unwrap();
                        if !p.is_direct() && ready && cooled {
                            drop(p);
                            *last_switch_at_arc.lock().unwrap() = std::time::Instant::now();
                            apply_decision(&pipes_rx, &policy_rx, &path, &p2p, &switches_arc);
                            println!("  [P2P] Probe reply from {} (stable x3, cooldown ok) -> decision applied", addr);
                        }
                    }
                    crate::relay::RecvKind::PeerProbe(addr) => {
                        // 诊断：对端敲门包是否真的到达（限流打印）
                        use std::sync::atomic::{AtomicU64, Ordering as O2};
                        static CNT: AtomicU64 = AtomicU64::new(0);
                        let n = CNT.fetch_add(1, O2::Relaxed);
                        if n < 5 || n % 20 == 0 {
                            println!("  [P2P-IN] peer probe from {} (#{})", addr, n + 1);
                        }
                    }
                    crate::relay::RecvKind::Ignored => {
                        thread::sleep(Duration::from_millis(1));
                    }
                }

                // 保底 watchdog：P2P 模式下 8 秒没收到探测回复 → 回退中继
                {
                    let p = path.lock().unwrap();
                    // 中继只做「连通性兜底」：只有 P2P 彻底失联 30 秒才回退，
                    // 而不是「质量下降就回退」——后者在有损链路上会造成永不停歇的横跳。
                    if p.is_direct() && last_reply.lock().unwrap().elapsed() > Duration::from_secs(30) {
                        println!("  [P2P] No probe reply for 30s -> fallback to Relay");
                        // O(shadow)：30s 无探测回包 → 当前直连管道记失败证据
                        {
                            let fam = if *p == DataPath::P2PIpv6 {
                                PipeKind::P2pV6
                            } else {
                                PipeKind::P2pV4
                            };
                            let mut ps = pipes_rx.lock().unwrap();
                            let pp = &mut ps[index_of(fam)];
                            pp.mark_failed();
                            pp.update_derived(&policy_rx);
                        }
                        drop(p);
                        *score_wd.lock().unwrap() = 0;
                        *last_switch_wd.lock().unwrap() = std::time::Instant::now();
                        apply_decision(&pipes_rx, &policy_rx, &path, &p2p, &switches_wd);
                    }
                }
            }
        });
    }

    fn ctx(&self) -> ForwardCtx {
        ForwardCtx {
            running: self.running.clone(),
            relay: self.relay.clone(),
            relay_arq: self.relay_arq.clone(),
            p2p: self.p2p.clone(),
            path: self.path.clone(),
            hub: self.hub.clone(),
            p2p_peer: self.p2p_peer.clone(),
            target_peer_id: self.target_peer_id,
            pipes: self.pipes.clone(),
            policy: self.policy.clone(),
            switches: self.path_switches.clone(),
            conn_flags: self.conn_flags.clone(),
            stream_flags: self.stream_flags.clone(),
            mf_stream_targets: self.mf_stream_targets.clone(),
            self_dial: self.target_peer_id == self.my_peer_id,
            mf_opened: self.mf_opened.clone(),
            mf_last_open_info: self.mf_last_open_info.clone(),
        }
    }

    /// 停止（FFI/嵌入用）：所有工作线程在下一轮轮询退出
    pub fn stop(&self) {
        let n = self.stop_calls.fetch_add(1, Ordering::Relaxed) + 1;
        println!("  [STOP] stop() #{} called by host (listener :{})",
            n, self.local_port.load(Ordering::Relaxed));
        self.running.store(false, Ordering::Relaxed);
        self.forwards.shutdown();
        // peer_id 释放（允许同 id 的新 Connection 重建）
        peer_id_release(self.my_peer_id);
        // DSH 2026-11-10 建议：stop 时通知 relay 删 peer 条目（不等 TTL）。
        // 旧 relay 忽略 type 11（无害）；新 relay 即时清理，churn 不再污染 peer 表。
        self.relay.unregister();
        // 同机占位清理：仍属于本进程时删除（被新进程接管后不删它的）。
        self.claim.lock().unwrap().release_if_mine();
    }

    // ── multi-forward（task.md §11 H.2.1；与 myco 2026-11-09 冻结的 API）──

    /// 显式开启 multi-forward（宿主确认对端可信后调用）。默认关闭。
    /// 开启后每次 `add_forward` 仍做 caps 协商：对端公告缺 multi_forward 位 →
    /// `MF_UNSUPPORTED`（见 [`mf_caps_check`]）；对端未公告 NetStatus 时本开关是唯一闸门。
    /// 返回上一个开关值。
    pub fn enable_multi_forward(&self) -> bool {
        let was = self.mf_enabled.swap(true, Ordering::Relaxed);
        if !was {
            println!("  [FWD] multi-forward enabled (targeted SESSION_START)");
        }
        was
    }

    /// 添加一条本地转发并立即开始 accept。
    /// 语义见 `forward::ForwardTable::add`（四条硬语义，含严格绑定/无半启动）。
    pub fn add_forward(
        self: &std::sync::Arc<Self>,
        spec: crate::forward::ForwardSpec,
    ) -> anyhow::Result<crate::forward::ForwardInfo> {
        if !self.mf_enabled.load(Ordering::Relaxed) {
            anyhow::bail!(
                "MF_DISABLED: call enable_multi_forward() first \
                 (requires server >= 21197f08 and target in its whitelist)"
            );
        }
        // 能力协商（H.2）：对端公告的 caps 缺 multi_forward 位 → 显式 MF_UNSUPPORTED，
        // 绝不让 targeted SESSION_START 静默落到旧 server 的默认口（误路由）。
        // 债 2：version==0 的放行是 fail-open——旧对端可能静默误路由。同步语义
        // 保持不变（放行 + WARN，向后兼容），但记下放行事实，建 route 后起 5s
        // 后台 PING/PONG 探测异步补判（probe-then-decide）。
        let mf_probe_needed = {
            let remote = self.remote_net_status.lock().unwrap();
            mf_caps_check(&remote)?;
            remote.version == 0
        };
        // Weak 打破循环引用：Connection → forwards → 回调 → Weak<Connection>
        let weak = std::sync::Arc::downgrade(self);
        let cb: crate::forward::OnAccept = Arc::new(move |stream, target| {
            if let Some(conn) = weak.upgrade() {
                conn.ctx().forward_targeted(stream, Some(target));
            }
        });
        let info = self.forwards.add(spec, cb)?;
        println!("  [FWD] 127.0.0.1:{} -> remote:{} (targeted)",
            info.local_port, info.target_port);
        // 债 2：对未公告 NetStatus 的对端起后台存活探测。返回值不变（立即 Ok），
        // 探测结果异步经日志交付（PONG → 保持；5s 无 PONG → ERROR + STREAM_END 该 forward 的流）。
        if mf_probe_needed {
            self.spawn_mf_caps_probe(info.local_port, info.target_port);
        }
        Ok(info)
    }

    /// 当前全部转发的快照（不持锁返回）。
    pub fn forwards(&self) -> Vec<crate::forward::ForwardInfo> {
        self.forwards.list()
    }

    /// 停止并移除一条转发（key = **实际** local_port）。
    /// 返回 Ok 时端口已释放；已建立的连接不受影响（所有权在回调侧）。
    pub fn remove_forward(&self, local_port: u16) -> anyhow::Result<()> {
        self.forwards.remove(local_port)?;
        println!("  [FWD] 127.0.0.1:{} removed (port released)", local_port);
        Ok(())
    }

    // ── 债 2（2026-11-11/12 生产事故）：mf_caps_check 的 fail-open → 超时探测 ──

    /// 对未公告 NetStatus 的对端（version==0 放行）起后台存活探测：
    /// - PONG 到 → 对端活着，multi-forward 大概率可用，转发保持（log OK）；
    /// - 5s 无 PONG → 对端不可达/不支持，log ERROR 并对该 forward 的流显式
    ///   STREAM_END（本地排空关闭 + 通知对端，不留静默黑洞）。
    /// 非破坏性：只影响日志与既有流的显式失败，不改 add_forward 的同步返回。
    fn spawn_mf_caps_probe(self: &Arc<Self>, local_port: u16, target_port: u16) {
        // 安全阀（2026-11-12 Android native 崩排查）：VNET_MF_PROBE=0 禁用探测
        if std::env::var("VNET_MF_PROBE").map(|v| v == "0").unwrap_or(false) {
            tracelog!("[FWD] caps probe disabled (VNET_MF_PROBE=0)");
            return;
        }
        let conn = Arc::clone(self);
        let spawned = thread::Builder::new()
            .name(format!("mf-caps-probe-{}", local_port))
            .spawn(move || {
                tracelog!("[FWD] caps unknown (version=0): probing peer {} via relay ARQ PING (wait 5s)",
                    conn.target_peer_id);
                if conn.probe_peer_alive(Duration::from_secs(5)) {
                    println!("  [FWD] caps probe OK: PONG from peer {} within 5s — \
forward 127.0.0.1:{} -> remote:{} kept active",
                        conn.target_peer_id, local_port, target_port);
                } else {
                    // 2026-11-12 真案：P2P-v6 连接 + relay 探测 → PONG 不达（探测槽
                    // 与 SilenceLadder 共享、路径不对称等）→ 误杀健康流（accepted=2
                    // 但 PC 零 STREAM_OPEN）。改为 warn-only：探测失败只记日志，
                    // 不终结流——黑洞由 dataPlaneAlive（宿主侧）或静默梯兜底。
                    eprintln!("  [FWD] WARN: no PONG from peer {} in 5s (probe inconclusive — \
P2P path may be alive while relay probe fails); forward 127.0.0.1:{} -> remote:{} kept active",
                        conn.target_peer_id, local_port, target_port);
                }
            });
        if let Err(e) = spawned {
            // 探测线程起不来：维持 fail-open 原语义（放行），只留 WARN 不阻断
            eprintln!("  [FWD] WARN: caps probe thread spawn failed: {:#} \
(forward stays active, legacy fail-open)", e);
        }
    }

    /// 债 2：经 relay ARQ 发一个端到端 PING，timeout 内等 PONG。
    /// PONG 由常驻接收线程喂给 `relay_arq.on_packet` 处理（对上 nonce 才计数），
    /// 因此这里轮询 `probes_ok` 计数增量而不是在途位——在途位无法区分
    /// 「被应答」与「被并发探测清掉」（SilenceLadder/其它 forward 的探测共用
    /// 同一个探测槽），计数增量才是真往返证据。同窗口内任何一次 PONG 都算
    /// 「对端活着」：它们走的是同一条 relay 数据面。
    /// 注意：这证明的是「隧道端到端往返活性」，不是「upstream 服务可用」
    /// （task.md §6.1-8 已知盲点）；upstream 侧请用 confirm_forward。
    pub fn probe_peer_alive(&self, timeout: Duration) -> bool {
        if !self.running.load(Ordering::Relaxed) {
            return false; // 已 stop：接收线程已退，探测无意义
        }
        let (frame, baseline) = {
            let mut arq = self.relay_arq.lock().unwrap();
            // SilenceLadder 可能留有在途探测：先清再发（与其自身轮转同款做法）
            arq.clear_probe();
            let frame = arq.start_probe();
            if frame.is_empty() {
                return false; // 理论不可达（刚清过），防御性返回
            }
            (frame, arq.probes_ok)
        };
        if let Err(e) = self.relay.send_to_peer(self.target_peer_id, &frame) {
            eprintln!("  [FWD] probe_peer_alive: send PING to peer {} failed: {:#}",
                self.target_peer_id, e);
            return false;
        }
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.relay_arq.lock().unwrap().probes_ok > baseline {
                return true; // PONG 已被接收线程处理并计数
            }
            if !self.running.load(Ordering::Relaxed) {
                return false;
            }
            thread::sleep(Duration::from_millis(25));
        }
        // 超时收尾：清掉在途探测位，避免 SilenceLadder 把死探测当自己的在途状态
        self.relay_arq.lock().unwrap().clear_probe();
        false
    }

    /// 债 2：对某 forward（按 target_port 归属）的全部活跃流显式终结：
    /// 1) 向对端发按流 STREAM_END（旧 server 只打 unexpected 日志，无害）；
    /// 2) 本地 hub mark_ended → down 线程排空队列后关闭本地应用连接
    ///    （G6 显式失败：不再留「对端已死但本地连接静默挂住」的黑洞外观）。
    /// 返回终结的流数（0 = 该 forward 尚无活跃流，仅日志即可）。
    fn mf_terminate_forward_streams(&self, target_port: u16, reason: &str) -> usize {
        // 快照后逐流处理：探测失败是异步补判，快照语义可接受（新连接由后续探测兜）
        let sids: Vec<u16> = {
            let m = self.mf_stream_targets.lock().unwrap();
            m.iter().filter(|(_, &t)| t == target_port).map(|(&s, _)| s).collect()
        };
        let n = sids.len();
        for sid in sids {
            // 与 up 线程同款双路径发送：direct → P2P 通道（无通道回落 relay）；否则 relay ARQ
            let frame = crate::transport::wrap_stream_frame(
                crate::transport::STREAM_TAG_STREAM_END, sid, reason.as_bytes());
            let direct = self.path.lock().unwrap().is_direct();
            let mut sent_via_p2p = false;
            if direct {
                let guard = self.p2p.lock().unwrap();
                if let Some(ch) = guard.active_channel() {
                    let _ = ch.stream.lock().unwrap().send(&frame);
                    sent_via_p2p = true;
                }
            }
            if !sent_via_p2p {
                let (nf, rf) = {
                    let mut raq = self.relay_arq.lock().unwrap();
                    raq.send(&frame);
                    raq.flush_and_tick()
                };
                for f in nf { let _ = self.relay.send_to_peer(self.target_peer_id, &f); }
                for f in rf { let _ = self.relay.send_to_peer(self.target_peer_id, &f); }
            }
            // 本地优雅关闭：down 线程排空该流队列后关连接（不丢已到达的数据）
            self.hub.lock().unwrap().mark_ended(sid);
            self.mf_stream_targets.lock().unwrap().remove(&sid);
            tracelog!("[FWD] STREAM_END stream={} target={} reason={} (caps probe-fail)",
                sid, target_port, reason);
        }
        n
    }

    // ── 债 3（2026-11-11/12 生产事故）：端到端转发确认 API ──

    /// 端到端 forward 确认：经 forward 的本地 listener 打一条测试流，发 4 字节
    /// 探测头，等响应（或连接关闭）。只有数据真的流过
    /// 本地 → 隧道 → 对端 → target_port upstream 全路径才返回 Ok。
    /// 宿主在 add_forward() 后可选调用——本地 bind 成功 ≠ 隧道可达（生产事故：
    /// alive 外观下的静默黑洞）。便捷方法，不改变任何既有行为。
    pub fn confirm_forward(&self, local_port: u16, timeout: Duration) -> anyhow::Result<()> {
        confirm_forward_probe(local_port, timeout)
    }

    /// legacy 单转发：后台线程 + 一个空 target 的本地 listener，行为不变。
    pub fn start_client(&self, local_port: u16) -> anyhow::Result<()> {
        self.start_client_inner(Some(local_port))
    }

    /// multi-forward 生命周期接缝：只起 relay 接收/keepalive/探测线程，
    /// **不建 legacy listener**——各服务监听由 [`Connection::add_forward`] 独立绑定，
    /// 避免与首个服务抢口或发空 target 流。
    /// （与产品仓 embedding 侧 `start_multi_forward` 同义；2026-11-11 手机端需要它。）
    pub fn start_client_multi(&self) -> anyhow::Result<()> {
        self.start_client_inner(None)
    }

    fn start_client_inner(&self, local_port: Option<u16>) -> anyhow::Result<()> {
        println!("  [OK] Relay connected as peer {}", self.my_peer_id);
        tracelog!("[BOOT] start_client entered (relay registered)");
        let listen_sock_v6 = self.listen_sock_v6.clone();

        self.threads_alive.fetch_add(1, Ordering::Relaxed);
        let ka_relay = self.relay.clone();
        // 换网自愈（2026-11-13）：记住上一次到 relay 的实际源 **IP**（不比端口），
        // 变化即触发重注册。探测 socket 每次 bind(0) 端口都不同，比 SocketAddr 会
        // 每秒误判「变化」→ 每秒重注册（已踩）。
        let ka_last_src: Arc<Mutex<Option<std::net::IpAddr>>> =
            Arc::new(Mutex::new(self.relay.local_src_addr().map(|a| a.ip())));
        // 死判定（网络切换后数据面黑洞的显式信号；上层据此重建，不再靠 listener 猜）
        let ka_dead: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
        let ka_dead_reason: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let ka_dead_streak: Arc<std::sync::atomic::AtomicU32> =
            Arc::new(std::sync::atomic::AtomicU32::new(0));
        // 给 punch 状态写入器的副本（keepalive 闭包会 move 原值，必须在 spawn 前克隆）
        let dead_for_status = ka_dead.clone();
        let dead_reason_for_status = ka_dead_reason.clone();
        let last_src_for_status = ka_last_src.clone();
        let relay_for_status2 = ka_relay.clone();
        let ka_relay_arq = self.relay_arq.clone();
        let ka_target = self.target_peer_id;
        let ka_run = self.running.clone();
        // ── 感知+status 搬到 keepalive 线程（always-on，NO_P2P 也运行）──
        let ka_ns = self.local_net_status.clone();
        let ka_p2p = self.p2p.clone();
        let ka_path = self.path.clone();
        let ka_id = self.my_peer_id;
        let ka_tgt = self.target_peer_id;
        let ka_enc = self.relay.is_encrypted();
        let ka_sw = self.path_switches.clone();
        let ka_ta = self.threads_alive.clone();
        // NO_P2P 模式的 status 也要能对账转发表/端口（与探测循环完整版同键）
        let ka_forwards = self.forwards.clone();
        let ka_p2p_sock = self.listen_sock.clone();
        let ka_stop_calls = self.stop_calls.clone();
        let ka_local_port = self.local_port.clone();
        // forward_targeted 观测（Android 状态文件排障）
        let ka_mf_opened = self.mf_opened.clone();
        let ka_mf_last_info = self.mf_last_open_info.clone();
        let ka_prq = self.probe_req_rx.clone();
        let ka_prp = self.probe_reply_rx.clone();
        let ka_lrx = self.listen_rx.clone();
        let ka_conns = self.conn_flags.clone();
        let ka_stream_flags = self.stream_flags.clone();
        let ka_down = self.last_down.clone();
        let ka_remote_ns = self.remote_net_status.clone();
        let ka_claim = self.claim.clone();
        let ka_forwards_teardown = self.forwards.clone();
        thread::spawn(move || {
            let mut sense_at = std::time::Instant::now();
            let mut stat_at = std::time::Instant::now();
            let mut renew_at = std::time::Instant::now();
            let mut punch_hello_at = std::time::Instant::now();   // INV-1 敲门帧节拍
            let mut punch_hello_n: u32 = 0;                       // INV-1 独立 nonce 计数
            let mut relay_silence_check = std::time::Instant::now(); // 蜂窝映射腐烂检测
            let mut remote_ns_at = std::time::Instant::now() - Duration::from_secs(10); // 启动即拉一次
            let mut ladder = SilenceLadder::default();
            let mut first = true;
            // per-peer 身份（H.3.1）：启动立即广播一次 AUTH——第一条应用流可能先于
            // 首个 5s tick 到来，晚发会导致 server 闸门误拒（AUTH_REQUIRED）。
            if crate::identity::enabled() {
                if let Some(frame) = crate::identity::build_auth_frame(ka_id, ka_tgt) {
                    let mut raq = ka_relay_arq.lock().unwrap();
                    raq.send(&frame);
                }
            }
            while ka_run.load(Ordering::Relaxed) {
                // 1s sensing (STUN + interface + auto re-register on change)
                if sense_at.elapsed() >= Duration::from_secs(1) {
                    sense_at = std::time::Instant::now();
                    // 同机 peer_id 占位体检（2026-11-10 串扰事故）：
                    // 新进程已接管（newcomer-wins）→ 本进程退位：停续租/关监听/注销，
                    // 让 relay 映射稳定在新进程上——继续互抢只会让下行帧在两个
                    // 进程间振荡投递（替换型损坏 + 正主流空洞）。
                    if ka_claim.lock().unwrap().poll() == ClaimPoll::Superseded {
                        println!("  [SUPERSEDED] peer_id {} taken over by another live process — yielding: stop renewing, close listeners, unregister",
                            ka_id);
                        ka_run.store(false, Ordering::Relaxed);
                        ka_forwards_teardown.shutdown();
                        ka_relay.unregister();
                        peer_id_release(ka_id);
                        break;
                    }
                    // 把 relay 侧 ARQ srtt 发布给路径决策（RTT 倒挂防御需要 relay 基线；
                    // relay pipe 自身没有探针，历史上拿不到 RTT → 防御形同虚设）。
                    if let Some(ms) = ka_relay_arq.lock().unwrap().rtt_ms() {
                        note_relay_rtt(ms);
                    }
                    let mut ns = ka_ns.lock().unwrap();
                    let old_v6 = ns.ipv6;
                    let new_v6: Option<std::net::SocketAddr> = get_my_ipv6();
                    let (new_if, new_cost) = probe_default_if_status();
                    // 2026-11-13 换网自愈：`/proc/net/route` 在 Android 被 SELinux 屏蔽
                    // → if_type/if_cost 恒 Unknown，换网完全不可见。改用「到 relay 的
                    // 实际本地源地址」作为主信号：WiFi→蜂窝时源 IP 必变。
                    // 两个细节（都踩过/防过）：
                    //  1) 只比 **IP** 不比端口——探测 socket 每次 bind(0) 端口不同
                    //  2) 瞬态 None（切换瞬间无路由）**不**当作变化：否则一次抖动
                    //     触发两次无谓重注册。恢复后按 IP 比对，真变了才触发。
                    let new_src_ip = ka_relay.local_src_addr().map(|a| a.ip());
                    let src_changed = match new_src_ip {
                        Some(ip) => {
                            let mut last = ka_last_src.lock().unwrap();
                            let changed = last.map_or(true, |old| old != ip);
                            if changed {
                                println!("  [NETSTAT] relay source IP changed: {:?} -> {}",
                                    *last, ip);
                                *last = Some(ip);
                            }
                            changed
                        }
                        None => false, // 瞬态无路由：等恢复后比对
                    };
                    let changed = new_v6 != old_v6 || new_if != ns.if_type || new_cost != ns.if_cost
                        || src_changed;
                    if changed {
                        ns.ipv6 = new_v6;
                        ns.if_type = new_if;
                        ns.if_cost = new_cost;
                        ns.version += 1;
                        ns.sensed_at = std::time::Instant::now();
                        if first {
                            println!("  [NETSTAT] initial v{}", ns.version);
                            first = false;
                        } else {
                            println!("  [NETSTAT] v{} changed, re-registering", ns.version);
                            // 网络切换后必须重新注册（relay 的 peer→地址映射需要更新）
                            if let Err(e) = ka_relay.register() {
                                eprintln!("  [NETSTAT] re-register failed: {}", e);
                            }
                            if let Ok(pub4) = crate::stun::query_stun("stun.chat.bilibili.com:3478", 0) {
                                let _ = ka_relay.announce_ipv4(&pub4.to_string());
                            }
                            if let Some(v6) = ns.ipv6 {
                                if !v6.ip().is_unspecified() {
                                    let _ = ka_relay.announce_ipv6(&v6.to_string());
                                }
                            }
                            let ns_str = ns.to_announce_extra();
                            let _ = ka_relay.announce_netstatus(ns_str.trim());
                            ka_p2p.lock().unwrap().active = None;
                        }
                    } else {
                        ns.sensed_at = std::time::Instant::now();
                    }
                    // ── 死判定（2026-11-13 换网自愈需求）──────────────────────
                    // 上层不再靠 listener 探活猜：这里给出显式 dead 位。
                    // 判据：有在途数据（expect_data）+ relay 长时间无任何回包。
                    // 换网后 relay peer 表仍是旧源地址 → 我们发得出去但收不到 →
                    // relay_silent 持续增长，正好就是「数据面黑洞」的机器可读信号。
                    {
                        let has_inflight = ka_relay_arq.lock().unwrap().expect_data();
                        let silent_ms = ka_relay.relay_silent_for()
                            .map(|d| d.as_millis() as u64).unwrap_or(0);
                        const DEAD_AFTER_MS: u64 = 25_000;
                        const ALIVE_BELOW_MS: u64 = 5_000;
                        if has_inflight && silent_ms > DEAD_AFTER_MS {
                            if !ka_dead.swap(true, Ordering::Relaxed) {
                                let reason = format!(
                                    "no relay reply for {}ms with in-flight data (network switched?)",
                                    silent_ms);
                                *ka_dead_reason.lock().unwrap() = reason.clone();
                                println!("  [DEAD] {}", reason);
                            }
                        } else if silent_ms < ALIVE_BELOW_MS {
                            if ka_dead.swap(false, Ordering::Relaxed) {
                                *ka_dead_reason.lock().unwrap() = String::new();
                                println!("  [DEAD] cleared (relay responding again)");
                            }
                        }
                    }
                }
                // 5s status write (always-on, even with NO_P2P)
                if stat_at.elapsed() >= Duration::from_secs(5) {
                    stat_at = std::time::Instant::now();
                    // per-peer 身份（H.3.1）：周期广播 AUTH（server 侧 120s TTL；
                    // 重发也覆盖丢包与路径切换后 P2P entry 重建的场景）
                    if crate::identity::enabled() {
                        if let Some(frame) = crate::identity::build_auth_frame(ka_id, ka_tgt) {
                            let direct = ka_path.lock().unwrap().is_direct();
                            if direct {
                                let g = ka_p2p.lock().unwrap();
                                if let Some(ch) = g.active_channel() {
                                    let _ = ch.stream.lock().unwrap().send(&frame);
                                }
                            } else {
                                let mut raq = ka_relay_arq.lock().unwrap();
                                raq.send(&frame);
                            }
                        }
                    }
                    let p = format!("{:?}", ka_path.lock().unwrap());
                    let sw = ka_sw.lock().unwrap().to_string();
                    let strat = {
                        // strategy 必须吃「本端 + 对端」两份真实状态。
                        // 之前写成 strategy(&ns, &ns)：把本端当对端用 → 对端画像形同虚设。
                        let local = ka_ns.lock().unwrap().clone();
                        let remote = ka_remote_ns.lock().unwrap().clone();
                        crate::netstatus::NetStatus::strategy(&local, &remote).as_str().to_string()
                    };
                    let remote_summary = {
                        let r = ka_remote_ns.lock().unwrap();
                        format!("v={} if={:?} v6={} v6in={}", r.version, r.if_type,
                                r.ipv6.is_some(), r.ipv6_inbound.as_str())
                    };
                    let body = format!(
                        "role=client\nmy_peer_id={}\ntarget_peer_id={}\npath={}\npath_switches={}\nstrategy={}\nremote_ns={}\nprobe_req_rx={}\nprobe_reply_rx={}\nlisten_rx={}\nthreads_alive={}\nencrypted={}\nupdated_at={:?}\n",
                        ka_id, ka_tgt, p, sw, strat, remote_summary,
                        ka_prq.load(Ordering::Relaxed),
                        ka_prp.load(Ordering::Relaxed),
                        ka_lrx.load(Ordering::Relaxed),
                        ka_ta.load(Ordering::Relaxed),
                        ka_enc,
                        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default().as_secs()
                    );
                    // 与探测循环里的完整版 status 同键（NO_P2P 模式也必须能看到这些）：
                    // 宿主靠 stop_calls/local_port 定位停端口问题，靠 forwards.* 对账转发表。
                    let mut body = body;
                    // 死判定 + 换网源地址（2026-11-13 换网自愈：上层读这两个键决定重建）
                    body.push_str(&format!("dead={}\ndead_reason={}\nrelay_silent_ms={}\nrelay_src={}\n",
                        ka_dead.load(Ordering::Relaxed),
                        ka_dead_reason.lock().unwrap().clone(),
                        ka_relay.relay_silent_for().map(|d| d.as_millis() as u64).unwrap_or(0),
                        ka_last_src.lock().unwrap()
                            .map(|a| a.to_string()).unwrap_or_else(|| "-".to_string())));
                    // ARQ 可观测：重传/窗口满/最长间隙（RDP 指针卡顿诊断）
                    {
                        let raq = ka_relay_arq.lock().unwrap();
                        body.push_str(&format!("arq_retransmits={}\n", raq.retransmit_count));
                        body.push_str(&format!("arq_window_full={}\n", raq.window_full_count));
                        body.push_str(&format!("arq_stall_max_ms={}\n", raq.max_stall_ms));
                    }
                    let ka_fwd_list = ka_forwards.list();
                    let ka_p2p_port = ka_p2p_sock
                        .as_ref()
                        .and_then(|s| s.local_addr().ok())
                        .map(|a| a.port())
                        .unwrap_or(0);
                    body.push_str(&format!("stop_calls={}\nlocal_port={}\np2p_port={}\nforwards={}\n",
                        ka_stop_calls.load(Ordering::Relaxed),
                        ka_local_port.load(Ordering::Relaxed),
                        ka_p2p_port,
                        ka_fwd_list.len()));
                    for f in &ka_fwd_list {
                        body.push_str(&format!("forward.{}={}:{}/{} {}\n",
                            f.local_port, f.target_port, f.accepted, f.active, f.listening));
                    }
                    // forward_targeted 观测：流开计数 + 最近一次开流信息（Android 黑洞排障）
                    body.push_str(&format!("mf_opened={}\nmf_last_open={}\n",
                        ka_mf_opened.load(Ordering::Relaxed),
                        *ka_mf_last_info.lock().unwrap()));
                    // IPv6 探测发包成败（2026-11-13 DSH 审计：req>0 rep=0 归因）
                    body.push_str(&format!("v6_send_ok={}\nv6_send_fail={}\n",
                        V6_SEND_OK.load(Ordering::Relaxed),
                        V6_SEND_FAIL.load(Ordering::Relaxed)));
                    // 本机全局 v6 地址（判「发了但收不到 vs 有地址对端不应答」）
                    {
                        let (n, first) = local_v6_snapshot();
                        body.push_str(&format!("v6_local_count={}\nv6_local_first={}\n", n, first));
                    }
                    let _ = std::fs::write(status_file_path_for("client", ka_id), body);
                }
                {
                        // relay ARQ：重传 + 流控 flush
                        let (new_f, retrans_f) = ka_relay_arq.lock().unwrap().flush_and_tick();
                        for frame in new_f { let _ = ka_relay.send_to_peer(ka_target, &frame); }
                        for frame in retrans_f { let _ = ka_relay.send_to_peer(ka_target, &frame); }
                    }
                    ka_relay.keepalive();
                    // 数据面静默检测 → 分层恢复 → 显式失败（task.md §3.1-6/7）
                    let down_recent = ka_down.lock().unwrap()
                        .map_or(false, |at: std::time::Instant| at.elapsed() < DOWNLINK_ACTIVE_WINDOW);
                    silence_ladder_tick(&ka_relay_arq, &ka_relay, ka_tgt, &ka_conns,
                                        &ka_stream_flags, down_recent, &mut ladder);
                    // relay 注册是周期续租：relay 重启后映射全丢时，下一周期自动重建。
                    if renew_at.elapsed() >= Duration::from_secs(5) {
                        renew_at = std::time::Instant::now();
                        ka_relay.renew_registration();
                    }
                    // INV-1 动态双向探测（2026-11-09 恢复 11-04 设计）：
                    // 非直连期间周期经 relay DATA 通道向 server peer 发 PING 敲门帧。
                    // server 的 relay 主循环收到任何对端 relay-data 即
                    // learned_peers.insert(src_peer)（既有逻辑），其 punch 线程
                    // 5 轮内 query_peer_info 拿到本端公告地址 → server 侧主动
                    // 回敲——穿透「本端入站被拦、对端入站放行」的单向封锁
                    // （有状态防火墙回流放行，PLAN §四原文机制）。
                    // 独立 nonce（不碰 SilenceLadder 的探测状态）；PONG 回来
                    // 在无在途探测时被 ARQ 忽略，零干扰。
                    if punch_hello_at.elapsed() >= Duration::from_secs(10) {
                        punch_hello_at = std::time::Instant::now();
                        let direct = ka_path.lock().unwrap().is_direct();
                        if !direct {
                            let nonce = ka_id
                                .wrapping_mul(1_000_003)
                                .wrapping_add(punch_hello_n);
                            punch_hello_n = punch_hello_n.wrapping_add(1);
                            let frame = crate::transport::build_ping(nonce);
                            let _ = ka_relay.send_to_peer(ka_target, &frame);
                        }
                    }
                    // relay 静默检测（蜂窝映射腐烂，2026-11-09 复现×3）：
                    // keepalive 每 5s 发但 relay 30s 无任何回包 = CGN/热点防火墙
                    // 把我们的映射吃了 → 全量 re-register（等 ACK 确认那种）重建。
                    // 与「网络变化检测」互补：那边看接口/地址变，这边看 relay 哑了。
                    if relay_silence_check.elapsed() >= Duration::from_secs(30) {
                        relay_silence_check = std::time::Instant::now();
                        if let Some(silent) = ka_relay.relay_silent_for() {
                            if silent > Duration::from_secs(30) {
                                println!("  [NETSTAT] relay silent {}ms despite keepalives -> re-register",
                                    silent.as_millis());
                                if let Err(e) = ka_relay.register() {
                                    eprintln!("  [NETSTAT] re-register after silence failed: {} (will retry)", e);
                                } else {
                                    println!("  [NETSTAT] re-register after silence OK");
                                }
                            }
                        }
                    }
                    // 对端网络画像周期拉取（5s）：query_peer_info 把对端 NetStatus 原文
                    // 写进 relay 旁路缓存，这里读出并解析进 remote_net_status。
                    // 之前这个字段只被 strategy 读、从没被写入 → 对端状态一直靠 default 猜。
                    if remote_ns_at.elapsed() >= Duration::from_secs(5) {
                        remote_ns_at = std::time::Instant::now();
                        // query_peer_info 把对端 NetStatus 原文写进 relay 旁路缓存；
                        // 返回的 ipv6 也要合并进 remote.ipv6——strategy 的 v6 直连判断
                        // 依赖 remote.ipv6，而 NetStatus 的 announce_extra 不含 IPv6 地址。
                        let peer_ipv6 = ka_relay.query_peer_info(ka_tgt)
                            .and_then(|(_, v6, _)| v6);
                        if let Some(ns_str) = crate::relay::peer_netstatus(ka_tgt) {
                            let cur_ver = ka_remote_ns.lock().unwrap().version;
                            if let Some(mut parsed) =
                                crate::netstatus::NetStatus::parse_announce_extra(&ns_str, cur_ver)
                            {
                                parsed.ipv6 = peer_ipv6;
                                *ka_remote_ns.lock().unwrap() = parsed;
                            }
                        } else if let Some(v6) = peer_ipv6 {
                            // 对端还没公告 NetStatus，但至少把它的 IPv6 地址记下来
                            ka_remote_ns.lock().unwrap().ipv6 = Some(v6);
                        }
                    }
                thread::sleep(Duration::from_millis(500));
            }
        });

        // 常驻接收线程（唯一 recv 方）：空闲时也处理探测回复，保证 P2P 能建立
        self.threads_alive.fetch_add(1, Ordering::Relaxed);
        self.spawn_receiver();

        let probe_relay = self.relay.clone();
        let my_id_for_status = self.my_peer_id;
        let enc_for_status = self.relay.is_encrypted();
        let last_rtt_for_status = Arc::new(Mutex::new(String::from("-")));
                let listen_rx_for_status = self.listen_rx.clone();
        // 宿主诊断：stop() 次数 + 本地代理实际端口（区分「宿主主动停」与「进程死了」）
        let stop_calls_for_status = self.stop_calls.clone();
        let local_port_for_status = self.local_port.clone();
        // multi-forward 可观测：转发表快照 + rendezvous(P2P) 实际监听口
        let forwards_for_status = self.forwards.clone();
        let p2p_sock_for_status = self.listen_sock.clone();
        let probe_req_for_status = self.probe_req_rx.clone();
        let probe_reply_for_status = self.probe_reply_rx.clone();
        let probe_fail_for_status = self.probe_verify_fail.clone();
        let threads_alive_for_status = self.threads_alive.clone();
        let net_status_for_status = self.local_net_status.clone();
        let remote_ns_for_status = self.remote_net_status.clone();
        let path_switches_for_status = self.path_switches.clone();
        // 观测统一：punch 版也带 mf/arq 键（同一文件双写者格式必须一致，
        // 2026-11-12 DSH 误判「mf_opened 不存在」= punch 版覆盖了 keepalive 版）
        let mf_opened_for_status = self.mf_opened.clone();
        let mf_last_info_for_status = self.mf_last_open_info.clone();
        let arq_for_status = self.relay_arq.clone();
        // 死判定/换网源地址也必须在 punch 版里（否则 1s 一次的 punch 写会盖掉
        // keepalive 版的 dead 键——同一个坑 2026-11-12 已经踩过一次）
        // 副本已在 ka_dead 声明处克隆（keepalive 闭包 move 原值）。
        let local_ip_watch = Arc::new(Mutex::new(get_my_local_ipv4()));
        let switch_score_net = self.switch_score.clone();
        let path_switches_net = self.path_switches.clone();
        let p2p = self.p2p.clone();
        let p2p_peer = self.p2p_peer.clone();
        let path = self.path.clone();
        let running = self.running.clone();
        let target_id = self.target_peer_id;

        // DIAG: VNET_NO_P2P=1 完全禁用客户端 P2P 探测（隔离变量测试纯 relay）
        let no_p2p = std::env::var("VNET_NO_P2P").unwrap_or_default() == "1";
        let rx_queue_for_probe = self.hub.clone();
        let last_reply_for_v6 = self.last_p2p_reply.clone();
        let pipes_probe = self.pipes.clone();
        let policy_probe = self.policy.clone();
        if no_p2p {
            println!("  [DIAG] VNET_NO_P2P=1 -> P2P probing disabled");
        } else {
        self.threads_alive.fetch_add(1, Ordering::Relaxed);
        thread::spawn(move || {
            let mut count = 0u64;
            println!("  [PROBE-THREAD] started for peer {}", my_id_for_status);
            // 多候选地址：relay 观察到的 + 对端 STUN 通告的 + 对端 IPv6
            let mut v6_candidate: Option<std::net::SocketAddr> = None;
            let mut candidates: Vec<std::net::SocketAddr> = Vec::new();
            let mut last_report = std::time::Instant::now();
            // 数据面停滞看门狗状态
            let mut st_w_acked: u64 = 0;
            let mut st_w_ack_at = std::time::Instant::now();
            let mut last_probe_replies: u64 = 0;
            let mut probe_stale_at = std::time::Instant::now();
            let mut netstat_last_sense = std::time::Instant::now();
            let netstat_local: Arc<std::sync::Mutex<crate::netstatus::NetStatus>> = net_status_for_status.clone();
            // O(shadow)：ARQ (sent, acked) 快照滑窗（10s @1s/格），窗口 ACK 率的证据源
            let mut st_w_hist: std::collections::VecDeque<(u64, u64)> =
                std::collections::VecDeque::new();

            // 独立 IPv6 socket —— 必须！IPv4 socket(0.0.0.0) 无法向 IPv6 地址发包
            let v6_sock = listen_sock_v6.clone().or_else(|| {
                UdpSocket::bind("[::]:0").ok().map(std::sync::Arc::new)
            }).map(|s| {
                s.set_nonblocking(true).ok();
                s
            });
            if let Some(ref s) = v6_sock {
                s.set_nonblocking(true).ok();
                println!("  [P2P] IPv6 probe socket: {}",
                    s.local_addr().map(|a| a.to_string()).unwrap_or_default());
            }
            let v6_for_p2p = v6_sock.clone();

            // 独立 IPv6 接收线程：不能放在 1s 一轮的探测循环里，否则数据最多压 1 秒
            if let Some(ref sock) = v6_sock {
                let rx_sock = sock.clone();
                let rx_path = path.clone();
                let rx_peer = p2p_peer.clone();
                let rx_p2p = p2p.clone();
                let rx_run = running.clone();
                let rx_q = rx_queue_for_probe.clone();
                let rx_last = last_reply_for_v6.clone();
                let rx_sec = probe_relay.clone();
                let rx_pipes = pipes_probe.clone();
                let rx_policy = policy_probe.clone();
                let rx_switches = path_switches_net.clone();
                thread::spawn(move || {
                    let mut buf = [0u8; 65536];
                    let mut rx_tick_at = std::time::Instant::now();
                    while rx_run.load(Ordering::Relaxed) {
                        match rx_sock.recv_from(&mut buf) {
                            Ok((n, from)) => {
                                if let Some((ptype, nonce, ts)) = crate::probe::parse_probe_full(&buf[..n]) {
                                    if ptype == crate::probe::PROBE_TYPE_REQUEST {
                                        let reply = rx_sec.sign_probe(&crate::probe::build_probe_reply(nonce, ts));
                                        let _ = rx_sock.send_to(&reply, from);
                                    } else {
                                        let rtt = crate::probe::rtt_us_from(ts);
                                        *rx_last.lock().unwrap() = std::time::Instant::now();
                                        // O(shadow)：v6 探测回包 → P2pV6 观察（双向证据 + RTT 轨迹）
                                        {
                                            let mut ps = rx_pipes.lock().unwrap();
                                            let p6 = &mut ps[index_of(PipeKind::P2pV6)];
                                            p6.o_reply_rx += 1;
                                            p6.push_rtt((rtt + 500) / 1000);
                                            p6.mark_verified();
                                            p6.update_derived(&rx_policy);
                                        }
                                        // ARQ tick：通道若落在本线程的 rx_sock 上，必须有人重传
                                        if rx_tick_at.elapsed() >= Duration::from_millis(50) {
                                            rx_tick_at = std::time::Instant::now();
                                            if let Some(ch) = rx_p2p.lock().unwrap().active_channel() {
                                                let mut st = ch.stream.lock().unwrap();
                                                let (s, a, r) = st.stats();
                                                let inf = st.inflight_count();
                                                if inf > 0 {
                                                    println!("  [TICK] sent={} acked={} retr={} inflight={}", s, a, r, inf);
                                                }
                                                st.tick();
                                            }
                                        }
                                        *rx_peer.lock().unwrap() = Some(from);
                                        {
                                            // 与 RDV/打洞分支同理：通道已存在且对端未变时绝不重建。
                                            // 这里每收到一个探测回复就会触发，无条件重建 = ARQ 序号
                                            // 每秒归零，服务端把新包全判为重复丢弃——实测 3/20 成功。
                                            let need_rx = match rx_p2p.lock().unwrap().active_channel() {
                                                Some(ch) => chan_rebuild_needed(ch, from, true),
                                                None => true,
                                            };
                                            if need_rx {
                                                rx_p2p.lock().unwrap().upsert(P2pChannel::new(
                                                    rx_sock.clone(), from, true, rx_sec.crypto_arc(), true));
                                            }
                                        }
                                        if !rx_path.lock().unwrap().is_direct() {
                                            println!("  [P2P] IPv6 direct -> {} (rtt={:.2}ms)", from, rtt as f64 / 1000.0);
                                            apply_decision(&rx_pipes, &rx_policy, &rx_path, &rx_p2p, &rx_switches);
                                        }
                                    }
                                } else if let Some(ch) = rx_p2p.lock().unwrap().active_channel() {
                                    // 通道守卫：帧到达的 socket 必须与通道 socket 一致（防跨流污染）
                                    if std::sync::Arc::ptr_eq(&ch.socket, &rx_sock) {
                                        // ARQ：走可靠流按序交付（v6 通道同样适用）
                                        {
                                        use std::sync::atomic::Ordering as DO;
                                        let rn = DIAG_RX.fetch_add(1, DO::Relaxed);
                                        if n > 1300 || rn < 20 {
                                            println!("  [DIAG] RX#{}: {}B t={}",
                                                rn, n, std::time::SystemTime::now()
                                                    .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() % 100000);
                                        }
                                    }
                                    let chunks = ch.stream.lock().unwrap().on_packet(&buf[..n]);
                                        for d in chunks { rx_q.lock().unwrap().push_p2p_frame(d); }
                                    } else {
                                        drop_ghost("v6-probe-rx");
                                    }
                                }
                            }
                            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                thread::sleep(Duration::from_millis(1));
                            }
                            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                                thread::sleep(Duration::from_millis(1));
                            }
                            Err(_) => thread::sleep(Duration::from_millis(5)),
                        }
                    }
                });
            }

            while running.load(Ordering::Relaxed) {
                count += 1;

                // ── G3 网络变化检测：出口 IP 变了就重新探测 ──
                if count % 5 == 0 {
                    let cur = get_my_local_ipv4();
                    // O(shadow)：默认路由接口计费性 → Relay 管道 o_cost（简单版见 probe_default_if_cost）
                    {
                        let c = probe_default_if_cost();
                        let mut ps = pipes_probe.lock().unwrap();
                        ps[index_of(PipeKind::Relay)].o_cost = c;
                    }
                    let mut known = local_ip_watch.lock().unwrap();
                    if *known != cur {
                        let old = *known;
                        *known = cur;
                        // 首次记录不算变化
                        if old.is_some() {
                            println!("  [NET] Local egress changed {:?} -> {:?}, re-probing",
                                old, cur);
                            candidates.clear();
                            // O(shadow)：出口变了 → 旧地址上的直连验证全部作废
                            {
                                let mut ps = pipes_probe.lock().unwrap();
                                for k in [PipeKind::P2pV4, PipeKind::P2pV6] {
                                    let pp = &mut ps[index_of(k)];
                                    pp.mark_failed();
                                    pp.update_derived(&policy_probe);
                                }
                            }
                            *switch_score_net.lock().unwrap() = 0;
                            // 网络变了，旧 P2P 地址大概率失效 -> 回中继等重新打通
                            apply_decision(&pipes_probe, &policy_probe, &path, &p2p, &path_switches_net);
                            p2p.lock().unwrap().active = None;
                        }
                    }
                }

                // 每 10 轮刷新候选列表
                if candidates.is_empty() || count % 10 == 0 {
                    if let Some((relay_addr, ipv6, public_v4)) = probe_relay.query_peer_info(target_id) {
                    // 记录对端公告的**监听**端口，供过滤类型判定使用。
                    // 注意：只能用 public_v4（announce 出去的监听映射），
                    // 绝不能用 relay_addr —— 那是对端中继 socket 的端口，
                    // 拿它当基准会把所有来自监听端口的包误判成"证据"（实测假阳性）。
                    if let Some(a) = public_v4 {
                        note_peer_listen_port(a.port());
                    }
                        let mut list = vec![relay_addr];
                        // 对端 STUN 通告的出口 IP（可能不同于 relay 观察到的）
                        if let Some(pv4) = public_v4 {
                            if pv4 != relay_addr {
                                list.push(pv4);
                                if count <= 10 {
                                    println!("  [P2P] Peer {} extra egress={}", target_id, pv4);
                                }
                            }
                        }
                        if count <= 10 {
                            println!("  [P2P] Peer {} relay={} candidates={}", target_id, relay_addr, list.len());
                            if let Some(ref v6) = ipv6 {
                                println!("  [P2P] Peer {} IPv6={}", target_id, v6);
                            }
                        }
                        candidates = list;
                        // 记录对端 IPv6（单列，避免混入 IPv4 socket 发送路径）
                        v6_candidate = ipv6.filter(|a| a.is_ipv6() && !a.ip().is_loopback());
                    }
                }

                // ── IPv4 候选：走 relay socket（保持 NAT 映射一致）──
                let pkt = probe_relay.sign_probe(&crate::probe::build_probe_packet(count));
                for cand in &candidates {
                    if cand.is_ipv4() {
                        probe_relay.send_raw_to(&pkt, *cand);
                    }
                }

                // ── IPv6 候选：只负责发探测（收包由上面的独立 v6 接收线程负责）──
                if let (Some(ref sock), Some(target)) = (&v6_sock, v6_candidate) {
                    match sock.send_to(&pkt, target) {
                        Ok(_) => { V6_SEND_OK.fetch_add(1, Ordering::Relaxed); }
                        Err(e) => {
                            let n = V6_SEND_FAIL.fetch_add(1, Ordering::Relaxed);
                            // 前 3 次打日志（之后静默只计数，避免刷屏）
                            if n < 3 {
                                eprintln!("  [P2P-V6] send_to {} failed (#{}): {:#}", target, n + 1, e);
                            }
                        }
                    }
                }

                // 定期报告（控制台 30 秒一次，状态文件 1 秒一次）
                if last_report.elapsed() >= Duration::from_secs(30) {
                    let p = path.lock().unwrap().name().to_string();
                    println!("  [STAT] Path={}, rounds={}, candidates={}, v6={}",
                        p, count, candidates.len(), v6_candidate.is_some());
                    last_report = std::time::Instant::now();
                }
                {
                    let p = path.lock().unwrap().name().to_string();
                    let peer = p2p_peer.lock().unwrap()
                        .map(|a| a.to_string()).unwrap_or_else(|| "-".into());
                    // ── 数据面停滞看门狗 ──
                    // path=P2P 但 ARQ 无 ACK 进展超 3 秒（对端收不到我们的包）→
                    // 记失败证据 + 决策降级（证据门取代旧的 60s 时间冷却）。没有它，
                    // 死通道上的数据永不回退（实测：path=P2P、服务端零到达、上层一直超时）。
                    {
                        let direct_now = path.lock().unwrap().is_direct();
                        if direct_now {
                            let maybe = {
                                let g = p2p.lock().unwrap();
                                g.active_channel().map(|ch| (ch.is_ipv6, ch.stream.lock().unwrap().stats()))
                            };
                            if let Some((ch_v6, (sent, acked, retr))) = maybe {
                                // O(shadow)：窗口 ACK 率（10s 滑窗增量比）→ 当前通道对应管道
                                {
                                    st_w_hist.push_back((sent, acked));
                                    while st_w_hist.len() > 10 {
                                        st_w_hist.pop_front();
                                    }
                                    if st_w_hist.len() >= 2 {
                                        let (s0, a0) = *st_w_hist.front().unwrap();
                                        if sent > s0 {
                                            let ratio =
                                                (acked - a0) as f32 / (sent - s0) as f32;
                                            let fam = if ch_v6 { PipeKind::P2pV6 } else { PipeKind::P2pV4 };
                                            let mut ps = pipes_probe.lock().unwrap();
                                            let pp = &mut ps[index_of(fam)];
                                            pp.o_ack_ratio = ratio.clamp(0.0, 1.0);
                                            pp.update_derived(&policy_probe);
                                        }
                                    }
                                }
                                if acked > st_w_acked {
                                    st_w_acked = acked;
                                    st_w_ack_at = std::time::Instant::now();
                                } else if sent > acked
                                    && st_w_ack_at.elapsed() > Duration::from_secs(3)
                                {
                                    println!("  [WD] P2P stalled: sent={} acked={} retr={} -> downgrade by evidence",
                                        sent, acked, retr);
                                    // O(shadow)：ARQ 停滞 3s → 该管道记失败证据
                                    {
                                        let fam = if ch_v6 { PipeKind::P2pV6 } else { PipeKind::P2pV4 };
                                        let mut ps = pipes_probe.lock().unwrap();
                                        let pp = &mut ps[index_of(fam)];
                                        pp.mark_failed();
                                        pp.update_derived(&policy_probe);
                                    }
                                    // 停滞 3s = 通道已死，就地清（原语义；决策体不再代清）
                                    p2p.lock().unwrap().active = None;
                                    apply_decision(&pipes_probe, &policy_probe, &path, &p2p, &path_switches_net);
                                }
                            }
                        }
                        // ── RC2 fix: probe health watchdog (independent of data flow) ──
                        // Dead P2P channel with no app data in flight: sent==acked so the
                        // ARQ watchdog above never fires. Detect via probe reply stagnation.
                        {
                            let cur_replies = probe_req_for_status.load(std::sync::atomic::Ordering::Relaxed)
                                + probe_reply_for_status.load(std::sync::atomic::Ordering::Relaxed);
                            if cur_replies == last_probe_replies && cur_replies > 0 && count > 10 {
                                if probe_stale_at.elapsed() > Duration::from_secs(15) {
                                    let direct_now = path.lock().unwrap().is_direct();
                                    if direct_now {
                                        println!("  [WD] probe health: no reply growth {}s (replies={}) -> downgrade",
                                            probe_stale_at.elapsed().as_secs(), cur_replies);
                                        let fam = PipeKind::P2pV6; // v6 P2P is the dominant direct path
                                        let mut ps = pipes_probe.lock().unwrap();
                                        let pp = &mut ps[index_of(fam)];
                                        pp.mark_failed();
                                        pp.update_derived(&policy_probe);
                                        drop(ps);
                                        p2p.lock().unwrap().active = None;
                                        apply_decision(&pipes_probe, &policy_probe, &path, &p2p, &path_switches_net);
                                        probe_stale_at = std::time::Instant::now();
                                    }
                                }
                            } else if cur_replies != last_probe_replies {
                                last_probe_replies = cur_replies;
                                probe_stale_at = std::time::Instant::now();
                            }
                        }
                        // ── NetStatus continuous sensing (every 15s) ──
                        if netstat_last_sense.elapsed() >= Duration::from_secs(1) {
                            netstat_last_sense = std::time::Instant::now();
                            let mut lns = netstat_local.lock().unwrap();
                            let old_v6: Option<std::net::SocketAddr> = lns.ipv6;
                            let new_v6: Option<std::net::SocketAddr> = get_my_ipv6();
                            let changed = new_v6 != old_v6;
                            let (new_if, new_cost) = probe_default_if_status();
                            let if_changed = new_if != lns.if_type || new_cost != lns.if_cost;
                            let changed = changed || if_changed;
                            if changed {
                                lns.version += 1;
                                lns.ipv6 = new_v6;
                                lns.if_type = new_if;
                                lns.if_cost = new_cost;
                                lns.sensed_at = std::time::Instant::now();
                                lns.nat_source = crate::netstatus::Source::Measured;
                                println!("  [NETSTAT] v{} changed: v6={:?} if={:?} cost={}",
                                    lns.version, lns.ipv6, lns.if_type, lns.if_cost);
                                // announce_extra takes &[SocketAddr]; NetStatus extra goes via v6 announce string
                                // For now, just log the state change; announce integration is in relay.rs
                                println!("  [NETSTAT] v{} changed: v6={:?} if={:?} cost={}",
                                    lns.version, lns.ipv6, lns.if_type, lns.if_cost);
                                // ── 网络变化 → 秒级响应：re-register + re-announce + 重建通道 ──
                                // 1. STUN 探测新出口
                                if let Ok(pub4) = crate::stun::query_stun("stun.chat.bilibili.com:3478", 0) {
                                    let pub4_str = pub4.to_string();
                                    let _ = probe_relay.announce_ipv4(&pub4_str);
                                    println!("  [NETSTAT] re-announced v4={}", pub4_str);
                                }
                                // 2. v6 re-announce
                                if let Some(v6) = lns.ipv6 {
                                    if !v6.ip().is_unspecified() {
                                        let v6_str = v6.to_string();
                                        let _ = probe_relay.announce_ipv6(&v6_str);
                                        println!("  [NETSTAT] re-announced v6={}", v6_str);
                                    }
                                }
                                // 3. 通道重建（清旧通道让下轮 probe 重建）
                                p2p.lock().unwrap().active = None;
                                println!("  [NETSTAT] channel cleared for rebuild");
                                let ns_str = lns.to_announce_extra();
                                let _ = probe_relay.announce_netstatus(ns_str.trim());
                            } else {
                                lns.sensed_at = std::time::Instant::now();
                            }
                        }

                        // ── RC2b: data-delivery watchdog (probe alive but data dead) ──
                        // Scenario: small probe packets flow (56B) but ARQ data frames don't
                        // (fragmentation, CGN QoS on larger packets, corrupted stream state).
                        // Evidence: sent > 0 but delivered/ACKed frozen for 5s while probes grow.
                        {
                            let (sent_now, acked_now, _) = {
                                let g = p2p.lock().unwrap();
                                match g.active_channel() {
                                    Some(ch) => {
                                        let st = ch.stream.lock().unwrap();
                                        let s = st.stats();
                                        drop(st); drop(g);
                                        s
                                    }
                                    None => (0, 0, 0),
                                }
                            };
                            if sent_now > acked_now && acked_now == st_w_acked {
                                if st_w_ack_at.elapsed() > Duration::from_secs(5) {
                                    println!("  [WD] data delivery frozen: sent={} acked={} (probes alive) -> rebuild channel",
                                        sent_now, acked_now);
                                    // Full channel teardown: ARQ stream state is suspect
                                    p2p.lock().unwrap().active = None;
                                    // Mark pipe failed to force relay via evidence gate
                                    {
                                        let fam = PipeKind::P2pV6;
                                        let mut ps = pipes_probe.lock().unwrap();
                                        let pp = &mut ps[index_of(fam)];
                                        pp.mark_failed();
                                        pp.update_derived(&policy_probe);
                                    }
                                    apply_decision(&pipes_probe, &policy_probe, &path, &p2p, &path_switches_net);
                                    // Reset tracking so we don't immediately re-trigger
                                    st_w_acked = 0;
                                    st_w_ack_at = std::time::Instant::now();
                                }
                            } else if acked_now > st_w_acked {
                                st_w_acked = acked_now;
                                st_w_ack_at = std::time::Instant::now();
                            }
                        }
                    }
                    let (pipe_v4_str, pipe_v6_str, relay_cost_str) = {
                        let ps = pipes_probe.lock().unwrap();
                        let f = |p: &PathPipe| {
                            format!(
                                "v={} req={} rep={} fr={} ack={:.2} rtt={:?}",
                                p.o_verified_bidi,
                                p.o_req_rx,
                                p.o_reply_rx,
                                p.o_failure_run,
                                p.o_ack_ratio,
                                p.rtt_evidence_ms()
                            )
                        };
                        (
                            f(&ps[index_of(PipeKind::P2pV4)]),
                            f(&ps[index_of(PipeKind::P2pV6)]),
                            ps[index_of(PipeKind::Relay)].o_cost.to_string(),
                        )
                    };
                    let mut fields: Vec<(String, String)> = vec![
                        ("role", "client".into()),
                        ("my_peer_id", my_id_for_status.to_string()),
                        ("target_peer_id", target_id.to_string()),
                        ("path", p),
                        ("p2p_peer", peer),
                        ("probe_rounds", count.to_string()),
                        ("candidates", candidates.len().to_string()),
                        ("path_switches", path_switches_for_status.lock().unwrap().to_string()),
                        // 死判定 + 换网源地址（与 keepalive 版同键）
                        ("dead", dead_for_status.load(Ordering::Relaxed).to_string()),
                        ("dead_reason", dead_reason_for_status.lock().unwrap().clone()),
                        ("relay_silent_ms", relay_for_status2.relay_silent_for()
                            .map(|d| d.as_millis() as u64).unwrap_or(0).to_string()),
                        ("relay_src", last_src_for_status.lock().unwrap()
                            .map(|a| a.to_string()).unwrap_or_else(|| "-".to_string())),
                        ("ipv6_candidate", v6_candidate.is_some().to_string()),
                        ("encrypted", enc_for_status.to_string()),
                        ("last_rtt_ms", last_rtt_for_status.lock().unwrap().clone()),
                        ("inbound_fw", crate::fwcheck::current().as_str().to_string()),
                        ("filtering", filter_evidence().to_string()),
                        ("listen_rx", listen_rx_for_status.load(std::sync::atomic::Ordering::Relaxed).to_string()),
                        ("probe_req_rx", probe_req_for_status.load(std::sync::atomic::Ordering::Relaxed).to_string()),
                        ("probe_reply_rx", probe_reply_for_status.load(std::sync::atomic::Ordering::Relaxed).to_string()),
                        ("probe_verify_fail", probe_fail_for_status.load(std::sync::atomic::Ordering::Relaxed).to_string()),
                        ("pipe_v4", pipe_v4_str),
                        ("pipe_v6", pipe_v6_str),
                        ("relay_cost", relay_cost_str),
                        // 宿主诊断：stop() 次数（>0 且递增 = 宿主自己停的）+ 本地代理端口
                        ("stop_calls", stop_calls_for_status.load(std::sync::atomic::Ordering::Relaxed).to_string()),
                        ("local_port", local_port_for_status.load(std::sync::atomic::Ordering::Relaxed).to_string()),
                        // RTT 倒挂防御的 relay 基线（0=未知）：DSH F2 排查就缺这个数
                        ("relay_rtt_ms", relay_rtt_ms().unwrap_or(0).to_string()),
                    ]
                    .into_iter()
                    .map(|(k, v)| (k.to_string(), v))
                    .collect();
                    // rendezvous（P2P）实际监听口：宿主端口对账用（0=未绑定/NO_P2P）
                    let p2p_port = p2p_sock_for_status
                        .as_ref()
                        .and_then(|s| s.local_addr().ok())
                        .map(|a| a.port())
                        .unwrap_or(0);
                    fields.push(("p2p_port".into(), p2p_port.to_string()));
                    // multi-forward：每条转发一行，key=实际 local_port（H.2.1 约定）
                    // 2026-11-12：格式与 keepalive 版统一为 `<target>:<accepted>/<active> <listening>`
                    let fwd_list = forwards_for_status.list();
                    fields.push(("forwards".into(), fwd_list.len().to_string()));
                    for f in &fwd_list {
                        fields.push((
                            format!("forward.{}", f.local_port),
                            format!("{}:{}/{} {}", f.target_port, f.accepted, f.active, f.listening),
                        ));
                    }
                    // forward_targeted 观测（与 keepalive 版同键，避免格式跳变）
                    fields.push(("mf_opened".into(), mf_opened_for_status.load(Ordering::Relaxed).to_string()));
                    fields.push(("mf_last_open".into(), mf_last_info_for_status.lock().unwrap().clone()));
                    // IPv6 探测发包成败（req>0 rep=0 归因）
                    fields.push(("v6_send_ok".into(), V6_SEND_OK.load(Ordering::Relaxed).to_string()));
                    fields.push(("v6_send_fail".into(), V6_SEND_FAIL.load(Ordering::Relaxed).to_string()));
                    {
                        let (n, first) = local_v6_snapshot();
                        fields.push(("v6_local_count".into(), n.to_string()));
                        fields.push(("v6_local_first".into(), first));
                    }
                    // ARQ 可观测（RDP 指针卡顿诊断）
                    {
                        let raq = arq_for_status.lock().unwrap();
                        fields.push(("arq_retransmits".into(), raq.retransmit_count.to_string()));
                        fields.push(("arq_window_full".into(), raq.window_full_count.to_string()));
                        fields.push(("arq_stall_max_ms".into(), raq.max_stall_ms.to_string()));
                    }
                    let strategy = {
                        let ns = net_status_for_status.clone();
                        let rs = remote_ns_for_status.clone();
                        let l = ns.lock().unwrap().clone();
                        let r = rs.lock().unwrap().clone();
                        crate::netstatus::NetStatus::strategy(&l, &r).as_str().to_string()
                    };
                    fields.push(("strategy".into(), strategy));
                    fields.push((
                        "threads_alive".into(),
                        threads_alive_for_status.load(std::sync::atomic::Ordering::Relaxed).to_string(),
                    ));
                    fields.push(("updated_at".into(), format!("{:?}",
                            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default().as_secs())));
                    write_status_kv(&status_file_path_for("client", my_id_for_status), &fields);
                }

                thread::sleep(Duration::from_millis(punch_cadence_ms(count)));
            }
        });
        }

        // ── Rendezvous IPv6 监听 socket 接收线程 ──
        // PC→笔记本 的 IPv6 方向通（家宽只拦入站反方向），对端会往 [我方v6]:port 发。
        if let Some(ref ls6) = self.listen_sock_v6 {
            let ls6 = ls6.clone();
            let r_relay = self.relay.clone();
            let r_path = self.path.clone();
            let r_p2p = self.p2p.clone();
            let r_peer = self.p2p_peer.clone();
            let r_hub = self.hub.clone();
            let r_run = self.running.clone();
            let r_last = self.last_p2p_reply.clone();
            let r_target = self.target_peer_id;
            let r6_v6_pub = self.announced_v6.clone();
            let r6_probe_req = self.probe_req_rx.clone();
            let r6_probe_reply = self.probe_reply_rx.clone();
            let r6_pipes = self.pipes.clone();
            let r6_policy = self.policy.clone();
            let r6_switches = self.path_switches.clone();
            thread::spawn(move || {
                let mut buf = [0u8; 65536];
                let mut ka = std::time::Instant::now();
                let mut kn: u64 = 0;
                let mut rx_tick_at = std::time::Instant::now();
                let r_p2p_tick6 = r_p2p.clone();
                let mut tick6_at = std::time::Instant::now();
                let mut r6_verify_since: Option<std::time::Instant> = None;
                while r_run.load(Ordering::Relaxed) {
                    match ls6.recv_from(&mut buf) {
                        Ok((n, from)) => {
                            {
                                use std::sync::atomic::{AtomicU64, Ordering as O2};
                                static R6: AtomicU64 = AtomicU64::new(0);
                                let k = R6.fetch_add(1, O2::Relaxed);
                                if k < 8 || k % 30 == 0 {
                                    println!("  [RDV6-IN] len={} from={}", n, from);
                                }
                            }
                            if let Some(body) = r_relay.verify_probe(&buf[..n]) {
                                if let Some((ptype, nonce_p, ts)) =
                                    crate::probe::parse_probe_full(body)
                                {
                                    if ptype == crate::probe::PROBE_TYPE_REQUEST {
                                        // 过滤类型证据（同上，用公告端口）
                                        r6_probe_req.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                        // O(shadow)：v6 敲门包计数 → P2pV6 观察
                                        {
                                            let mut ps = r6_pipes.lock().unwrap();
                                            let p6 = &mut ps[index_of(PipeKind::P2pV6)];
                                            p6.o_req_rx += 1;
                                            p6.update_derived(&r6_policy);
                                        }
                                        let kp6 = peer_listen_port_known();
                                        if kp6 != 0 && from.port() != kp6 {
                                            note_filter_evidence_ip_based();
                                        }
                                        let reply = r_relay.sign_probe(
                                            &crate::probe::build_probe_reply(nonce_p, ts));
                                        let _ = ls6.send_to(&reply, from);
                                        // 对端能到达我们的监听口 = 这个四元组就是可用通道。
                                        // 家宽拦入站时「对端→我」往往先通（我方发过去的探测被拦），只等 REPLY 会永远差半步；
                                        // 收到合法签名（上方 verify_probe 已验）的 REQUEST 即建通道，回包走同一四元组。
                                        // 同 IP 不重建：对端打洞引擎从几十个扫描端口敲门，
                                        // 全地址比较会让通道每秒重建（ARQ 归零 + verify 字节
                                        // 在对端触发 upstream connect 风暴）。同 IP 的扫描敲门只回包。
                                        // REQUEST 敲门只证明「对端→我」：通道以未验证身份入槽，
                                        // verify ACK 到达（tick6 块 Pass）才置 verified 并承载业务。
                                        let need_req6 = match r_p2p.lock().unwrap().active_channel() {
                                            Some(ch) => chan_rebuild_needed(ch, from, false),
                                            None => true,
                                        };
                                        if need_req6 {
                                            let mut ch = P2pChannel::new(
                                                ls6.clone(), from, true, r_relay.crypto_arc(), false);
                                            ch.verify_since = Some(std::time::Instant::now());
                                            println!("  [EXP1] RDV6 verify sent: from={:?} to_peer={:?} via_sock={:?}",
                                                from, from, ls6.local_addr().map(|a|a.to_string()));
                                            let _ = ch.stream.lock().unwrap().send(P2P_VERIFY_TAG);
                                            r_p2p.lock().unwrap().upsert(ch);
                                            r6_verify_since = Some(std::time::Instant::now());
                                            println!("  [RDV6] channel created (verifying) from {}", from);
                                        }
                                        *r_last.lock().unwrap() = std::time::Instant::now();
                                        *r_peer.lock().unwrap() = Some(from);
                                        // path 切换延后到 verify 决议（tick6 块）
                                    } else {
                                        r6_probe_reply
                                            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                        // O(shadow)：v6 探测回包 → P2pV6 观察（双向证据 + RTT 轨迹）
                                        {
                                            let rtt_ms = crate::probe::rtt_us_from(ts) / 1000;
                                            let mut ps = r6_pipes.lock().unwrap();
                                            let p6 = &mut ps[index_of(PipeKind::P2pV6)];
                                            p6.o_reply_rx += 1;
                                            p6.push_rtt(rtt_ms);
                                            p6.mark_verified();
                                            p6.update_derived(&r6_policy);
                                        }
                                        *r_last.lock().unwrap() = std::time::Instant::now();
                                        *r_peer.lock().unwrap() = Some(from);
                                        let need_new6 = match r_p2p.lock().unwrap().active_channel() {
                                            Some(ch) => chan_rebuild_needed(ch, from, true),
                                            None => true,
                                        };
                                        if need_new6 {
                                            let id = r_p2p.lock().unwrap().upsert(P2pChannel::new(
                                                ls6.clone(),
                                                from,
                                                true,
                                                r_relay.crypto_arc(),
                                                true,
                                            ));
                                            r_p2p.lock().unwrap().promote_verified(id);
                                        }
                                        // IPv6 优先：无 NAT、通常少一跳（实测 EasyTier 走 udp6 是 46.7ms，
                                        // 我们走 IPv4 是 72ms）。只升不降，避免和 v4 互相抢占。
                                        apply_decision(&r6_pipes, &r6_policy, &r_path, &r_p2p, &r6_switches);
                                    }
                                }
                            } else {
                                // 按「socket+来源地址」路由到匹配通道，不再要求 active。
                                // 旧逻辑要求 active_channel() 而 active 只在 verify PASS 后设置，
                                // verify 帧到达时通道尚未 active → 帧被静默丢弃 → ACK 永不产生
                                // → verify 永远失败 → [RDV6] verifying 死循环（实测跨网复现）。
                                let handled = {
                                    let g = r_p2p.lock().unwrap();
                                    g.find(&ls6, from).map(|ch| {
                                        let verified = ch.verified.get();
                                        let chunks = ch.stream.lock().unwrap().on_packet(&buf[..n]);
                                        (verified, chunks)
                                    })
                                };
                                match handled {
                                    Some((verified, chunks)) => {
                                        for d in chunks {
                                            if d.as_slice() == P2P_VERIFY_TAG {
                                                println!("  [RDV6] verify tag ACKed from {}", from);
                                                continue; // verify 探测字节不进应用流
                                            }
                                            // 未验证通道的其余载荷同样不进应用流（防污染）
                                            if verified { r_hub.lock().unwrap().push_p2p_frame(d); }
                                            else { drop_ghost("rdv6-unverified"); }
                                        }
                                    }
                                    None => drop_ghost("rdv6-nochan"),
                                }
                            }
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(1));
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                            thread::sleep(Duration::from_millis(1));
                        }
                        Err(_) => thread::sleep(Duration::from_millis(5)),
                    }
                    // ARQ 重传检查（通道可能落在本线程的 ls6 上，必须有人 tick）
                    if tick6_at.elapsed() >= Duration::from_millis(50) {
                        tick6_at = std::time::Instant::now();
                        // verify_channel 决议：ACK 到 → 置通道 verified；2s 无 ACK → 丢通道。
                        // 黑盒回归修复：决议不再依赖 path 是否 direct——path 可已被其它
                        // socket 的证据翻成 direct，而槽内通道仍是本验证对象；按验证窗口判。
                        // 槽内通道若已被更强证据顶替成 verified，直接视为通过（清时钟）。
                        enum VRes { None, Pass, Fail }
                        let vres = {
                            let mut g = r_p2p_tick6.lock().unwrap();
                            let mut v = VRes::None;
                            // 遍历所有未验证通道（不只 active——RDV6 通道刚创建时 active 可能是 None）
                            let unverified: Vec<u64> = g.channels.values()
                                .filter(|c| !c.verified.get() && c.verify_since.is_some())
                                .map(|c| c.id)
                                .collect();
                            for cid in unverified {
                                // 先提取需要的数据（不可变借用）
                                let (verified_flag, peer_addr, acked) = {
                                    if let Some(ch) = g.channels.get(&cid) {
                                        let mut st = ch.stream.lock().unwrap();
                                        st.tick();
                                        let (_, acked, _) = st.stats();
                                        (ch.verified.get(), ch.peer_addr, acked)
                                    } else { continue; }
                                };
                                // 释放不可变借用后再修改
                                if let Some(t) = g.channels.get(&cid).and_then(|c| c.verify_since) {
                                    if acked > 0 {
                                        println!("  [EXP2] verify PASS via acked={}: ch.peer={:?}", acked, peer_addr);
                                        if let Some(ch) = g.channels.get(&cid) {
                                            ch.verified.set(true);
                                        }
                                        g.active = Some(cid);
                                        v = VRes::Pass;
                                    } else if t.elapsed() > Duration::from_secs(2) {
                                        println!("  [EXP2] verify FAIL: ch.peer={:?} acked={}", peer_addr, acked);
                                        v = VRes::Fail;
                                    }
                                }
                            }
                            v
                        };
                        match vres {
                            VRes::Pass => {
                                r6_verify_since = None;
                                // 通道级验证位：verify ACK 到达，通道方可承载业务
                                {
                                    let mut g = r_p2p_tick6.lock().unwrap();
                                    if let Some(ch) = g.active_channel() {
                                        ch.verified.set(true);
                                    }
                                }
                                // O(shadow)：verify 决议 Pass → P2pV6 双向验证过 + 清失败游程
                                {
                                    let mut ps = r6_pipes.lock().unwrap();
                                    let p6 = &mut ps[index_of(PipeKind::P2pV6)];
                                    p6.mark_verified();
                                    p6.update_derived(&r6_policy);
                                }
                                apply_decision(&r6_pipes, &r6_policy, &r_path, &r_p2p, &r6_switches);
                            }
                            VRes::Fail => {
                                r6_verify_since = None;
                                // O(shadow)：verify 决议 Fail → P2pV6 失败游程 +1 + 失去验证
                                {
                                    let mut ps = r6_pipes.lock().unwrap();
                                    let p6 = &mut ps[index_of(PipeKind::P2pV6)];
                                    p6.mark_failed();
                                    p6.update_derived(&r6_policy);
                                }
                                r_p2p_tick6.lock().unwrap().active = None;
                                println!("  [RDV6] verify failed (no ACK in 2s), channel dropped");
                            }
                            VRes::None => {}
                        }
                    }

                    // IPv6 出站保活：建立/维持 [::]:port 的映射与过滤放行
                    if ka.elapsed() >= Duration::from_secs(5) {
                        ka = std::time::Instant::now();
                        kn += 1;
                        let pkt = r_relay.sign_probe(&crate::probe::build_probe_packet(kn));
                        if let Some((_r, ipv6, _a)) = r_relay.query_peer_info(r_target) {
                            if let Some(v6) = ipv6 {
                                if v6.is_ipv6() {
                                    // 源地址对齐：多 v6 地址（隐私扩展临时地址）时，OS 对
                                    // 该对端实际使用的源地址可能与公告的不同。家宽状态防火墙
                                    // 按五元组放行，源地址不一致 → 对端回的包进不来/我们的包
                                    // 被对端路由器丢弃（实测症状：path=P2P 但数据零到达）。
                                    // 这里用临时 socket connect 求出真实源地址，变了就重公告。
                                    // UDP connect 锁定（DSH 建议）：connected socket 的源地址
                                    // 由 OS 在 connect 时固定，send/recv 全走同一路径；公告与之对齐。
                                    if ls6.peer_addr().map(|p| p != v6).unwrap_or(true) {
                                        let _ = ls6.connect(v6);
                                        println!("  [RDV6] ls6 connected -> {}", v6);
                                    }
                                    if let Ok(la) = ls6.local_addr() {
                                        let ip = get_my_ipv6().map(|a| a.ip()); if ip.is_none() { continue; } let want = std::net::SocketAddr::new(ip.unwrap(), la.port());
                                        let cur = *r6_v6_pub.lock().unwrap();
                                        if cur != Some(want) {
                                            let s = want.to_string();
                                            let _ = r_relay.announce_ipv6(&s);
                                            *r6_v6_pub.lock().unwrap() = Some(want);
                                            println!("  [RDV6] IPv6 announce locked -> {}", s);
                                        }
                                    }
                                    let _ = ls6.send_to(&pkt, v6);
                                }
                            }
                        }
                    }
                }
            });
        }

        // ── Rendezvous 监听 socket 接收线程 ──
        // 对端会主动连到我们公告的公网映射地址，落到这个 socket 上。
        // 必须有人读它，否则对端的敲门包被内核丢掉。
        if let Some(ref ls) = self.listen_sock {
            let ls = ls.clone();
            let r_lrx = self.listen_rx.clone();
            let r_probe_req = self.probe_req_rx.clone();
            let r4_pipes = self.pipes.clone();
            let r4_policy = self.policy.clone();
            let r4_switches = self.path_switches.clone();
            let r_probe_reply = self.probe_reply_rx.clone();
            let r_listen_pub = self.listen_pub.clone();
            let r_p2p_tick = self.p2p.clone();
            let mut tick_at = std::time::Instant::now();
            let r_p2p_tick6 = self.p2p.clone();
            let mut tick6_at = std::time::Instant::now();
            let r_ka_target: Arc<Mutex<Option<std::net::SocketAddr>>> =
                Arc::new(Mutex::new(None));
            let r_ka_target_inner = r_ka_target.clone();
            // 本连接 v6 监听的实际端口（自愈公告用；多实例回退后不再是 9100）
            let r_v6_lport: u16 = self.listen_sock_v6.as_ref()
                .and_then(|s| s.local_addr().ok())
                .map(|a| a.port()).unwrap_or(9100);
            let r_target_peer = self.target_peer_id;
            let r_relay = self.relay.clone();
            let r_path = self.path.clone();
            let r_p2p = self.p2p.clone();
            let r_peer = self.p2p_peer.clone();
            let r_hub = self.hub.clone();
            let r_run = self.running.clone();
            let r_last = self.last_p2p_reply.clone();
            let r_v6_pub = self.announced_v6.clone();
        thread::spawn(move || {
                let mut buf = [0u8; 65536];
                let mut ka_start = std::time::Instant::now();
                let mut ka_nonce: u64 = 0;
                // 非阻塞 STUN 状态机：绝不能另起线程读同一个 socket（会抢数据包）。
                // 在本循环里发请求、在本循环里收响应，两不干扰。
                let mut stun_next = std::time::Instant::now() + Duration::from_secs(30);
                let mut stun_pending: Option<([u8; 12], std::time::Instant, std::net::SocketAddr)> = None;
                while r_run.load(Ordering::Relaxed) {
                    // 到期：发起一次映射探测
                    if stun_pending.is_none() && std::time::Instant::now() >= stun_next {
                        stun_next = std::time::Instant::now() + Duration::from_secs(30);
                        for srv in ["stun.chat.bilibili.com:3478", "stun.hitv.com:3478"] {
                            if let Some(saddr) = crate::stun::resolve_stun_server(srv) {
                                let (tid, pkt) = crate::stun::make_binding_request();
                                let _ = ls.send_to(&pkt, saddr);
                                stun_pending = Some((tid, std::time::Instant::now() + Duration::from_secs(3), saddr));
                                break;
                            }
                        }
                    }
                    match ls.recv_from(&mut buf) {
                        Ok((n, from)) => {
                            r_lrx.fetch_add(1, Ordering::Relaxed);
                            // 过滤类型证据：能收到「不是对端监听端口」发来的包，
                            // 说明 NAT 允许了我们没发过包的源端口 → ADF/EIF，不是 APDF。
                            // 用公告端口而非通道端口：证据往往在通道建立前就到达了。
                            let kp = peer_listen_port_known();
                            if kp != 0 && from.port() != kp {
                                note_filter_evidence_ip_based();
                            }
                            // 先看是不是我们那笔 STUN 查询的响应（同 socket，不额外抢包）
                            let mut consumed_by_stun = false;
                            if let Some((tid, _dl, saddr)) = stun_pending {
                                if from == saddr {
                                    if let Some((pubaddr, rtid)) =
                                        crate::stun::parse_binding_response_pub(&buf[..n])
                                    {
                                        if rtid == tid {
                                            let cur = *r_listen_pub.lock().unwrap();
                                            if cur != Some(pubaddr) {
                                                println!("  [RDV] listen mapping changed {:?} -> {}, re-announcing",
                                                    cur, pubaddr);
                                                let _ = r_relay.announce_ipv4(&pubaddr.to_string());
                                                *r_listen_pub.lock().unwrap() = Some(pubaddr);
                                            }
                                            stun_pending = None;
                                            consumed_by_stun = true;
                                        }
                                    }
                                }
                            }
                            if consumed_by_stun {
                                continue;
                            }
                            // DIAG: 打印监听 socket 收到的任何包的源地址（判断对端实际出口 IP）
                            {
                                use std::sync::atomic::{AtomicU64, Ordering as O2};
                                static RX: AtomicU64 = AtomicU64::new(0);
                                let k = RX.fetch_add(1, O2::Relaxed);
                                if k < 8 || k % 30 == 0 {
                                    println!("  [RDV-IN] len={} from={}", n, from);
                                }
                            }
                            if let Some(body) = r_relay.verify_probe(&buf[..n]) {
                                if let Some((ptype, nonce_p, ts)) =
                                    crate::probe::parse_probe_full(body)
                                {
                                    if ptype == crate::probe::PROBE_TYPE_REQUEST {
                                        r_probe_req
                                            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                        // O(shadow)：v4 敲门包 → P2pV4 观察。
                                        // 与 v6 不同，这里把合法签名 REQUEST 记为双向验证：
                                        // v4 汇合打的是「我们自己用同一 socket 保活出的公告映射」，
                                        // 对端刚从该四元组发出 → 回程路径存在；黑盒场景由
                                        // watchdog 停滞证据兜底（3s 内降级）。
                                        {
                                            let mut ps = r4_pipes.lock().unwrap();
                                            let p4 = &mut ps[index_of(PipeKind::P2pV4)];
                                            p4.o_req_rx += 1;
                                            p4.mark_verified();
                                            p4.update_derived(&r4_policy);
                                        }
                                        let reply = r_relay.sign_probe(
                                            &crate::probe::build_probe_reply(nonce_p, ts));
                                        let _ = ls.send_to(&reply, from);
                                        // 同 v6：收到合法签名的 REQUEST 即建通道（v4 路径），不再只等 REPLY。
                                        // PATH-STRATEGY：v6 > v4，v6 通道不被 v4 敲门降级替换
                                        // （实测 v4/v6 敲门都到达时通道来回翻，每翻一次 ARQ 归零）
                                        let need_req4 = match r_p2p.lock().unwrap().active_channel() {
                                            Some(ch) => chan_rebuild_needed(ch, from, true)
                                                && !(ch.peer_addr.is_ipv6() && from.is_ipv4()),
                                            None => true,
                                        };
                                        if need_req4 {
                                            r_p2p.lock().unwrap().upsert(P2pChannel::new(
                                                ls.clone(), from, false, r_relay.crypto_arc(), true));
                                        }
                                        *r_last.lock().unwrap() = std::time::Instant::now();
                                        *r_peer.lock().unwrap() = Some(from);
                                        apply_decision(&r4_pipes, &r4_policy, &r_path, &r_p2p, &r4_switches);
                                    } else {
                                        // 对端回了我方的探测 -> P2P 打通，复用监听 socket
                                        *r_last.lock().unwrap() = std::time::Instant::now();
                                        *r_peer.lock().unwrap() = Some(from);
                                        // 关键：不要每次收到回复都重建通道！
                                        // 重建会新建 TunnelStream、ARQ 序号归零，
                                        // 对端接收窗口已推进，新包会被全部判为重复而丢弃（实测 4/20）。
                                        r_probe_reply.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                        // O(shadow)：v4 探测回包 → P2pV4 观察（双向证据 + RTT 轨迹）
                                        {
                                            let rtt_ms = crate::probe::rtt_us_from(ts) / 1000;
                                            let mut ps = r4_pipes.lock().unwrap();
                                            let p4 = &mut ps[index_of(PipeKind::P2pV4)];
                                            p4.o_reply_rx += 1;
                                            p4.push_rtt(rtt_ms);
                                            p4.mark_verified();
                                            p4.update_derived(&r4_policy);
                                        }
                                        let need_new = match r_p2p.lock().unwrap().active_channel() {
                                            Some(ch) => chan_rebuild_needed(ch, from, true),
                                            None => true,
                                        };
                                        if need_new {
                                            let id = r_p2p.lock().unwrap().upsert(P2pChannel::new(
                                                ls.clone(),
                                                from,
                                                false,
                                                r_relay.crypto_arc(),
                                                true,
                                            ));
                                            r_p2p.lock().unwrap().promote_verified(id);
                                        }
                                        {
                                            use std::sync::atomic::{AtomicU64, Ordering as O2};
                                            static RC: AtomicU64 = AtomicU64::new(0);
                                            let k = RC.fetch_add(1, O2::Relaxed);
                                            if k < 5 || k % 30 == 0 {
                                                let us = crate::probe::rtt_us_from(ts);
                                                println!("  [RDV-RTT] {:.1}ms from {} (#{})", us as f64 / 1000.0, from, k + 1);
                                            }
                                        }
                                        apply_decision(&r4_pipes, &r4_policy, &r_path, &r_p2p, &r4_switches);
                                    }
                                }
                            } else {
                                // 与 RDV6 同款修复：按 socket+来源路由，不要求 active
                                // （旧 active_channel() 要求同样把未 active 通道的帧静默丢弃）
                                let handled = {
                                    let g = r_p2p.lock().unwrap();
                                    g.find(&ls, from).map(|ch| {
                                        let verified = ch.verified.get();
                                        let chunks = ch.stream.lock().unwrap().on_packet(&buf[..n]);
                                        (verified, chunks)
                                    })
                                };
                                match handled {
                                    Some((verified, chunks)) => {
                                        for d in chunks {
                                            if d.as_slice() == P2P_VERIFY_TAG { continue; }
                                            if verified { r_hub.lock().unwrap().push_p2p_frame(d); }
                                            else { drop_ghost("rdv4-unverified"); }
                                        }
                                    }
                                    None => drop_ghost("rdv4-nochan"),
                                }
                            }
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(1));
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                            thread::sleep(Duration::from_millis(1));
                        }
                        Err(_) => thread::sleep(Duration::from_millis(5)),
                    }

                    // ARQ 重传检查（每 50ms 一次）
                    if tick_at.elapsed() >= Duration::from_millis(50) {
                        tick_at = std::time::Instant::now();
                        if let Some(ch) = r_p2p_tick.lock().unwrap().active_channel() {
                            ch.stream.lock().unwrap().tick();
                        }
                    }

                    if let Some((_, dl, _)) = stun_pending {
                        if std::time::Instant::now() > dl { stun_pending = None; }
                    }

                    // Rendezvous 的关键：监听 socket 必须持续出站，否则 NAT 里没有它的映射，
                    // 对端连过来会被直接丢弃（这就是"公告了地址却连不上"的原因）。
                    if ka_start.elapsed() >= Duration::from_secs(10) {
                        ka_start = std::time::Instant::now();
                        ka_nonce += 1;
                        // 注意：映射自愈的 STUN 查询不能放在接收循环里——
                        // query_stun_on_socket 最长阻塞 3 秒，会把接收循环卡住，
                        // 导致排队积压（实测把 65ms 的应用层延迟测成 128ms，并造成压测超时）。
                        // 自愈已改为独立线程。
                        let pkt = r_relay.sign_probe(
                            &crate::probe::build_probe_packet(ka_nonce));
                        // 从对端公告里刷新保活目标（relay 观察到的 IPv4 + 对端监听映射）
                        if let Some((relay_addr, _v6, announced_v4)) =
                            r_relay.query_peer_info(r_target_peer)
                        {
                            if relay_addr.ip().is_ipv4() {
                                *r_ka_target_inner.lock().unwrap() = Some(relay_addr);
                            }
                            if let Some(a) = announced_v4 {
                                if a.ip().is_ipv4() {
                                    *r_ka_target_inner.lock().unwrap() = Some(a);
                                }
                            }
                        }
                        // IPv6 公告自愈：切网后启动时 get_my_ipv6 可能返回 None（地址未就绪），
                        // 而公告只在启动做一次 → 服务端永远拿不到 v6、无从敲门（实测根因）。
                        // 每 3 个保活轮（约 30s）重探，空→有 或 变化 时重公告。
                        if ka_nonce % 3 == 0 {
                            let cur_sa: Option<std::net::SocketAddr> = get_my_ipv6()
                                .map(|a| a.ip())
                                .map(|ip| format!("[{}]:{}", ip, r_v6_lport))
                                .and_then(|x| x.parse().ok());
                            let last = *r_v6_pub.lock().unwrap();
                            let need = match (&last, &cur_sa) {
                                (None, Some(_)) => true,
                                (Some(a), Some(b)) => a != b,
                                _ => false,
                            };
                            if need {
                                if let Some(sa) = cur_sa {
                                    if !sa.ip().is_unspecified() {
                                        let s = sa.to_string();
                                        println!("  [RDV] IPv6 announce {:?} -> {}, re-announcing", last, s);
                                        let _ = r_relay.announce_ipv6(&s);
                                    }
                                    *r_v6_pub.lock().unwrap() = Some(sa);
                                }
                            }
                        }
                        // 必须按地址族过滤：v4 监听 socket 发往 IPv6 地址会返回
                        // os error 97 (Address family not supported)，而 r_peer 可能是
                        // 通过 v6 通道学到的地址（实测手机 WiFi 场景每轮都刷这个错）。
                        let targets: Vec<std::net::SocketAddr> = {
                            let mut v = Vec::new();
                            if let Some(a) = *r_peer.lock().unwrap() {
                                if a.is_ipv4() { v.push(a); }
                            }
                            if let Some(a) = *r_ka_target_inner.lock().unwrap() {
                                if a.is_ipv4() && !v.contains(&a) { v.push(a); }
                            }
                            v
                        };
                        for t in targets {
                            match ls.send_to(&pkt, t) {
                                Ok(n) => {
                                    use std::sync::atomic::{AtomicU64, Ordering as O2};
                                    static TX: AtomicU64 = AtomicU64::new(0);
                                    let k = TX.fetch_add(1, O2::Relaxed);
                                    if k < 5 || k % 20 == 0 {
                                        println!("  [RDV-TX] {} bytes -> {} (from :{})", n, t,
                                            ls.local_addr().map(|a| a.port()).unwrap_or(0));
                                    }
                                }
                                Err(e) => println!("  [RDV-TX] ERR -> {}: {}", t, e),
                            }
                        }
                    }
                }
            });
        }

        // ── 打洞引擎（PLAN 第四节：20 socket 池 + 双向端口扫描）──
        // 简单探测打不通时（对称 NAT / 端口随机），由 PunchEngine 做端口扫描。
        // 打通后必须复用「胜出的那个 socket」收发数据——NAT 映射绑在 socket 上。
        {
            let pr_relay = self.relay.clone();
            let pr_path = self.path.clone();
            let pr_p2p = self.p2p.clone();
            let pr_peer = self.p2p_peer.clone();
            let pr_hub = self.hub.clone();
            let pr_run = self.running.clone();
            let pr_lock = self.punch_locked.clone();
            let pr_pipes = self.pipes.clone();
            let pr_policy = self.policy.clone();
            let pr_switches = self.path_switches.clone();
            let pr_target = self.target_peer_id;
            thread::spawn(move || {
                // VNET_NO_P2P=1 必须同时禁用打洞引擎，否则「强制走中继」压测会被 P2P 污染
                if std::env::var("VNET_NO_P2P").unwrap_or_default() == "1" {
                    println!("  [DIAG] VNET_NO_P2P=1 -> punch engine disabled");
                    return;
                }
                let mut engine: Option<crate::punch::PunchEngine> = None;
                let mut last_engine_cands: Option<(std::net::SocketAddr, Option<std::net::SocketAddr>, Option<std::net::SocketAddr>)> = None;
                let mut nonce = 0u64;
                let mut pump_sock: Option<std::sync::Arc<UdpSocket>> = None;
                let mut last_probe = std::time::Instant::now();
                    let mut pump_tick_at = std::time::Instant::now();
                let mut punch_reported = false;

                while pr_run.load(Ordering::Relaxed) {
                    // 已打通 -> 只做数据泵 + 保活
                    if let Some(ref sock) = pump_sock {
                        let mut buf = [0u8; 65536];
                        loop {
                            match sock.recv_from(&mut buf) {
                                Ok((n, from)) => {
                                    if let Some((ptype, nonce_p, ts)) =
                                        crate::probe::parse_probe_full(&buf[..n])
                                    {
                                        if ptype == crate::probe::PROBE_TYPE_REQUEST {
                                            let reply = pr_relay.sign_probe(
                                                &crate::probe::build_probe_reply(nonce_p, ts));
                                            let _ = sock.send_to(&reply, from);
                                        }
                                    } else if let Some(ch) = pr_p2p.lock().unwrap().active_channel() {
                                        {
                                            use std::sync::atomic::{AtomicU64, Ordering as O3};
                                            static DBG: AtomicU64 = AtomicU64::new(0);
                                            let dk = DBG.fetch_add(1, O3::Relaxed);
                                            if dk < 10 {
                                                println!("  [DBG-FIX] pump rx {}B from {} ptr_eq={}",
                                                    n, from, std::sync::Arc::ptr_eq(&ch.socket, sock));
                                            }
                                        }
                                        // 通道守卫：帧到达的 socket 必须与通道 socket 一致（防跨流污染）
                                        if std::sync::Arc::ptr_eq(&ch.socket, sock) {
                                            // P2P 数据走可靠流：解密 → 去重排序 → 按序交付
                                            let chunks = ch.stream.lock().unwrap().on_packet(&buf[..n]);
                                            for d in chunks {
                                                pr_hub.lock().unwrap().push_p2p_frame(d);
                                            }
                                        } else {
                                            drop_ghost("punch");
                                        }
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                        // ARQ tick：通道若落在打洞胜出 socket 上，必须有人重传
                        if pump_tick_at.elapsed() >= Duration::from_millis(50) {
                            pump_tick_at = std::time::Instant::now();
                            if let Some(ch) = pr_p2p.lock().unwrap().active_channel() {
                                ch.stream.lock().unwrap().tick();
                            }
                        }
                        // 保持 NAT 映射：每 15 秒一个探测
                        if last_probe.elapsed() >= Duration::from_secs(15) {
                            nonce += 1;
                            if let Some(peer) = *pr_peer.lock().unwrap() {
                                let pkt = pr_relay.sign_probe(
                                    &crate::probe::build_probe_packet(nonce));
                                let _ = sock.send_to(&pkt, peer);
                            }
                            last_probe = std::time::Instant::now();
                        }
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }

                    // 简单探测已打通就不需要端口扫描
                    if pr_path.lock().unwrap().is_direct() {
                        thread::sleep(Duration::from_secs(1));
                        continue;
                    }

                    // 懒创建引擎（需要先拿到对端地址）
                    // 候选变化时重建引擎：否则引擎拿着创建瞬间的陈旧候选，对端重新公告后仍打旧端口
                    let cur_cands = pr_relay.query_peer_info(pr_target);
                    let changed = match (&cur_cands, &last_engine_cands) {
                        (Some((r1, v1, p1)), Some((r0, v0, p0))) => r1 != r0 || v1 != v0 || p1 != p0,
                        (Some(_), None) => true,
                        _ => false,
                    };
                    if changed { engine = None; last_engine_cands = cur_cands.clone(); }
                    if engine.is_none() {
                        if let Some((relay_addr, ipv6, public_v4)) = cur_cands.clone()
                        {
                            let stun_port = public_v4.map(|a| a.port())
                                .or(Some(relay_addr.port()));
                            match crate::punch::PunchEngine::new(
                                ipv6.filter(|a| a.is_ipv6()),
                                public_v4.or(Some(relay_addr)),
                                stun_port,
                                20,
                                pr_relay.probe_auth_clone(),
                            ) {
                                Ok(e) => {
                                    println!("  [PUNCH] Engine ready: 20 sockets, peer v4={:?} v6={:?}",
                                        public_v4.or(Some(relay_addr)), ipv6);
                                    engine = Some(e);
                                }
                                Err(e) => {
                                    println!("  [PUNCH] Engine init failed: {}", e);
                                    thread::sleep(Duration::from_secs(5));
                                    continue;
                                }
                            }
                        } else {
                            thread::sleep(Duration::from_secs(2));
                            continue;
                        }
                    }

                    if let Some(ref mut e) = engine {
                        nonce += 1;
                        if e.punch_round(nonce) {
                            if let Some(res) = e.get_result() {
                                // 简单探测已经打通时，打洞引擎只保留为备份，不接管数据面。
                                // 两条路径同时抢一个 P2P 通道会导致服务端按 A socket 回包、
                                // 客户端从 B socket 发出，实测丢一半。
                                let simple_ok = pr_path.lock().unwrap().is_direct();
                                if simple_ok {
                                    if !punch_reported {
                                        println!("  [PUNCH] {} also reachable ({}), keeping simple path",
                                            res.method.name(), res.peer_addr);
                                        punch_reported = true;
                                    }
                                    thread::sleep(Duration::from_secs(2));
                                    continue;
                                }
                                if let Some(sock) = e.winning_socket() {
                                    println!("  [PUNCH] Success via {} -> {}, reusing socket for data",
                                        res.method.name(), res.peer_addr);
                                    *pr_peer.lock().unwrap() = Some(res.peer_addr);
                                    pr_lock.store(true, std::sync::atomic::Ordering::Relaxed);
                                    // 与 RDV 分支同理：通道已存在且对端未变时绝不重建。
                                    // 打洞引擎每轮都会「成功」，无条件重建会让 ARQ 序号归零，
                                    // 对端把新包全判为重复丢弃 —— 症状是「前几次能通、之后全失败」。
                                    let need_pr = match pr_p2p.lock().unwrap().active_channel() {
                                        Some(ch) => ch.peer_addr != res.peer_addr || !ch.verified.get(),
                                        None => true,
                                    };
                                    if need_pr {
                                        let id = pr_p2p.lock().unwrap().upsert(P2pChannel::new(
                                            sock.clone(), res.peer_addr, res.is_ipv6, pr_relay.crypto_arc(), true));
                                        // 打洞胜出的已验证通道必须能成为 active——
                                        // 否则 forward 线程按 active 选通道时永远回落 relay。
                                        pr_p2p.lock().unwrap().promote_verified(id);
                                    }
                                    // O(shadow)：打洞胜出 = 探测往返成立 → 对应族管道双向验证
                                    {
                                        let fam = if res.is_ipv6 { PipeKind::P2pV6 } else { PipeKind::P2pV4 };
                                        let mut ps = pr_pipes.lock().unwrap();
                                        let pp = &mut ps[index_of(fam)];
                                        pp.o_reply_rx += 1;
                                        pp.mark_verified();
                                        pp.update_derived(&pr_policy);
                                    }
                                    apply_decision(&pr_pipes, &pr_policy, &pr_path, &pr_p2p, &pr_switches);
                                    pump_sock = Some(sock);
                                }
                            }
                        }
                    }
                    thread::sleep(Duration::from_secs(1));
                }
            });
        }

        match local_port {
            Some(p) => {
                let proxy_addr = format!("127.0.0.1:{}", p);
                let listener = TcpListener::bind(&proxy_addr)?;
                self.run_accept(listener, &proxy_addr)
            }
            // multi-forward：监听口由 add_forward 各自绑定，这里不建 listener。
            // 返回 Ok 不影响已起的接收/keepalive/探测线程（它们是独立线程）。
            None => Ok(()),
        }
    }

    /// 启动客户端并立即返回（accept 循环跑在独立线程）——
    /// 嵌入方（async/管理面线程）用这个，避免调用线程被 accept 吃掉。
    /// 返回 Ok 前已完成端口绑定校验（绑定失败立刻报错，不在线程里静默失败）。
    ///
    /// 注意：必须跑**完整版 start_client** —— 它才起探测/打洞/保活/状态线程。
    /// （2026-11-05 修复：此前这里只 spawn accept 循环，宿主用它必然退化成纯中继。）
    pub fn start_client_detached(self: &std::sync::Arc<Self>, local_port: u16) -> anyhow::Result<()> {
        {
            // 同步预检端口可绑（失败立刻报错；成功即释放，真实绑定在 start_client 内）
            let probe = TcpListener::bind(("127.0.0.1", local_port))?;
            drop(probe);
        }
        let me = self.clone();
        std::thread::spawn(move || {
            if let Err(e) = me.start_client(local_port) {
                eprintln!("  [!!] start_client (detached) exited for peer {}: {:#}", me.my_peer_id, e);
            } else {
                println!("  [DETACHED] start_client OK for peer {} (threads alive)", me.my_peer_id);
            }
        });
        Ok(())
    }

    /// accept 主循环：**可中断**（看 running 标志），退出时 listener 被 drop → 端口释放。
    /// 2026-11-05 修复：原 `for stream in listener.incoming()` 永不返回且不看 running，
    /// 导致 (a) 嵌入方调用线程被永久占用 (b) stop 后端口不释放、无法原地重建。
    fn run_accept(&self, listener: TcpListener, proxy_addr: &str) -> anyhow::Result<()> {
        listener.set_nonblocking(true)?;
        if let Ok(a) = listener.local_addr() {
            self.local_port.store(a.port() as u32, Ordering::Relaxed);
        }
        println!("  [OK] Local proxy on {}", proxy_addr);
        tracelog!("[BOOT] local proxy accepting");

        while self.running.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((client, peer)) => {
                    // 坏包根因修复（2026-11-10）：listener 是 non-blocking 的，
                    // accept 出的 socket 继承非阻塞模式 → down 线程 write_all()
                    // 在 TCP 缓冲区满时返回 WouldBlock(10035) 被误判为致命错误
                    // → 连接截断在 ~200KB → 剩余 800KB 丢弃（替换型损坏）。
                    // 修法：accept 后恢复阻塞模式（read 由 set_read_timeout 控速）。
                    let _ = client.set_nonblocking(false);
                    // 缓冲区调优（2026-11-10）：默认 ~64KB 在 20 并发大传输下
                    // 频繁触发阻塞/唤醒。256KB = ARQ 窗口(140KB) × 2 的余量，
                    // 20 并发共 5MB——PC/Android 都能承受。可用 VNET_TCP_BUF 覆盖。
                    let tcp_buf = std::env::var("VNET_TCP_BUF").ok()
                        .and_then(|v| v.parse::<usize>().ok())
                        .unwrap_or(256 * 1024);
                    {
                        let sr = socket2::SockRef::from(&client);
                        let _ = sr.set_send_buffer_size(tcp_buf);
                        let _ = sr.set_recv_buffer_size(tcp_buf);
                    }
                    println!("  [>>] Connection from {} (spawned)", peer);
                    // 每条连接独立线程：一条卡住不影响后续 accept
                    let ctx = self.ctx();
                    thread::spawn(move || ctx.forward(client));
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(20));
                }
                Err(e) => {
                    eprintln!("  [!!] Accept: {}", e);
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }
        // listener 在此 drop → 端口立即释放，可原地重建
        drop(listener);
        println!("  [OK] Local proxy on {} closed (port released)", proxy_addr);
        Ok(())
    }

}

/// 单条连接转发所需的上下文（全是 Arc 句柄，可安全 move 进独立线程）。
/// accept 循环必须为每条连接 spawn 一个线程，绝不在这里阻塞，
/// 否则一条不发 EOF 的悬挂连接就会冻结整条隧道的 accept。
#[derive(Clone)]
struct ForwardCtx {
    running: Arc<AtomicBool>,
    relay: Arc<RelayClient>,
    relay_arq: Arc<std::sync::Mutex<crate::relay_arq::RelayArq>>,
    p2p: Arc<Mutex<P2pRegistry>>,
    path: Arc<Mutex<DataPath>>,
    hub: Arc<Mutex<ConnHub>>,
    p2p_peer: Arc<Mutex<Option<std::net::SocketAddr>>>,
    target_peer_id: u32,
    pipes: Arc<Mutex<Vec<PathPipe>>>,
    policy: RPolicy,
    switches: Arc<Mutex<u32>>,
    /// 隧道级应用连接开关表（`A_close_explicitly` 从监控线程关闭指定连接）
    conn_flags: Arc<Mutex<std::collections::HashMap<u64, Arc<AtomicBool>>>>,
    /// 流 id → 存活开关（Phase 1 per-stream 终结用；与 conn_flags 同一开关对象，
    /// 键空间换成 stream id，生命周期随连接注册/注销）
    stream_flags: Arc<Mutex<HashMap<u16, Arc<AtomicBool>>>>,
    /// 债 2：multi-forward 流归属表（stream_id → target_port），
    /// 探测失败时按 forward 终结其全部流（见 Connection::mf_terminate_forward_streams）
    mf_stream_targets: Arc<Mutex<HashMap<u16, u16>>>,
    /// 自拨标志（target_peer_id == my_peer_id）：forward 时走 loopback 短路
    self_dial: bool,
    /// 观测：forward_targeted 开流计数 + 最近一次开流信息（Android 无 stdout，靠状态文件供数）
    mf_opened: Arc<AtomicU64>,
    mf_last_open_info: Arc<Mutex<String>>,
}

impl ForwardCtx {
    /// legacy 单转发（不带目标口；服务端用自己的 --target-port）
    fn forward(&self, client: TcpStream) {
        self.forward_targeted(client, None);
    }

    /// 带目标口的转发（multi-forward）：`SESSION_START` 载荷携带 target_port，
    /// 服务端按白名单解析后连对应上游；`None` = legacy 空载荷，行为与旧版一致。
    fn forward_targeted(&self, client: TcpStream, target: Option<u16>) {
        // ── 自拨短路（2026-11-10 DSH 性能阻塞）：target == self 时走 loopback TCP 代理，
        // 不经隧道。P2P IPv6 自拨是物理回环（PC→网卡→路由器→PC），73KB 要 14 秒；
        // 回环 TCP 代理 <0.1s。适用：self_dial 且有 target 口（自拨必走 multi-forward）。
        if self.self_dial {
            if let Some(tp) = target {
                if let Ok(upstream) = TcpStream::connect(("127.0.0.1", tp)) {
                    println!("  [LOOPBACK] self-dial 127.0.0.1:{} (bypass tunnel)", tp);
                    let up_w = upstream.try_clone().unwrap();
                    let cli_w = client.try_clone().unwrap();
                    std::thread::spawn(move || {
                        let mut c = cli_w; let mut u = up_w;
                        let _ = std::io::copy(&mut c, &mut u);
                    });
                    let mut u = upstream; let mut c = client;
                    let _ = std::io::copy(&mut u, &mut c);
                    return;
                }
            }
        }
        // 注册本连接的下行队列（stream id = 本连接的线上身份，u16 环绕）
        let conn_id = self.hub.lock().unwrap().register();
        // 债 2：登记流 → target 归属（multi-forward 专用；legacy 空 target 不登记），
        // 供 caps 探测失败时按 forward 终结其全部流
        if let Some(t) = target {
            self.mf_stream_targets.lock().unwrap().insert(conn_id, t);
        }
        // 观测：流开计数 + 路径（Android println 黑洞，靠状态文件供数）
        self.mf_opened.fetch_add(1, Ordering::Relaxed);
        *self.mf_last_open_info.lock().unwrap() = format!(
            "conn#{} path={:?} peer={} target={:?}",
            conn_id, *self.path.lock().unwrap(), self.target_peer_id, target);
        tracelog!("[conn#{}] OPEN path={:?} target_peer={}", conn_id,
                  *self.path.lock().unwrap(), self.target_peer_id);
        let hub_up = self.hub.clone();
        let hub_down = self.hub.clone();
        let running = self.running.clone();
        let relay = self.relay.clone();
        let p2p = self.p2p.clone();
        let path = self.path.clone();
        let target_id = self.target_peer_id;

        // Connection-active flag: when either thread exits, the other should too
        let conn_active = Arc::new(AtomicBool::new(true));
        // 登记到隧道级开关表：静默恢复梯的最后一步要能从监控线程关闭本连接
        // （key 用独立 u64 计数：stream id 会环绕，复用同一空间会误关新连接）
        let flag_key = next_conn_flag_key();
        self.conn_flags.lock().unwrap().insert(flag_key, conn_active.clone());
        // Phase 1 按流终结：sid → 同一开关对象（key 即线上流身份；注销在连接
        // 清理处先于 hub unregister 完成，sid 环绕复用不会拿到别人的开关）
        self.stream_flags.lock().unwrap().insert(conn_id, conn_active.clone());
        // 本端是否只是半关闭（SHUT_WR）。只有半关闭才需要 drain，否则立即释放 accept 循环
        let half_closed = Arc::new(AtomicBool::new(false));

        let up_client = client.try_clone().unwrap();
        let up_relay = relay.clone();
        let up_relay_arq: Arc<std::sync::Mutex<crate::relay_arq::RelayArq>> = self.relay_arq.clone();
        let up_p2p = p2p.clone();
        let up_path = path.clone();
        let up_target = target_id;
        let up_running = running.clone();
        let up_active = conn_active.clone();
        let up_peer = self.p2p_peer.clone();
        let up_half = half_closed.clone();
        let up_pipes = self.pipes.clone();
        let up_policy = self.policy.clone();
        let up_switches = self.switches.clone();

        let up = thread::spawn(move || {
            let mut stream = up_client;
            // server-first 协议必须在任何应用 DATA 前建立 upstream（R6）：
            // 发送按流 SESSION_START——relay 经 ARQ 有序；P2P 经通道 TunnelStream
            // 有序（帧格式同构）。phase 2：两条路径统一按流建会话。
            // 旧实现的三个失效机制（R12 RED 根因）在此一并消除：
            //   裸 UDP SESSION_START 换掉 peer 唯一 upstream / accept 即抢 owner /
            //   所有连接的字节共用一条无身份流。
            {
                let direct = up_path.lock().unwrap().is_direct();
                // multi-forward：Some(t) → [ver=1][target_port:2]；None → 空载荷（legacy）
                let frame = match target {
                    Some(t) => crate::transport::build_session_start_targeted(conn_id, t),
                    None => crate::transport::wrap_stream_frame(
                        crate::transport::STREAM_TAG_SESSION_START, conn_id, &[]),
                };
                if direct {
                    let guard = up_p2p.lock().unwrap();
                    if let Some(ch) = guard.active_channel() {
                        let _ = ch.stream.lock().unwrap().send(&frame);
                    } else {
                        drop(guard);
                        let mut raq = up_relay_arq.lock().unwrap();
                        raq.send(&frame);
                        let (nf, rf) = raq.flush_and_tick();
                        drop(raq);
                        for f in nf { let _ = up_relay.send_to_peer(up_target, &f); }
                        for f in rf { let _ = up_relay.send_to_peer(up_target, &f); }
                    }
                } else {
                    let (nf, rf) = {
                        let mut raq = up_relay_arq.lock().unwrap();
                        raq.send(&frame);
                        raq.flush_and_tick()
                    };
                    for f in nf { let _ = up_relay.send_to_peer(up_target, &f); }
                    for f in rf { let _ = up_relay.send_to_peer(up_target, &f); }
                }
            }
            // 路径切换追踪（P1 修复 2026-11-10）：relay 和 P2P 在 server 侧维护**独立的流表**。
            // 流在 relay 打开后路径切到 P2P，DATA 到达 P2P 表 → DATA_UNKNOWN_STREAM → 流死。
            // 修法：up 线程检测路径变化，变化时在新路径上重发 SESSION_START（server 在新表建 upstream）。
            let mut last_direct = up_path.lock().unwrap().is_direct();
            let mut buf = [0u8; 16384]; // 256KB：一次读大 payload，避免多次 send
            stream.set_read_timeout(Some(Duration::from_millis(50))).ok();
            // 可选性能采样：只在 VNET_PERF=1 时输出，正常交付不增加热路径打印
            let perf = std::env::var("VNET_PERF").unwrap_or_default() == "1";
            let mut perf_at = std::time::Instant::now();
            while up_running.load(Ordering::Relaxed) && up_active.load(Ordering::Relaxed) {
                match stream.read(&mut buf) {
                    Ok(0) => {
                        // 应用已关写端（FIN）：按流发 STREAM_FIN——relay 经 ARQ、
                        // P2P 经通道 TunnelStream，均排在本连接全部数据之后 →
                        // server 对该流的 upstream shutdown(Write)，对端服务看到
                        // FIN 后正常收尾。旧实现无上行 FIN 传播（仅 relay 有），
                        // server upstream 要等 300s GC（挂死会话的来源之一）。
                        {
                            let direct = up_path.lock().unwrap().is_direct();
                            let frame = crate::transport::wrap_stream_frame(
                                crate::transport::STREAM_TAG_FIN, conn_id, &[]);
                            if direct {
                                let guard = up_p2p.lock().unwrap();
                                if let Some(ch) = guard.active_channel() {
                                    let _ = ch.stream.lock().unwrap().send(&frame);
                                }
                            } else {
                                let (nf, rf) = {
                                    let mut raq = up_relay_arq.lock().unwrap();
                                    raq.send(&frame);
                                    raq.flush_and_tick()
                                };
                                for f in nf { let _ = up_relay.send_to_peer(up_target, &f); }
                                for f in rf { let _ = up_relay.send_to_peer(up_target, &f); }
                            }
                        }
                        up_half.store(true, Ordering::Relaxed);
                        break;
                    }
                    Ok(n) => {
                        hub_up.lock().unwrap().add_up_bytes(conn_id, n as u64);
                        let current = *up_path.lock().unwrap();
                        // ── P1 修复：路径切换时重发 SESSION_START（server 流表独立）──
                        let now_direct = current.is_direct();
                        if now_direct != last_direct {
                            tracelog!("[conn#{}] PATH_SWITCH {} -> {} : re-send SESSION_START",
                                conn_id, if last_direct { "P2P" } else { "Relay" },
                                if now_direct { "P2P" } else { "Relay" });
                            let frame = match target {
                                Some(t) => crate::transport::build_session_start_targeted(conn_id, t),
                                None => crate::transport::wrap_stream_frame(
                                    crate::transport::STREAM_TAG_SESSION_START, conn_id, &[]),
                            };
                            if now_direct {
                                let guard = up_p2p.lock().unwrap();
                                if let Some(ch) = guard.active_channel() {
                                    let _ = ch.stream.lock().unwrap().send(&frame);
                                }
                            } else {
                                let mut raq = up_relay_arq.lock().unwrap();
                                raq.send(&frame);
                            }
                            last_direct = now_direct;
                        }
                        if current.is_direct() {
                            // ── 流控：等 inflight < 64 再发（锁不持有，receiver 可清 ACK）──
                            loop {
                                let cnt = {
                                    let g = up_p2p.lock().unwrap();
                                    match g.active_channel() {
                                        Some(ch) => ch.stream.lock().unwrap().inflight_count(),
                                        None => 0,
                                    }
                                };
                                if cnt < 64 { break; }
                                std::thread::sleep(Duration::from_millis(5));
                            }
                            // P2P：优先用已建立的 P2P 通道（IPv4/IPv6 各自 socket）。
                            // P2P 路径 phase 2 前仍是单连接语义：认领 owner 供下行路由。
                            hub_up.lock().unwrap().claim_owner(conn_id);
                            let guard = up_p2p.lock().unwrap();
                            if let Some(ch) = guard.active_channel() {
                                // ARQ：编号 + 加密 + 记 inflight，超时自动重传。
                                // phase 2：按流包装（stream_chunk ≤ TunnelStream 分块
                                // 1100/1200，内层帧边界不拆），与 relay 路径同构。
                                {
                                    use std::sync::atomic::Ordering as DO;
                                    let sn = DIAG_SEND.fetch_add(1, DO::Relaxed);
                                    if n > 32768 || sn < 20 {
                                        let infl = ch.stream.lock().unwrap().inflight_count();
                                        // dest 必打：跨网事故（2026-11-08 P1-lite）中数据帧
                                        // 被发往 relay 源口而非直连口（黑洞 126s），需要目的地证据
                                        println!("  [DIAG] SEND#{}: {}B inflight={} dest={} t={}",
                                            sn, n, infl, ch.peer_addr,
                                            std::time::SystemTime::now()
                                                .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() % 100000);
                                    }
                                }
                                let mut send_err = false;
                                for chunk in buf[..n].chunks(stream_chunk()) {
                                    let frame = crate::transport::wrap_stream_frame(
                                        crate::transport::STREAM_TAG_DATA, conn_id, chunk);
                                    if ch.stream.lock().unwrap().send(&frame).is_err() {
                                        send_err = true;
                                        break;
                                    }
                                }
                                if send_err {
                                    let ch_v6 = ch.is_ipv6;
                                    drop(guard);
                                    // O(shadow)：通道发送失败 → 对应族管道记失败证据
                                    {
                                        let fam = if ch_v6 { PipeKind::P2pV6 } else { PipeKind::P2pV4 };
                                        let mut ps = up_pipes.lock().unwrap();
                                        let pp = &mut ps[index_of(fam)];
                                        pp.mark_failed();
                                        pp.update_derived(&up_policy);
                                    }
                                    // 发送失败 -> 证据已记（mark_failed），决策体降级标签；
                                    // 死通道就地清（原语义；决策体不再代清），本包走中继
                                    apply_decision(&up_pipes, &up_policy, &up_path, &up_p2p, &up_switches);
                                    up_p2p.lock().unwrap().active = None;
                                    // P2P 失败 fallback → relay（也走 ARQ，按流包装）
                                    {
                                        let mut raq = up_relay_arq.lock().unwrap();
                                        for chunk in buf[..n].chunks(stream_chunk()) {
                                            raq.send(&crate::transport::wrap_stream_frame(
                                                crate::transport::STREAM_TAG_DATA, conn_id, chunk));
                                        }
                                        let (nf, rf) = raq.flush_and_tick();
                                        drop(raq);
                                        for frame in nf { let _ = up_relay.send_to_peer(up_target, &frame); }
                                        for frame in rf { let _ = up_relay.send_to_peer(up_target, &frame); }
                                    }
                                }
                            } else {
                                drop(guard);
                                // 无 P2P 通道 → relay（走 ARQ，按流包装）
                                {
                                    let mut raq = up_relay_arq.lock().unwrap();
                                    for chunk in buf[..n].chunks(stream_chunk()) {
                                        raq.send(&crate::transport::wrap_stream_frame(
                                            crate::transport::STREAM_TAG_DATA, conn_id, chunk));
                                    }
                                    let (nf, rf) = raq.flush_and_tick();
                                    drop(raq);
                                    for frame in nf { let _ = up_relay.send_to_peer(up_target, &frame); }
                                    for frame in rf { let _ = up_relay.send_to_peer(up_target, &frame); }
                                }
                            }
                        } else {
                            // 主 relay 路径（!is_direct）→ ARQ，按流包装
                            // （每 chunk 一个内层头：先按 stream_chunk() 切块再包装，
                            //   保证 ARQ 交付边界与内层帧边界一致）
                            {
                                let mut raq = up_relay_arq.lock().unwrap();
                                for chunk in buf[..n].chunks(stream_chunk()) {
                                    raq.send(&crate::transport::wrap_stream_frame(
                                        crate::transport::STREAM_TAG_DATA, conn_id, chunk));
                                }
                                let (new_f, retrans_f) = raq.flush_and_tick();
                                drop(raq);
                                for frame in new_f { let _ = up_relay.send_to_peer(up_target, &frame); }
                                for frame in retrans_f { let _ = up_relay.send_to_peer(up_target, &frame); }
                            }
                        }
                    }
                    // 读空闲 ≠ 发送空闲：应用可能已把全部字节读进 ARQ pending，
                    // 而窗口(32帧)发满后的剩余 pending 必须继续 flush。
                    // 修复前这两个分支是空的 → pending 只能等 keepalive 的 500ms tick，
                    // 吞吐被压到 32帧/500ms ≈ 64KB/s（实测 58KB/s，512KB 要 10s）。
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut =>
                    {
                        let mut raq = up_relay_arq.lock().unwrap();
                        let (new_f, retrans_f) = raq.flush_and_tick();
                        drop(raq);
                        for frame in new_f { let _ = up_relay.send_to_peer(up_target, &frame); }
                        for frame in retrans_f { let _ = up_relay.send_to_peer(up_target, &frame); }
                        // 有 pending/在途时快轮询（1ms），否则退避省 CPU
                        let busy = {
                            let raq = up_relay_arq.lock().unwrap();
                            raq.pending_count() > 0 || raq.inflight_count() > 0
                        };
                        if busy { thread::sleep(Duration::from_millis(1)); }
                        else { thread::sleep(Duration::from_millis(5)); }
                    }
                    Err(_) => break,
                }
                if perf && perf_at.elapsed() >= Duration::from_millis(100) {
                    perf_at = std::time::Instant::now();
                    let raq = up_relay_arq.lock().unwrap();
                    tracelog!("[perf-up] pending={} inflight={} sent={} acked={} retrans={} rtt={}ms rto={}ms",
                        raq.pending_count(), raq.inflight_count(), raq.sent, raq.acked,
                        raq.retransmitted, raq.rtt_ms().unwrap_or(0), raq.rto_ms());
                }
            }
            // 注意：不在这里清 conn_active —— 由 forward() 在 drain 完成后清，
            // 否则 down 线程会立即退出，在途响应来不及写出。
        });

        let down_client = client.try_clone().unwrap();
        let down_active = conn_active.clone();       // moved into thread
        let down_active_obs = conn_active.clone();   // observer for drain loop
        let down_running = running;
        let down_queue = self.hub.clone();
        // 记录 down 线程最后一次成功写入的时刻（drain 判据）
        let last_write = Arc::new(Mutex::new(std::time::Instant::now()));
        let last_write_obs = last_write.clone();

        let down = thread::spawn(move || {
            let mut stream = down_client;
            let exit_reason;
            'down_loop: loop {
                if !down_running.load(Ordering::Relaxed) { exit_reason = "running=false"; break; }
                if !down_active.load(Ordering::Relaxed) { exit_reason = "active=false(peer or up exit)"; break; }
                let mut got = false;
                // 从常驻接收线程投递的队列取数据
                loop {
                    let item = {
                    let r = down_queue.lock().unwrap().pop(conn_id);
                    if let Some(ref d) = r {
                        use std::sync::atomic::Ordering as DO;
                        let pn = DIAG_HUB_POP.fetch_add(1, DO::Relaxed);
                        if d.len() > 1100 || pn < 20 {
                            println!("  [DIAG] HUB_POP#{}: {}B conn={}",
                                pn, d.len(), conn_id);
                        }
                    }
                    r
                };
                    match item {
                        Some(data) => {
                            if data.is_empty() { continue; }
                            if let Err(e) = stream.write_all(&data) {
                                println!("  [conn#{}] DOWN_WRITE_ERR: {} kind={:?} written_so_far≈{}B",
                                    conn_id, e, e.kind(),
                                    down_queue.lock().unwrap().take_counters(conn_id).1);
                                exit_reason = "tcp_write_err";
                                break 'down_loop;
                            }
                            *last_write.lock().unwrap() = std::time::Instant::now();
                            got = true;
                        }
                        None => break,
                    }
                }
                if !got { thread::sleep(Duration::from_millis(1)); }
                // STREAM_END(stream) 优雅关闭：该流队列排空即退出（不丢已到达的数据），
                // 同时 up 侧也不再需要——对端服务已关，上行无意义。
                // （per-stream ended 标记取代旧隧道级共享标志：多连接并发时
                //   一条连接的关闭信号不得影响其它连接——R12 Phase A 的另一半）
                if down_queue.lock().unwrap().is_ended(conn_id) {
                    let pending = down_queue.lock().unwrap().pending(conn_id);
                    if pending == 0 {
                        tracelog!("[conn#{}] STREAM_END drained, closing", conn_id);
                        // 排空：down 主动退出 + 通知 up 一起退
                        down_active.store(false, Ordering::Relaxed);
                        exit_reason = "stream_end_drained";
                        break;
                    }
                    // 队列还有数据：继续排（不等 conn_active）
                }
            }
            println!("  [conn#{}] DOWN_EXIT reason={} down_bytes_at_exit={}",
                conn_id, exit_reason,
                down_queue.lock().unwrap().take_counters(conn_id).1);
            down_active.store(false, Ordering::Relaxed);
        });

        let _ = up.join();
        // 坏包观测：up 线程退出 → 立即杀 down 线程 → 数据截断根因定位
        println!("  [conn#{}] UP_EXIT half_closed={}",
            conn_id, half_closed.load(Ordering::Relaxed));
        // 半关闭语义：本端可能只是 SHUT_WR（如 nc/curl 发完请求就关写端），
        // 仍须把在途响应排空再关连接。
        // 关键：只有「半关闭」才 drain；对端完全关闭时立即释放，否则会阻塞下一次 accept。
        // drain 上限只需覆盖一个正常往返（60ms 足够），
        // 用 400ms 会让「发请求→收响应→关闭」的客户端在关闭时白等，串行压测下延迟飙到 157ms。
        let up_closed_at = std::time::Instant::now();
        let queue_for_drain = self.hub.clone();
        if half_closed.load(Ordering::Relaxed) {
            loop {
                let pending = queue_for_drain.lock().unwrap().pending(conn_id) > 0;
                let wrote = *last_write_obs.lock().unwrap() > up_closed_at;
                let elapsed = up_closed_at.elapsed();
                if !down_active_obs.load(Ordering::Relaxed) { break; }
                if !pending && wrote { break; }                        // 响应已交付
                if !pending && elapsed > Duration::from_millis(60) { break; }
                if elapsed > Duration::from_millis(250) { break; }
                thread::sleep(Duration::from_millis(2));
            }
        }
        conn_active.store(false, Ordering::Relaxed);
        let _ = down.join();
        // Phase 1 注销：sid → 开关映射必须在 hub unregister **之前**移除，并用
        // Arc 身份核对——u16 sid 会环绕复用，若晚于 unregister，新连接恰好在
        // 这一瞬注册了同号 sid，会被这里的清理误删（表现为新流无法被按流终结）。
        {
            let mut sf = self.stream_flags.lock().unwrap();
            if sf.get(&conn_id).map_or(false, |f| Arc::ptr_eq(f, &conn_active)) {
                sf.remove(&conn_id);
            }
        }
        let (up_total, down_total) = hub_down.lock().unwrap().take_counters(conn_id);
        hub_down.lock().unwrap().unregister(conn_id);
        // 债 2：流已终结，注销 forward 归属（幂等：legacy 流本来就没登记）
        self.mf_stream_targets.lock().unwrap().remove(&conn_id);
        self.conn_flags.lock().unwrap().remove(&flag_key);
        // 每连接一行双向计数：走一遍就能回答「上行发了多少、下行回了多少、断在哪半边」
        tracelog!("[conn#{}] CLOSE half_closed={} up={}B down={}B", conn_id,
                  half_closed.load(Ordering::Relaxed), up_total, down_total);
        println!("  [<<] Connection closed");
    }
}

/// Server mode
pub fn start_server(relay_addr: &str, peer_id: u32, target_port: u16) -> anyhow::Result<std::sync::Arc<AtomicBool>> {
    start_server_with_secret(relay_addr, peer_id, target_port, None)
}

pub fn start_server_with_secret(
    relay_addr: &str,
    peer_id: u32,
    target_port: u16,
    secret: Option<&str>,
) -> anyhow::Result<std::sync::Arc<AtomicBool>> {
    start_server_full(relay_addr, peer_id, target_port, secret, None)
}

/// 宿主可显式指定 P2P 监听端口（多实例时避免抢 9100；被占自动回落随机口并公告真实端口）
pub fn start_server_full(
    relay_addr: &str,
    peer_id: u32,
    target_port: u16,
    secret: Option<&str>,
    preferred_p2p_port: Option<u16>,
) -> anyhow::Result<std::sync::Arc<AtomicBool>> {
    // 同进程 peer_id 冲突防护（与 client 同款）
    peer_id_try_acquire(peer_id)?;
    // 同进程 server target_port 重叠检测（embedding 竞态防护）
    server_port_register(peer_id, target_port);
    // 同机跨进程占位（与 client 同款）：新进程接管 → 旧进程退位，不互抢映射。
    let claim = PeerClaim::steal(&std::env::temp_dir(), peer_id, "server");
    crate::fwcheck::spawn_check();

    let crypto = secret.map(|s| {
        use crate::crypto::{Role, SessionCrypto};
        SessionCrypto::new(&SessionCrypto::key_from_secret(s), Role::Server)
    });
    let encrypted = crypto.is_some();
    let relay = Arc::new(RelayClient::with_crypto(relay_addr, peer_id, crypto, secret)?);
    {
            let mut retry_delay = Duration::from_secs(1);
            loop {
                match relay.register() {
                    Ok(()) => break,
                    Err(e) => {
                        eprintln!("  [SRV] relay register failed: {:#} — retry in {:?}", e, retry_delay);
                        if retry_delay >= Duration::from_secs(30) {
                            return Err(e);
                        }
                        thread::sleep(retry_delay);
                        retry_delay *= 2;
                    }
                }
            }
        }
    if encrypted {
        println!("  [OK] End-to-end encryption: AES-256-GCM (PSK)");
    } else {
        println!("  [!!] WARNING: no --secret given, tunnel data is PLAINTEXT");
    }
    println!("  [OK] Server peer {} registered, target=127.0.0.1:{}", peer_id, target_port);


    // 通告 STUN 发现的公网出口 IP（多出口 ISP 场景必需）
    // Rendezvous：服务端先绑监听 socket，用「它自己」STUN 学出公网映射并公告，
    // 而不是用 relay socket 的出口（那个端口对监听端口无效，对端连不上）。
    let p2p_port: u16 = preferred_p2p_port
        .or_else(|| std::env::var("VNET_P2P_PORT").ok().and_then(|v| v.parse().ok()))
        .unwrap_or(9100);
    let p2p_v4 = UdpSocket::bind(format!("0.0.0.0:{}", p2p_port))
        .or_else(|_| UdpSocket::bind("0.0.0.0:0"))?;
    // 直连 socket 缓冲随窗口配套（同 v6/relay socket；理由见 bind_v6_only）
    crate::relay::apply_tunable_buffers(&p2p_v4);
    p2p_v4.set_nonblocking(true)?;
    {
        let mut announced_ok = false;
        for srv in ["stun.chat.bilibili.com:3478", "stun.hitv.com:3478", "stun.miwifi.com:3478"] {
            if let Ok(pubaddr) = crate::stun::query_stun_on_socket(srv, &p2p_v4) {
                let _ = relay.announce_ipv4(&pubaddr.to_string());
                println!("  [RDV] Server listen {} -> public {}, announced",
                    p2p_v4.local_addr().map(|a| a.port()).unwrap_or(0), pubaddr);
                announced_ok = true;
                break;
            }
        }
        if !announced_ok { println!("  [RDV] WARN: server listen STUN failed"); }
    }

    let running = Arc::new(AtomicBool::new(true));

    // server 侧本机网络画像：与 client 对称，周期感知 + 公告，让对端不再靠 default 猜。
    // 能力公告（task.md §11 H.2）：targeted SESSION_START 的 server 半已落地（21197f08），
    // 本端 server 恒支持 multi_forward → 公告 caps bit0；version 置 1 保证首个公告就能被
    // 对端 parse_announce_extra 接受（v=0 会被当作格式错误拒收，client 将学不到 caps）。
    let mut init_ns = crate::netstatus::NetStatus::default();
    init_ns.caps = crate::netstatus::CAP_MULTI_FORWARD;
    init_ns.version = 1;
    let srv_ns = Arc::new(std::sync::Mutex::new(init_ns));
    let ka = relay.clone();
    let ka_run = running.clone();
    let ka_ns = srv_ns.clone();
    let ka_peer = peer_id;
    let mut claim = claim;
    thread::spawn(move || {
        let mut sense_at = std::time::Instant::now() - Duration::from_secs(10);
        while ka_run.load(Ordering::Relaxed) {
            // 同机 peer_id 占位体检（与 client 同款）：被新进程接管 → 退位。
            if claim.poll() == ClaimPoll::Superseded {
                println!("  [SUPERSEDED] server peer_id {} taken over by another live process — yielding",
                    ka_peer);
                ka_run.store(false, Ordering::Relaxed);
                ka.unregister();
                peer_id_release(ka_peer);
                break;
            }
            ka.keepalive();
            // 与 client 相同：周期续租，relay 服务重启后自动恢复映射。
            ka.renew_registration();
            // 周期感知本机网络并公告 NetStatus（对端靠它做选路/直连可行性判断）
            if sense_at.elapsed() >= Duration::from_secs(5) {
                sense_at = std::time::Instant::now();
                let mut ns = ka_ns.lock().unwrap();
                let new_v6 = get_my_ipv6();
                let (new_if, new_cost) = probe_default_if_status();
                if new_v6 != ns.ipv6 || new_if != ns.if_type || new_cost != ns.if_cost {
                    ns.ipv6 = new_v6;
                    ns.if_type = new_if;
                    ns.if_cost = new_cost;
                    ns.version += 1;
                    ns.sensed_at = std::time::Instant::now();
                }
                let ns_str = ns.to_announce_extra();
                let _ = ka.announce_netstatus(ns_str.trim());
            }
            thread::sleep(Duration::from_secs(5));
        }
    });

    let p2p_v4 = Arc::new(p2p_v4);
    let p2p_v4_sec = relay.clone();
    let p2p_v4_run = running.clone();
    let p2p_v4_port = target_port;
    let p2p_v4_rx = p2p_v4.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 65536];
        let p2p_v4_tx = p2p_v4_rx.clone();
        // 多对端（与 v6 处理线程同构）：每个对端独立的 ARQ 流 + per-stream 上游集。
        struct PeerConn4 {
            stream: crate::tunnel::TunnelStream,
            streams: std::collections::HashMap<u16, TcpStream>,
            last_activity: std::time::Instant,
            /// per-peer 新建流限速（与 relay 路径同款安全网）
            conn_rate: ConnRate,
            /// 对端会话代际（P2P 会话公告驱动）；变化 = 旧流全废，必须清 streams
            session_gen: u64,
            /// 连接级认证结果（identity.rs；None = 未验证）
            auth: Option<crate::identity::PeerIdentity>,
            auth_at: Option<std::time::Instant>,
        }
        let mut peers: std::collections::HashMap<std::net::SocketAddr, PeerConn4> =
            std::collections::HashMap::new();
        while p2p_v4_run.load(Ordering::Relaxed) {
            // 与 v6 同：忙时不再固定睡 1ms（relay 主循环 1434fea7 的同一修法）
            let mut did_work = false;
            if let Ok((len, remote)) = p2p_v4_rx.recv_from(&mut buf) {
                did_work = true;
                // 先验签再解析（明文探测包带 HMAC 尾）
                let is_probe = if let Some(body_p) = p2p_v4_sec.verify_probe(&buf[..len]) {
                    if let Some((ptype, nonce_p, ts)) = crate::probe::parse_probe_full(body_p) {
                        if ptype == crate::probe::PROBE_TYPE_REQUEST {
                            let reply = p2p_v4_sec.sign_probe(
                                &crate::probe::build_probe_reply(nonce_p, ts));
                            let _ = p2p_v4_rx.send_to(&reply, remote);
                        }
                        true
                    } else { false }
                } else { false };
                if is_probe {
                    // 探测包，已处理
                } else if len > 0 {
                    {
                        use std::sync::atomic::{AtomicU64, Ordering as O3};
                        static DBG: AtomicU64 = AtomicU64::new(0);
                        let dk = DBG.fetch_add(1, O3::Relaxed);
                        if dk < 10 {
                            println!("  [DBG-FIX] srv v4 rx {}B from {}", len, remote);
                        }
                    }
                    let entry = peers.entry(remote).or_insert_with(|| PeerConn4 {
                        stream: crate::tunnel::TunnelStream::new(
                            p2p_v4_tx.clone(), remote, p2p_v4_sec.crypto_arc()),
                        streams: std::collections::HashMap::new(),
                        last_activity: std::time::Instant::now(),
                        conn_rate: ConnRate::new(),
                        session_gen: 0,
                        auth: None,
                        auth_at: None,
                    });
                    {
                        use std::sync::atomic::Ordering as DO;
                        let rn = DIAG_RX.fetch_add(1, DO::Relaxed);
                        if len > 1300 || rn < 30 {
                            let (s, a, r) = entry.stream.stats();
                            println!("  [DIAG-SRV] RX#{}: {}B sent={} acked={} retr={} t={}",
                                rn, len, s, a, r,
                                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() % 100000);
                        }
                    }
                    let delivered = entry.stream.on_packet(&buf[..len]);
                    if !delivered.is_empty() {
                        let n: usize = delivered.iter().map(|d| d.len()).sum();
                        SRV_P2P_RX_BYTES.fetch_add(n as u64, Ordering::Relaxed);
                    }
                    // 对端进程换代（P2P 会话公告 TYPE_SESSION）：旧会话的上游流全废。
                    // 不清这张表的话，新会话复用同一 stream id 会被路由到已死的 TcpStream。
                    {
                        let gen_now = entry.stream.session_generation();
                        if gen_now != entry.session_gen {
                            entry.session_gen = gen_now;
                            let cleared = entry.streams.len();
                            entry.streams.clear();
                            println!("  [srv] P2P session reset: cleared {} peer streams", cleared);
                        }
                    }
                    for plain in delivered {
                        // verify 标记（同 v6：先于流解复用，原样回显）
                        if plain.as_slice() == P2P_VERIFY_TAG {
                            let _ = entry.stream.send(&plain);
                            entry.last_activity = std::time::Instant::now();
                            continue;
                        }
                        let t = format!("127.0.0.1:{}", p2p_v4_port);
                        // phase 2：与 relay/v6 同构的按流分发；X.224 启发式退役
                        match crate::transport::parse_stream_frame(&plain) {
                            Some((crate::identity::STREAM_TAG_AUTH, _, rest)) => {
                                srv_handle_auth(crate::identity::STREAM_TAG_AUTH, rest,
                                    peer_id, None, &mut entry.auth, &mut entry.auth_at);
                                entry.last_activity = std::time::Instant::now();
                                continue;
                            }
                            Some((crate::transport::STREAM_TAG_SESSION_START, sid, ssp)) => {
                                // multi-forward：载荷可指定上游端口（白名单内），空载荷=legacy
                                let tgt = match mf_resolve_target(ssp, p2p_v4_port) {
                                    Ok(p) => p,
                                    Err(reason) => {
                                        tracelog!("[srv] {} peer={} stream={} -> STREAM_END (multi-forward, P2P-v4)",
                                            reason, remote, sid);
                                        let frame = crate::transport::wrap_stream_frame(
                                            crate::transport::STREAM_TAG_STREAM_END, sid, reason.as_bytes());
                                        let _ = entry.stream.send(&frame);
                                        entry.last_activity = std::time::Instant::now();
                                        continue;
                                    }
                                };
                                // 身份闸门（H.3.1）
                                let ident = match srv_auth_gate(&entry.auth, &entry.auth_at, tgt, "p2p-v4") {
                                    Ok(i) => i,
                                    Err(reason) => {
                                        tracelog!("[srv] {} peer={} stream={} -> STREAM_END (auth gate, P2P-v4)",
                                            reason, remote, sid);
                                        let frame = crate::transport::wrap_stream_frame(
                                            crate::transport::STREAM_TAG_STREAM_END, sid, reason.as_bytes());
                                        let _ = entry.stream.send(&frame);
                                        entry.last_activity = std::time::Instant::now();
                                        continue;
                                    }
                                };
                                let t = format!("127.0.0.1:{}", tgt);
                                if !entry.streams.contains_key(&sid) {
                                    if !entry.conn_rate.allow() {
                                        tracelog!("[srv] RATE-LIMIT peer={} stream={} -> STREAM_END (P2P-v4 conn flood guard)",
                                            remote, sid);
                                        let frame = crate::transport::wrap_stream_frame(
                                            crate::transport::STREAM_TAG_STREAM_END, sid, &[]);
                                        let _ = entry.stream.send(&frame);
                                        entry.last_activity = std::time::Instant::now();
                                        continue;
                                    }
                                    // 方案 A（H.3.2）：PeerListener 直交接管（同 relay 路径）
                                    match crate::peer_listener::take_upstream(ident.as_ref(), tgt, "p2p-v4") {
                                        Ok(Some(tcp)) => {
                                            tracelog!("[srv] STREAM_OPEN peer={} stream={} -> PL:{} (direct hand-off, P2P-v4)",
                                                remote, sid, tgt);
                                            note_p2p_inbound(&remote);
                                            entry.streams.insert(sid, tcp);
                                        }
                                        Err(reason) => {
                                            tracelog!("[srv] {} peer={} stream={} -> STREAM_END (peer-listener, P2P-v4)",
                                                reason, remote, sid);
                                            let frame = crate::transport::wrap_stream_frame(
                                                crate::transport::STREAM_TAG_STREAM_END, sid, reason.as_bytes());
                                            let _ = entry.stream.send(&frame);
                                        }
                                        Ok(None) => match TcpStream::connect(&t) {
                                            Ok(tcp) => {
                                                tcp.set_nonblocking(true).ok();
                                                if let Some(id) = &ident {
                                                    if crate::identity::vnetp_enabled_for(tgt) {
                                                        let _ = (&tcp).write_all(&crate::identity::vnetp_preamble(id));
                                                    }
                                                }
                                                tracelog!("[srv] STREAM_OPEN peer={} stream={} -> {} OK (P2P-v4)",
                                                    remote, sid, t);
                                                note_p2p_inbound(&remote);
                                                entry.streams.insert(sid, tcp);
                                            }
                                            Err(e) => {
                                                tracelog!("[srv] STREAM_OPEN peer={} stream={} -> {} FAIL {} (P2P-v4)",
                                                    remote, sid, t, e);
                                                let frame = crate::transport::wrap_stream_frame(
                                                    crate::transport::STREAM_TAG_STREAM_END, sid, &[]);
                                                let _ = entry.stream.send(&frame);
                                            }
                                        },
                                    }
                                }
                            }
                            Some((crate::transport::STREAM_TAG_DATA, sid, rest)) => {
                                if let Some(st) = entry.streams.get_mut(&sid) {
                                    let _ = st.write_all(&rest);
                                } else {
                                    // P0 修复（同 relay 路径）：未知 sid 的 DATA 绝不补开
                                    // 默认上游——那会绕过 multi-forward 白名单与身份闸门。
                                    tracelog!("[srv] DATA_UNKNOWN_STREAM peer={} stream={} -> STREAM_END (no on-data reopen, P2P-v4)",
                                        remote, sid);
                                    let frame = crate::transport::wrap_stream_frame(
                                        crate::transport::STREAM_TAG_STREAM_END, sid, b"STREAM_NOT_OPEN");
                                    let _ = entry.stream.send(&frame);
                                    entry.last_activity = std::time::Instant::now();
                                }
                            }
                            Some((crate::transport::STREAM_TAG_FIN, sid, _)) => {
                                if let Some(tcp) = entry.streams.get_mut(&sid) {
                                    let _ = tcp.shutdown(std::net::Shutdown::Write);
                                    tracelog!("[srv] STREAM_FIN peer={} stream={} -> upstream half-closed (P2P-v4)",
                                        remote, sid);
                                }
                            }
                            Some((tag, sid, _)) => {
                                println!("  [srv] unexpected P2P-v4 frame tag={} stream={} peer={}", tag, sid, remote);
                            }
                            None => {
                                if let Some(st) = entry.streams.get_mut(&0) {
                                    let _ = st.write_all(&plain);
                                } else if let Ok(mut tcp) = TcpStream::connect(&t) {
                                    tcp.set_nonblocking(true).ok();
                                    note_p2p_inbound(&remote);
                                    let _ = tcp.write_all(&plain);
                                    entry.streams.insert(0, tcp);
                                }
                            }
                        }
                        entry.last_activity = std::time::Instant::now();
                    }
                }
            }
            for pc in peers.values_mut() {
                pc.stream.tick();
                let sids: Vec<u16> = pc.streams.keys().copied().collect();
                for sid in sids {
                    let mut rb = [0u8; 65536];
                    let step = {
                        let Some(tcp) = pc.streams.get_mut(&sid) else { continue };
                        match tcp.read(&mut rb) {
                            Ok(0) => 1,
                            Ok(n) => {
                                // 同 v6：先切块再包装，一帧一块（块间不重组）
                                for chunk in rb[..n].chunks(stream_chunk()) {
                                    let frame = crate::transport::wrap_stream_frame(
                                        crate::transport::STREAM_TAG_DATA, sid, chunk);
                                    pc.stream.send(&frame).ok();
                                }
                                0
                            }
                            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => 2,
                            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => 2,
                            Err(_) => 1,
                        }
                    };
                    if step == 0 {
                        pc.last_activity = std::time::Instant::now();
                        did_work = true;
                    } else if step == 1 {
                        pc.streams.remove(&sid);
                        let frame = crate::transport::wrap_stream_frame(
                            crate::transport::STREAM_TAG_STREAM_END, sid, &[]);
                        let _ = pc.stream.send(&frame);
                        tracelog!("[srv] STREAM_END peer stream={} (P2P-v4)", sid);
                    }
                }
            }
            if !did_work { thread::sleep(Duration::from_millis(1)); }
        }
    });

    let p2p_v6_sec = relay.clone();
    // 多实例：9100 被占时回退随机口；公告用实际端口（get_my_ipv6 写死 9100 不能直接用）
    let p2p_v6 = Arc::new(bind_v6_only(p2p_port)
        .or_else(|| bind_v6_only(0))
        .ok_or_else(|| anyhow::anyhow!("bind [::]:{} (v6) failed", p2p_port))?);
    {
        let port = p2p_v6.local_addr().map(|a| a.port()).unwrap_or(9100);
        let ip_str = std::env::var("VNET_ANNOUNCE_V6").ok().filter(|s| !s.is_empty())
            .or_else(|| get_my_ipv6().map(|a| a.ip().to_string()))
            .filter(|ip| !ip.is_empty() && ip != "::" && ip != "0:0:0:0:0:0:0:0");
        if let Some(ip) = ip_str {
            let s = if ip.contains(']') { ip.clone() } else { format!("[{}]:{}", ip, port) };
            let _ = relay.announce_ipv6(&s);
            println!("  [OK] Announced IPv6: {}", s);
        }
    }
    // 打洞线程也必须从 :9100 发 v6 探测（见打洞线程内注释），提前克隆
    let punch_v6_listen = p2p_v6.clone();
    p2p_v6.set_nonblocking(true)?;
    let p2p_v6_run = running.clone();
    let p2p_v6_port = target_port;
    thread::spawn(move || {
        let mut buf = [0u8; 65536];
        let p2p_v6_tx = p2p_v6.clone();
        // 多对端：每个对端独立的 ARQ 流 + 独立的 per-stream upstream 集。
        // 产品形态就是多设备（手机+笔记本）同时连一台 PC——原来的单对端假设
        // 会把后来的对端塞进先来者的流（序号错乱、回包发错人，实测 0/50）。
        // phase 2：对端连接多路复用（内层帧 [tag][stream:2]），与 relay 路径
        // 同构；X.224 启发式与 10s 空闲重置随单流语义一并退役。
        struct PeerConn {
            stream: crate::tunnel::TunnelStream,
            streams: std::collections::HashMap<u16, TcpStream>,
            last_activity: std::time::Instant,
            /// per-peer 新建流限速（与 relay 路径同款安全网）
            conn_rate: ConnRate,
            /// 对端会话代际（P2P 会话公告驱动）；变化 = 旧流全废，必须清 streams
            session_gen: u64,
            /// 连接级认证结果（identity.rs；None = 未验证）
            auth: Option<crate::identity::PeerIdentity>,
            auth_at: Option<std::time::Instant>,
        }
        let mut peers: std::collections::HashMap<std::net::SocketAddr, PeerConn> =
            std::collections::HashMap::new();
        let perf_v6 = std::env::var("VNET_PERF").unwrap_or_default() == "1";
        let mut perf_v6_at = std::time::Instant::now();
        while p2p_v6_run.load(Ordering::Relaxed) {
            // 忙时不再固定睡 1ms：与 relay 主循环同一修法（1434fea7）。
            // 每包固定睡 1ms 会把窗口循环钉在 ~50ms（32 帧/窗），512KB 实测 1470ms。
            let mut did_work = false;
            if let Ok((len, remote)) = p2p_v6.recv_from(&mut buf) {
                did_work = true;
                let is_probe = if let Some((ptype, nonce, ts)) =
                    crate::probe::parse_probe_full(&buf[..len])
                {
                    if ptype == crate::probe::PROBE_TYPE_REQUEST {
                        let reply = p2p_v6_sec.sign_probe(
                            &crate::probe::build_probe_reply(nonce, ts));
                        let _ = p2p_v6.send_to(&reply, remote);
                    }
                    true
                } else { false };
                if is_probe {
                    // 探测包，已处理
                } else if len > 0 {
                    {
                        use std::sync::atomic::{AtomicU64, Ordering as O3};
                        static DBG: AtomicU64 = AtomicU64::new(0);
                        let dk = DBG.fetch_add(1, O3::Relaxed);
                        if dk < 10 {
                            println!("  [DBG-FIX] srv v6 rx {}B from {}", len, remote);
                        }
                    }
                    let entry = peers.entry(remote).or_insert_with(|| PeerConn {
                        stream: crate::tunnel::TunnelStream::new(
                            p2p_v6_tx.clone(), remote, p2p_v6_sec.crypto_arc()),
                        streams: std::collections::HashMap::new(),
                        last_activity: std::time::Instant::now(),
                        conn_rate: ConnRate::new(),
                        session_gen: 0,
                        auth: None,
                        auth_at: None,
                    });
                    if diag_hot() {
                        use std::sync::atomic::Ordering as DO;
                        let rn = DIAG_RX.fetch_add(1, DO::Relaxed);
                        let (exp_next, ooo, dup) = entry.stream.receiver_stats();
                        println!("  [DIAG-V6] RX#{}: {}B exp_next={} ooo={} dup={} t={}",
                            rn, len, exp_next, ooo, dup,
                            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() % 100000);
                    }
                    let delivered = entry.stream.on_packet(&buf[..len]);
                    if !delivered.is_empty() {
                        let n: usize = delivered.iter().map(|d| d.len()).sum();
                        SRV_P2P_RX_BYTES.fetch_add(n as u64, Ordering::Relaxed);
                    }
                    // 对端进程换代（P2P 会话公告 TYPE_SESSION）：旧会话的上游流全废。
                    {
                        let gen_now = entry.stream.session_generation();
                        if gen_now != entry.session_gen {
                            entry.session_gen = gen_now;
                            let cleared = entry.streams.len();
                            entry.streams.clear();
                            println!("  [srv] P2P session reset: cleared {} peer streams", cleared);
                        }
                    }
                    for plain in delivered {
                        // verify 标记字节（VNETVRF1）先于流解复用处理：它是通道
                        // 验证握手的载荷不是应用帧（phase 2 之前 tag=86 噪声来源）。
                        // 原样经同一 TunnelStream 回显 → client 侧确认通道双向可用。
                        if plain.as_slice() == P2P_VERIFY_TAG {
                            let _ = entry.stream.send(&plain);
                            entry.last_activity = std::time::Instant::now();
                            continue;
                        }
                        let t = format!("127.0.0.1:{}", p2p_v6_port);
                        match crate::transport::parse_stream_frame(&plain) {
                            Some((crate::identity::STREAM_TAG_AUTH, _, rest)) => {
                                srv_handle_auth(crate::identity::STREAM_TAG_AUTH, rest,
                                    peer_id, None, &mut entry.auth, &mut entry.auth_at);
                                entry.last_activity = std::time::Instant::now();
                                continue;
                            }
                            Some((crate::transport::STREAM_TAG_SESSION_START, sid, ssp)) => {
                                // multi-forward：载荷可指定上游端口（白名单内），空载荷=legacy
                                let tgt = match mf_resolve_target(ssp, p2p_v6_port) {
                                    Ok(p) => p,
                                    Err(reason) => {
                                        tracelog!("[srv] {} peer={} stream={} -> STREAM_END (multi-forward, P2P-v6)",
                                            reason, remote, sid);
                                        let frame = crate::transport::wrap_stream_frame(
                                            crate::transport::STREAM_TAG_STREAM_END, sid, reason.as_bytes());
                                        let _ = entry.stream.send(&frame);
                                        entry.last_activity = std::time::Instant::now();
                                        continue;
                                    }
                                };
                                // 身份闸门（H.3.1）
                                let ident = match srv_auth_gate(&entry.auth, &entry.auth_at, tgt, "p2p-v6") {
                                    Ok(i) => i,
                                    Err(reason) => {
                                        tracelog!("[srv] {} peer={} stream={} -> STREAM_END (auth gate, P2P-v6)",
                                            reason, remote, sid);
                                        let frame = crate::transport::wrap_stream_frame(
                                            crate::transport::STREAM_TAG_STREAM_END, sid, reason.as_bytes());
                                        let _ = entry.stream.send(&frame);
                                        entry.last_activity = std::time::Instant::now();
                                        continue;
                                    }
                                };
                                let t = format!("127.0.0.1:{}", tgt);
                                if !entry.streams.contains_key(&sid) {
                                    if !entry.conn_rate.allow() {
                                        tracelog!("[srv] RATE-LIMIT peer={} stream={} -> STREAM_END (P2P-v6 conn flood guard)",
                                            remote, sid);
                                        let frame = crate::transport::wrap_stream_frame(
                                            crate::transport::STREAM_TAG_STREAM_END, sid, &[]);
                                        let _ = entry.stream.send(&frame);
                                        entry.last_activity = std::time::Instant::now();
                                        continue;
                                    }
                                    // 方案 A（H.3.2）：PeerListener 直交接管（同 relay 路径）
                                    match crate::peer_listener::take_upstream(ident.as_ref(), tgt, "p2p-v6") {
                                        Ok(Some(tcp)) => {
                                            tracelog!("[srv] STREAM_OPEN peer={} stream={} -> PL:{} (direct hand-off, P2P-v6)",
                                                remote, sid, tgt);
                                            note_p2p_inbound(&remote);
                                            entry.streams.insert(sid, tcp);
                                        }
                                        Err(reason) => {
                                            tracelog!("[srv] {} peer={} stream={} -> STREAM_END (peer-listener, P2P-v6)",
                                                reason, remote, sid);
                                            let frame = crate::transport::wrap_stream_frame(
                                                crate::transport::STREAM_TAG_STREAM_END, sid, reason.as_bytes());
                                            let _ = entry.stream.send(&frame);
                                        }
                                        Ok(None) => match TcpStream::connect(&t) {
                                            Ok(tcp) => {
                                                tcp.set_nonblocking(true).ok();
                                                if let Some(id) = &ident {
                                                    if crate::identity::vnetp_enabled_for(tgt) {
                                                        let _ = (&tcp).write_all(&crate::identity::vnetp_preamble(id));
                                                    }
                                                }
                                                tracelog!("[srv] STREAM_OPEN peer={} stream={} -> {} OK (P2P-v6)",
                                                    remote, sid, t);
                                                note_p2p_inbound(&remote);
                                                entry.streams.insert(sid, tcp);
                                            }
                                            Err(e) => {
                                                tracelog!("[srv] STREAM_OPEN peer={} stream={} -> {} FAIL {} (P2P-v6)",
                                                    remote, sid, t, e);
                                                // 目标不可达：显式终结该流（G6），不静默挂起
                                                let frame = crate::transport::wrap_stream_frame(
                                                    crate::transport::STREAM_TAG_STREAM_END, sid, &[]);
                                                let _ = entry.stream.send(&frame);
                                            }
                                        },
                                    }
                                }
                            }
                            Some((crate::transport::STREAM_TAG_DATA, sid, rest)) => {
                                if let Some(st) = entry.streams.get_mut(&sid) {
                                    let _ = st.write_all(&rest);
                                } else {
                                    // P0 修复（同 relay 路径）：未知 sid 的 DATA 绝不补开
                                    // 默认上游——那会绕过 multi-forward 白名单与身份闸门。
                                    tracelog!("[srv] DATA_UNKNOWN_STREAM peer={} stream={} -> STREAM_END (no on-data reopen, P2P-v6)",
                                        remote, sid);
                                    let frame = crate::transport::wrap_stream_frame(
                                        crate::transport::STREAM_TAG_STREAM_END, sid, b"STREAM_NOT_OPEN");
                                    let _ = entry.stream.send(&frame);
                                    entry.last_activity = std::time::Instant::now();
                                }
                            }
                            Some((crate::transport::STREAM_TAG_FIN, sid, _)) => {
                                if let Some(tcp) = entry.streams.get_mut(&sid) {
                                    let _ = tcp.shutdown(std::net::Shutdown::Write);
                                    tracelog!("[srv] STREAM_FIN peer={} stream={} -> upstream half-closed (P2P-v6)",
                                        remote, sid);
                                }
                            }
                            Some((tag, sid, _)) => {
                                println!("  [srv] unexpected P2P-v6 frame tag={} stream={} peer={}", tag, sid, remote);
                            }
                            None => {
                                // 旧版本对端（无内层帧）：回落 stream 0 兼容（单连接）
                                if let Some(st) = entry.streams.get_mut(&0) {
                                    let _ = st.write_all(&plain);
                                } else if let Ok(mut tcp) = TcpStream::connect(&t) {
                                    tcp.set_nonblocking(true).ok();
                                    note_p2p_inbound(&remote);
                                    let _ = tcp.write_all(&plain);
                                    entry.streams.insert(0, tcp);
                                }
                            }
                        }
                        entry.last_activity = std::time::Instant::now();
                    }
                }
            }
            // 每个对端独立：ARQ 重传 + per-stream 上游读 + 按流回发（不会串）
            for (addr, pc) in peers.iter_mut() {
                pc.stream.tick();
                let sids: Vec<u16> = pc.streams.keys().copied().collect();
                for sid in sids {
                    let mut rb = [0u8; 16384]; // 16KB: ~15帧/轮，避免60帧突发
                    let step = {
                        let Some(tcp) = pc.streams.get_mut(&sid) else { continue };
                        match tcp.read(&mut rb) {
                            Ok(0) => 1,
                            Ok(n) => {
                                // 先按 stream_chunk() 切块再包装：每帧 ≤1003B <
                                // TunnelStream 分块 1100，一帧一块，接收端逐块
                                // 交付即整帧（块间不重组，整读包一帧会被拆坏）。
                                for chunk in rb[..n].chunks(stream_chunk()) {
                                    let frame = crate::transport::wrap_stream_frame(
                                        crate::transport::STREAM_TAG_DATA, sid, chunk);
                                    pc.stream.send(&frame).ok();
                                }
                                0
                            }
                            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => 2,
                            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => 2,
                            Err(_) => 1,
                        }
                    };
                    if step == 0 {
                        pc.last_activity = std::time::Instant::now();
                        if diag_hot() { did_work = true; }
                        did_work = true;
                    } else if step == 1 {
                        // 该流 upstream 关闭/出错 → 按流 STREAM_END（排在数据后）
                        pc.streams.remove(&sid);
                        let frame = crate::transport::wrap_stream_frame(
                            crate::transport::STREAM_TAG_STREAM_END, sid, &[]);
                        let _ = pc.stream.send(&frame);
                        tracelog!("[srv] STREAM_END peer={} stream={} (P2P-v6)", addr, sid);
                    }
                }
                // 吞吐/窗口采样（VNET_PERF=1）：inflight 长期顶满 = 窗口受限；
                // retr 增长 = ACK 丢失/超时；pending 堆积 = 上游读快于发。
                if perf_v6 && perf_v6_at.elapsed() >= Duration::from_millis(100) {
                    let (sent, acked, retr) = pc.stream.stats();
                    tracelog!("[perf-p2p] peer={} sent={} acked={} retr={} inflight={} pending={}B",
                        addr, sent, acked, retr, pc.stream.inflight_count(), pc.stream.pending_bytes());
                }
            }
            if perf_v6 && perf_v6_at.elapsed() >= Duration::from_millis(100) {
                perf_v6_at = std::time::Instant::now();
            }
            // 只有整轮完全空闲才睡；有收包/有上行读就立刻下一轮
            if !did_work { thread::sleep(Duration::from_millis(1)); }
        }
    });

    let punch_relay = relay.clone();
    let punch_run = running.clone();
    let peer_id_for_punch = peer_id;
    let punch_v4_listen = p2p_v4.clone();
    // DIAG: VNET_NO_P2P=1 禁用服务端打洞
    if std::env::var("VNET_NO_P2P").unwrap_or_default() != "1" {
    thread::spawn(move || {
        let mut count = 0u64;
        let mut cands: Vec<std::net::SocketAddr> = Vec::new();
        let mut v6_cands: Vec<std::net::SocketAddr> = Vec::new();
        let mut v6_sock: Option<Arc<UdpSocket>> = None;
        let my_id_for_punch = peer_id_for_punch;
        while punch_run.load(Ordering::Relaxed) {
            count += 1;
            // 每 5 轮刷新候选：relay 观察到的 IPv4 + 客户端公告的监听映射 + 客户端 IPv6
            if count % 5 == 0 || cands.is_empty() {
                // 多对端：收集**所有**在线 peer 的候选，不能在第一个查到时就 break——
                // 产品形态是多设备同时连一台 PC，只打第一个会让其余设备永远等不到敲门
                // （实测手机+笔记本并发时笔记本恒走中继的根因）。
                let mut list: Vec<std::net::SocketAddr> = Vec::new();
                let mut v6s: Vec<std::net::SocketAddr> = Vec::new();
                // 配置列表（VNET_PUNCH_PEERS，缺省旧数组）∪ 从数据学到的对端
                let mut targets: Vec<u32> = std::env::var("VNET_PUNCH_PEERS")
                    .ok()
                    .map(|s| s.split(',').filter_map(|x| x.trim().parse().ok()).collect())
                    .unwrap_or_else(|| vec![200u32, 300, 400, 100, 301]);
                for lp in learned_peers().lock().unwrap().iter() {
                    if !targets.contains(lp) { targets.push(*lp); }
                }
                for target in targets {
                    if target == my_id_for_punch { continue; }
                    if let Some((relay_addr, ipv6, announced_v4)) =
                        punch_relay.query_peer_info(target)
                    {
                        if relay_addr.ip().is_ipv4() { list.push(relay_addr); }
                        if let Some(a) = announced_v4 {
                            if a.ip().is_ipv4() && !list.contains(&a) { list.push(a); }
                        }
                        if let Some(a) = ipv6 {
                            if a.is_ipv6() && !v6s.contains(&a) { v6s.push(a); }
                        }
                    }
                }
                if count <= 10 && (!list.is_empty() || !v6s.is_empty()) {
                    println!("  [P2P] all-peer cands={:?} v6={:?}", list, v6s);
                }
                cands = list;
                v6_cands = v6s;
                // 开一个独立 IPv6 socket 用于主动敲门（IPv4 socket 发不出 IPv6 包）

            }
            let pkt = punch_relay.sign_probe(&crate::probe::build_probe_packet(count));
            for t in &cands {
                punch_relay.send_raw_to(&pkt, *t);
                // 关键：还要从「监听 socket」发一次，才能建立它的 NAT 映射，
                // 否则客户端连 公告地址 会被路由器丢弃（映射不存在）。
                match punch_v4_listen.send_to(&pkt, *t) {
                    Ok(n) => {
                        use std::sync::atomic::{AtomicU64, Ordering as O2};
                        static STX: AtomicU64 = AtomicU64::new(0);
                        let k = STX.fetch_add(1, O2::Relaxed);
                        if k < 5 || k % 20 == 0 {
                            println!("  [SRV-TX] {} bytes -> {}", n, t);
                        }
                    }
                    Err(e) => println!("  [SRV-TX] ERR -> {}: {}", t, e),
                }
            }
            // v6 探测必须从 :9100 监听 socket 发，而不是临时端口：
            // 客户端会向「包的源端口」回包——:9100 有现成处理线程能接住回包并承载后续数据；
            // 用临时端口发 = 回包永远没人读（热点场景 3 分钟打不通的根因之一）。
            for t in &v6_cands {
                let _ = punch_v6_listen.send_to(&pkt, *t);
            }
            thread::sleep(Duration::from_millis(punch_cadence_ms(count)));
        }
    });
    }

    let mut last_status = std::time::Instant::now();
    // relay 租约续期节拍（见 status 块内注释：C relay 租约仅 REGISTER 刷新）
    let mut last_reregister = std::time::Instant::now();
    // IPv6 重发现（2026-11-10 手机 P2P 不通根因）：Windows 隐私扩展会轮换 temporary
    // 地址（~24h），server 启动时公告的地址会过期 → 对端探测到不存在的地址。
    // 每 60s 重查本地 IPv6，变化时重新 ANNOUNCE（与 client NETSTAT 对齐）。
    let mut last_v6_check = std::time::Instant::now();
    let mut last_announced_v6: Option<std::net::Ipv6Addr> = None;
    let mut clients_seen: u32 = 0;
    // P2P 直连对端地址（收到 P2pData 时记录，回复走它）
    let mut p2p_reply_addr: Option<std::net::SocketAddr> = None;

    /// relay 路径的 per-peer 会话：每个对端独立下行 ARQ + 每条应用流独立 upstream。
    /// 演进：v1 全局单 active_tcp（任何 peer 的 X.224 都撕掉在服务流）→ v2 per-peer 单
    /// upstream（同 peer 第二条连接仍会撕掉第一条，R12 RED）→ 现行 per-(peer,stream)：
    /// 连接多路复用，SESSION_START/STREAM_END/FIN 全部按流走，互不影响。
    struct SrvStream {
        tcp: Option<TcpStream>,
        /// 观测：写进该流 upstream 的字节（client 上行）
        up_bytes: u64,
        /// 观测：从该流 upstream 读出的字节（client 下行）
        down_bytes: u64,
    }
    impl SrvStream {
        fn new(tcp: Option<TcpStream>) -> Self {
            Self { tcp, up_bytes: 0, down_bytes: 0 }
        }
    }
    struct RelaySession {
        /// 该 peer 的活跃应用流（key = client 分配的 stream id；0 保留给 P2P 入站）
        streams: HashMap<u16, SrvStream>,
        /// 该 peer 专属下行 ARQ（epoch 连续性跨 app 连接保持，与 client 侧一致）
        arq: crate::relay_arq::RelayArq,
        last_seen: std::time::Instant,
        last_down_read: Option<std::time::Instant>,
        /// per-peer 新建流限速（连接洪流安全网；超限 → 显式 STREAM_END 拒绝）
        conn_rate: ConnRate,
        /// 连接级认证结果（identity.rs；None = 未验证）
        auth: Option<crate::identity::PeerIdentity>,
        auth_at: Option<std::time::Instant>,
    }
    let new_session = || RelaySession {
        streams: HashMap::new(),
        arq: crate::relay_arq::RelayArq::new(),
        last_seen: std::time::Instant::now(),
        last_down_read: None,
        conn_rate: ConnRate::new(),
        auth: None,
        auth_at: None,
    };
    // key = relay peer_id；0 = relay-socket 上的 P2P 入站（单流聚合语义，phase 2 前）
    let mut sessions: HashMap<u32, RelaySession> = HashMap::new();

    // ARQ 放弃 → 显式终结受影响流（task.md §6.1-8）：被放弃帧 = 该流字节流
    // 永久缺口，永远无法完整交付。必须对该流补发 STREAM_END 并移除 upstream，
    // 让 client 秒级失败重连；不处理 = client 只能等上层超时才发现流已残缺
    // （真实事故：DSH 网关响应滴流 5s 被上层掐）。stream 已不存在时跳过
    // （Step::Closed 已发过 STREAM_END，幂等不重发）。
    fn terminate_abandoned_streams(s: &mut RelaySession, pid: u32) -> usize {
        let mut n = 0;
        for sid in s.arq.take_abandoned_streams() {
            if s.streams.remove(&sid).is_some() {
                s.arq.send(&crate::transport::wrap_stream_frame(
                    crate::transport::STREAM_TAG_STREAM_END, sid, &[]));
                tracelog!("[srv] STREAM_END peer={} stream={} (arq-lost gap)", pid, sid);
                n += 1;
            }
        }
        n
    }

    let mut down_trace_at = std::time::Instant::now();
    let perf_srv = std::env::var("VNET_PERF").unwrap_or_default() == "1";
    let mut perf_srv_at = std::time::Instant::now();
    while running.load(Ordering::Relaxed) {
        // 本轮是否真的做了数据面工作；忙时不在循环末尾 sleep，避免每包固定停 1ms
        let mut did_work = false;
        // 统一分类接收：中继数据 / P2P 数据 / 探测
        // 控制包（探测）不跳过 TCP 读，继续走下面的读取逻辑
        let (data, from_relay, src_peer) = match relay.try_recv_kind() {
            crate::relay::RecvKind::RelayData(src_peer, d) => {
                p2p_reply_addr = None;
                if src_peer != 0 {
                    learned_peers().lock().unwrap().insert(src_peer);
                }
                did_work = true;
                // relay ARQ（该 peer 专属）：解帧 → 交付 + 回 ACK + 快速重传
                let (deliver, ack_frame, fast_retransmit, epoch_reset) = {
                    let s = sessions.entry(src_peer).or_insert_with(new_session);
                    s.last_seen = std::time::Instant::now();
                    let before = s.arq.recv_epoch();
                    let (deliver, ack, fast) = s.arq.on_packet(&d);
                    let epoch_reset = before.is_some() && s.arq.recv_epoch() != before;
                    (deliver, ack, fast, epoch_reset)
                };
                if let Some(ref ack) = ack_frame {
                    let _ = relay.send_to_peer(src_peer, ack);
                }
                // per-path 字节计数（2026-11-13 DSH 判读：relay_rx_bytes 涨 = 数据真走 relay）
                if !deliver.is_empty() {
                    let n: usize = deliver.iter().map(|d| d.len()).sum();
                    SRV_RELAY_RX_BYTES.fetch_add(n as u64, Ordering::Relaxed);
                }
                for frame in fast_retransmit {
                    let _ = relay.send_to_peer(src_peer, &frame);
                }
                // epoch 变化 = 对端 client 进程换代：旧进程的所有流永不再来，
                // 其 upstream 全部失效（R8 双端重启语义在 server 侧的对应面）
                if epoch_reset {
                    if let Some(s) = sessions.get_mut(&src_peer) {
                        let n = s.streams.len();
                        // 2026-11-10: shutdown old upstreams (up-thread clones keep
                        // them alive after HashMap clear; stale data = corruption)
                        for stream in s.streams.values_mut() {
                            if let Some(ref tcp) = stream.tcp {
                                let _ = tcp.shutdown(std::net::Shutdown::Both);
                            }
                        }
                        s.streams.clear();
                        tracelog!("[srv] EPOCH change peer={} -> shutdown+dropped {} streams", src_peer, n);
                    }
                }
                // 连接多路复用：每个交付项带内层头 [tag][stream:2]，按流分发。
                // 旧单 upstream + X.224 启发式重置是 R12 RED 根因（同 peer 第二条
                // 连接撕掉在服务流），现已由显式流生命周期取代。
                for item in deliver {
                    match crate::transport::parse_stream_frame(&item) {
                        Some((crate::identity::STREAM_TAG_AUTH, _, rest)) => {
                            // 连接级 AUTH（H.3.1）：relay 路径额外校验信封 src_peer
                            let sess = sessions.entry(src_peer).or_insert_with(new_session);
                            srv_handle_auth(crate::identity::STREAM_TAG_AUTH, rest,
                                peer_id, Some(src_peer), &mut sess.auth, &mut sess.auth_at);
                            continue;
                        }
                        Some((crate::transport::STREAM_TAG_SESSION_START, sid, ssp)) => {
                            let s = sessions.entry(src_peer).or_insert_with(new_session);
                            // multi-forward：载荷可指定上游端口（白名单内），空载荷=legacy
                            let tgt = match mf_resolve_target(ssp, target_port) {
                                Ok(p) => p,
                                Err(reason) => {
                                    tracelog!("[srv] {} peer={} stream={} -> STREAM_END (multi-forward, relay)",
                                        reason, src_peer, sid);
                                    let frame = crate::transport::wrap_stream_frame(
                                        crate::transport::STREAM_TAG_STREAM_END, sid, reason.as_bytes());
                                    s.arq.send(&frame);
                                    continue;
                                }
                            };
                            // 身份闸门（H.3.1）：启用认证后未验证/过期/钩子拒绝都显式关流
                            let ident = match srv_auth_gate(&s.auth, &s.auth_at, tgt, "relay") {
                                Ok(i) => i,
                                Err(reason) => {
                                    tracelog!("[srv] {} peer={} stream={} -> STREAM_END (auth gate, relay)",
                                        reason, src_peer, sid);
                                    let frame = crate::transport::wrap_stream_frame(
                                        crate::transport::STREAM_TAG_STREAM_END, sid, reason.as_bytes());
                                    s.arq.send(&frame);
                                    continue;
                                }
                            };
                            let t = format!("127.0.0.1:{}", tgt);
                            if !s.streams.contains_key(&sid) {
                                if !s.conn_rate.allow() {
                                    // 连接洪流安全网：拒绝建流并显式告知该流
                                    // （G6 语义：绝不静默）——client 看到连接即关可重试
                                    tracelog!("[srv] RATE-LIMIT peer={} stream={} -> STREAM_END (conn flood guard)", src_peer, sid);
                                    let frame = crate::transport::wrap_stream_frame(
                                        crate::transport::STREAM_TAG_STREAM_END, sid, &[]);
                                    s.arq.send(&frame);
                                    continue;
                                }
                                // 方案 A（H.3.2）：该口注册了 PeerListener 时不再回连本地上游，
                                // 而是本地 TCP 对直交宿主（(PeerIdentity, TcpStream) 所有权转移），
                                // 隧道侧拿另一端当该流 upstream——泵逻辑零改动，仅换来源。
                                match crate::peer_listener::take_upstream(ident.as_ref(), tgt, "relay") {
                                    Ok(Some(tcp)) => {
                                        tracelog!("[srv] STREAM_OPEN peer={} stream={} -> PL:{} (direct hand-off, relay)",
                                            src_peer, sid, tgt);
                                        s.streams.insert(sid, SrvStream::new(Some(tcp)));
                                    }
                                    Err(reason) => {
                                        tracelog!("[srv] {} peer={} stream={} -> STREAM_END (peer-listener, relay)",
                                            reason, src_peer, sid);
                                        let frame = crate::transport::wrap_stream_frame(
                                            crate::transport::STREAM_TAG_STREAM_END, sid, reason.as_bytes());
                                        s.arq.send(&frame);
                                    }
                                    Ok(None) => match TcpStream::connect(&t) {
                                        Ok(tcp) => {
                                            tcp.set_nonblocking(true).ok();
                                            // VNETP 前导（H.3.2 方案 B）：把可信来源 DID 交给上游 HTTP 入口
                                            if let Some(id) = &ident {
                                                if crate::identity::vnetp_enabled_for(tgt) {
                                                    let _ = (&tcp).write_all(&crate::identity::vnetp_preamble(id));
                                                }
                                            }
                                            tracelog!("[srv] STREAM_OPEN peer={} stream={} -> {} OK",
                                                src_peer, sid, t);
                                            s.streams.insert(sid, SrvStream::new(Some(tcp)));
                                        }
                                        Err(e) => {
                                            // 目标不可达必须显式告知该流（G6），不能静默挂起
                                            tracelog!("[srv] STREAM_OPEN peer={} stream={} -> {} FAIL {}",
                                                src_peer, sid, t, e);
                                            eprintln!("  [!!] upstream connect (stream {}): {}", sid, e);
                                            let frame = crate::transport::wrap_stream_frame(
                                                crate::transport::STREAM_TAG_STREAM_END, sid, &[]);
                                            s.arq.send(&frame);
                                        }
                                    },
                                }
                            }
                        }
                        Some((crate::transport::STREAM_TAG_DATA, sid, rest)) => {
                            let s = sessions.entry(src_peer).or_insert_with(new_session);
                            s.last_seen = std::time::Instant::now();
                            if let Some(st) = s.streams.get_mut(&sid) {
                                if let Some(ref mut tcp) = st.tcp {
                                    let _ = tcp.write_all(rest);
                                    st.up_bytes += rest.len() as u64;
                                }
                            } else {
                                // 2026-11-09 P0（DSH vendor 复核发现）：旧「DATA 按需补开
                                // 默认上游」回退会绕过 multi-forward 白名单与身份闸门——
                                // 被拒/失败的流后续 DATA 落到这里就静默连 server 默认
                                // target（实测 STREAM_OPEN -> 25999 拒绝后 DATA 又开了
                                // 25997）。可靠有序通道上 SESSION_START 必先于 DATA，
                                // 未知 sid 的 DATA 只能是被拒流/换代残留：显式关流。
                                tracelog!("[srv] DATA_UNKNOWN_STREAM peer={} stream={} -> STREAM_END (no on-data reopen)",
                                    src_peer, sid);
                                let frame = crate::transport::wrap_stream_frame(
                                    crate::transport::STREAM_TAG_STREAM_END, sid, b"STREAM_NOT_OPEN");
                                s.arq.send(&frame);
                                continue;
                            }
                        }
                        Some((crate::transport::STREAM_TAG_FIN, sid, _)) => {
                            // 本端应用已关写端 → 对该流 upstream 半关闭（FIN 传播）。
                            // 旧实现无上行 FIN：server upstream 挂到 300s GC（悬挂会话来源）。
                            if let Some(s) = sessions.get_mut(&src_peer) {
                                if let Some(st) = s.streams.get_mut(&sid) {
                                    if let Some(ref tcp) = st.tcp {
                                        let _ = tcp.shutdown(std::net::Shutdown::Write);
                                        tracelog!("[srv] STREAM_FIN peer={} stream={} -> upstream half-closed",
                                            src_peer, sid);
                                    }
                                }
                            }
                        }
                        Some((tag, sid, _)) => {
                            println!("  [srv] unexpected relay frame tag={} stream={} peer={}",
                                tag, sid, src_peer);
                        }
                        None => {
                            eprintln!("[srv] malformed relay frame ({}B) from peer={}", item.len(), src_peer);
                        }
                    }
                }
                // flush 本轮新入队的控制帧/数据（STREAM_END on connect fail 等）
                if let Some(s) = sessions.get_mut(&src_peer) {
                    let (nf, rf) = s.arq.flush_and_tick();
                    for f in nf { let _ = relay.send_to_peer(src_peer, &f); }
                    for f in rf { let _ = relay.send_to_peer(src_peer, &f); }
                    // ARQ 放弃的流：显式 STREAM_END + 移除（入队帧由下行 tick 发出）
                    terminate_abandoned_streams(s, src_peer);
                }
                (Vec::new(), true, src_peer) // relay 数据已按流自行处理，不走共享写块
            }
            crate::relay::RecvKind::P2pData(from, d) => {
                p2p_reply_addr = Some(from);
                // P2P 直连数据是密文，必须先解密再交给本地服务
                match relay.unseal(&d) {
                    Some(plain) => (plain, false, 0),
                    None => (Vec::new(), false, 0),
                }
            }
            crate::relay::RecvKind::PeerProbe(_) | crate::relay::RecvKind::ProbeReply(_) => {
                (Vec::new(), false, 0) // 控制包：无数据，但不跳过 TCP 读
            }
            crate::relay::RecvKind::RelayAck(pkt_type, payload) => {
                relay.push_control_ack(pkt_type, payload);
                (Vec::new(), false, 0)
            }
            crate::relay::RecvKind::Ignored => {
                (Vec::new(), false, 0)
            }
        };

        if !data.is_empty() {
            did_work = true;
            // 只剩 relay-socket P2P 入站走这里（relay 数据已在 match 内按流处理）。
            // phase 2 前单流语义：固定 stream 0。X.224 启发式已删——流生命周期
            // 由 SESSION_START/FIN/STREAM_END 显式管理，字节形状猜测不再参与。
            let t = format!("127.0.0.1:{}", target_port);
            let s = sessions.entry(src_peer).or_insert_with(new_session);
            s.last_seen = std::time::Instant::now();
            let st = s.streams.entry(0).or_insert_with(|| {
                match TcpStream::connect(&t) {
                    Ok(tcp) => {
                        tcp.set_nonblocking(true).ok();
                        tracelog!("[srv] STREAM_OPEN peer={} stream=0 -> {} (P2P inbound)", src_peer, t);
                        SrvStream::new(Some(tcp))
                    }
                    Err(e) => {
                        eprintln!("  [!!] Connect to {}: {}", t, e);
                        SrvStream::new(None)
                    }
                }
            });
            if let Some(ref mut tcp) = st.tcp {
                let _ = tcp.write_all(&data);
                st.up_bytes += data.len() as u64;
            }
        }

        // 下行：遍历所有会话的所有流，读各自 upstream（per-(peer,stream) 隔离核心）
        // 读缓冲 16384B：每个 relay 包远低于 UDP 65507 上限（65536 会超限被 OS 静默丢弃）
        {
            let peer_ids: Vec<u32> = sessions.keys().copied().collect();
            for pid in peer_ids {
                let Some(s) = sessions.get_mut(&pid) else { continue };
                let sids: Vec<u16> = s.streams.keys().copied().collect();
                for sid in sids {
                    // 读步骤（借用 streams），出借结束后再动 arq（避免双重可变借用）
                    enum Step { Data(Vec<u8>), Closed, Idle }
                    let step = {
                        let Some(st) = s.streams.get_mut(&sid) else { continue };
                        let Some(ref mut tcp) = st.tcp else { continue };
                        let mut buf = [0u8; 16384];
                        match tcp.read(&mut buf) {
                            Ok(0) => Step::Closed,
                            Ok(n) => {
                                st.down_bytes += n as u64;
                                Step::Data(buf[..n].to_vec())
                            }
                            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => Step::Idle,
                            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => Step::Idle,
                            Err(_) => Step::Closed,
                        }
                    };
                    match step {
                        Step::Data(bytes) => {
                            did_work = true;
                            s.last_down_read = Some(std::time::Instant::now());
                            if pid == 0 {
                                // relay-socket P2P 入站：有直连地址就直发（不经 ARQ，旧语义）
                                if let Some(addr) = p2p_reply_addr {
                                    let sealed = relay.seal(&bytes);
                                    let _ = relay.send_raw_to(&sealed, addr);
                                    continue;
                                }
                            }
                            // 按流包装下行 chunk：先按 stream_chunk() 切块再加内层头
                            for chunk in bytes.chunks(stream_chunk()) {
                                s.arq.send(&crate::transport::wrap_stream_frame(
                                    crate::transport::STREAM_TAG_DATA, sid, chunk));
                            }
                        }
                        Step::Closed => {
                            // 该流的 sink 关闭/出错 → 只给该流发 STREAM_END。
                            // 时序：走 ARQ 编号，排在它最后一帧下行数据之后。
                            let (up, down) = s.streams.get(&sid)
                                .map(|st| (st.up_bytes, st.down_bytes)).unwrap_or((0, 0));
                            s.arq.send(&crate::transport::wrap_stream_frame(
                                crate::transport::STREAM_TAG_STREAM_END, sid, &[]));
                            tracelog!("[srv] STREAM_END peer={} stream={} up={}B down={}B",
                                pid, sid, up, down);
                            s.streams.remove(&sid);
                        }
                        Step::Idle => {}
                    }
                }
                // 该 peer 的 ARQ 重传/流控 tick（新入队 + 超时重传统一从这里出）
                {
                    let (new_f, retrans_f) = s.arq.flush_and_tick();
                    if !new_f.is_empty() || !retrans_f.is_empty() {
                        did_work = true;
                        for frame in new_f { let _ = relay.send_to_peer(pid, &frame); }
                        for frame in retrans_f { let _ = relay.send_to_peer(pid, &frame); }
                    }
                    // ARQ 放弃的流：显式 STREAM_END + 移除；入队的 STREAM_END 由
                    // 下一轮 tick 发出（空闲轮询周期 1ms，秒级终结不受影响）
                    if terminate_abandoned_streams(s, pid) > 0 {
                        did_work = true;
                    }
                }
            }
            // 会话清理：300s 无任何数据的 peer 移除（G7 资源有界；流生命周期
            // 已由 FIN/STREAM_END 显式管理，这里只兜「对端进程崩溃」）
            sessions.retain(|_, s| s.last_seen.elapsed() < Duration::from_secs(300));
        }
        // 空闲时也不能睡太久：中继 socket 同时承载 P2P 探测包，
        // 睡 10ms 会让探测回复最多延迟 10ms，直接抬高测得 RTT。
        // 服务端也上报状态（之前只有 client 写，server 机器上 `vnet status` 读到的是残留文件）
        if last_status.elapsed() >= Duration::from_secs(5) {
            // ── 租约续期（2026-11-10 01:20 P0）：生产 C relay 的 peer 租约只被
            // REGISTER 刷新（KEEPALIVE/DATA 不续租，实测 360s 后 `peer N expired`）。
            // server 以前只注册一次 → 6 分钟后在 relay 消失 → 所有流死
            // （今晚两机 MF 测试与 13:00 DSH「relay 事故」同根因）。
            // 120s 重注册一次（租约 1/3），幂等廉价，客户端重连风暴无影响。
            if last_reregister.elapsed() >= Duration::from_secs(120) {
                if let Err(e) = relay.register() {
                    eprintln!("  [SRV] lease re-register failed: {:#}", e);
                }
                last_reregister = std::time::Instant::now();
            }
            // ── IPv6 重发现 + 重公告（手机 P2P 根因修复）──
            // 注意：端口必须用 server 实际监听的 P2P 端口（p2p_port 变量），
            // 不能用 get_my_ipv6() 返回的硬编码 9100——那会覆盖正确公告。
            if last_v6_check.elapsed() >= Duration::from_secs(60) {
                last_v6_check = std::time::Instant::now();
                if let Some(sock) = get_my_ipv6() {
                    let ip = match sock.ip() {
                        std::net::IpAddr::V6(v6) => Some(v6),
                        _ => None,
                    };
                    if let Some(v6) = ip {
                        if last_announced_v6 != Some(v6) {
                            let s = format!("[{}]:{}", v6, p2p_port);
                            let _ = relay.announce_ipv6(&s);
                            println!("  [SRV] IPv6 {} (re-)announced: {} (P2P port {})", if last_announced_v6.is_some() { "CHANGED" } else { "initial" }, s, p2p_port);
                            last_announced_v6 = Some(v6);
                        }
                    }
                }
            }
            // ── 2026-11-13 P0（本会话引入的回归，已修）──
            // std::sync::Mutex 不可重入。原实现把 3 次 `p2p_inbound().lock()` 写在
            // 同一个 `let body = vec![...]` 语句里——Rust 临时值作用域让先创建的
            // guard 活到整条语句结束，第二次 lock 同一 mutex 就**永久阻塞**，
            // server 主循环在启动后第 5s（首次状态写入）整体冻结（数据面一起死）。
            // 真机表现：PC server 状态文件 updated_at 停在旧进程，新进程永不写。
            // 修法：进 vec 之前一次性加锁，算完所有派生值，guard 在块结束时释放。
            let (p2p_active, p2p_peer_count, inbound_p2p_str) = {
                let m = p2p_inbound().lock().unwrap();
                let win = Duration::from_secs(30);
                let addrs: Vec<String> = m
                    .iter()
                    .filter(|(_, t)| t.elapsed() < win)
                    .map(|(a, _)| a.clone())
                    .collect();
                (!addrs.is_empty(), addrs.len(), addrs.join(","))
            };
            let srv_path = {
                let p2p_b = SRV_P2P_RX_BYTES.load(Ordering::Relaxed);
                let relay_b = SRV_RELAY_RX_BYTES.load(Ordering::Relaxed);
                if p2p_b > 0 && relay_b > 0 {
                    "mixed".to_string()
                } else if p2p_active && p2p_b > 0 {
                    "p2p".to_string()
                } else if p2p_active {
                    // 有活跃 P2P 对端但还没统计到数据字节：路径已在 P2P
                    "p2p".to_string()
                } else {
                    "relay".to_string()
                }
            };
            let body = vec![
                ("role", "server".to_string()),
                ("my_peer_id", peer_id.to_string()),
                ("target_port", target_port.to_string()),
                ("clients_seen", clients_seen.to_string()),
                ("path", srv_path),
                ("p2p_rx_bytes", SRV_P2P_RX_BYTES.load(Ordering::Relaxed).to_string()),
                ("relay_rx_bytes", SRV_RELAY_RX_BYTES.load(Ordering::Relaxed).to_string()),
                ("p2p_peers_active", p2p_peer_count.to_string()),
                ("inbound_p2p", inbound_p2p_str),
                ("encrypted", relay.is_encrypted().to_string()),
                ("updated_at", format!("{:?}",
                    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default().as_secs())),
            ];
            let mut text = String::new();
            for (k, v) in &body { text.push_str(&format!("{}={}\n", k, v)); }
            let _ = std::fs::write(status_file_path_for("server", peer_id), text);
            last_status = std::time::Instant::now();
        }

        // 下行轨迹：每 3s 汇总（画面卡顿的直接观测点）。
        // slowest_read_ago 取 max：报告「最久没读到下行的那条流」——饥饿的流才是问题，
        // 取 min 会让最活跃的流掩盖最饿的流（观测语义 bug，已修）。
        if down_trace_at.elapsed() >= Duration::from_secs(3) {
            down_trace_at = std::time::Instant::now();
            let mut total: u64 = 0;
            let mut streams = 0usize;
            let mut idle_ms: Option<u128> = None;
            for s in sessions.values() {
                for st in s.streams.values() {
                    total += st.down_bytes;
                    streams += 1;
                }
                if let Some(t) = s.last_down_read {
                    let age = t.elapsed().as_millis();
                    idle_ms = Some(idle_ms.map_or(age, |m| m.max(age)));
                }
            }
            if total > 0 {
                tracelog!("[srv] downlink peers={} streams={} total={}B slowest_read_ago={}ms",
                    sessions.len(), streams, total, idle_ms.unwrap_or(0));
            }
        }
        if perf_srv && perf_srv_at.elapsed() >= Duration::from_millis(100) {
            perf_srv_at = std::time::Instant::now();
            let mut pend = 0; let mut infl = 0; let mut sent = 0; let mut ack = 0; let mut retr = 0;
            let mut rtt = 0;
            for s in sessions.values() {
                pend += s.arq.pending_count();
                infl += s.arq.inflight_count();
                sent += s.arq.sent; ack += s.arq.acked; retr += s.arq.retransmitted;
                rtt = rtt.max(s.arq.rtt_ms().unwrap_or(0));
            }
            tracelog!("[perf-srv] peers={} pending={} inflight={} sent={} acked={} retrans={} rtt={}ms",
                sessions.len(), pend, infl, sent, ack, retr, rtt);
        }
        // 只有本轮完全空闲才让出 CPU；有数据收发时继续下一轮，避免固定 1ms/包的人工限速。
        if !did_work { thread::sleep(Duration::from_millis(1)); }
    }
    Ok(running)
}

/// 通过 STUN 发现本机公网出口 IPv4（多出口 ISP 场景：可能与 relay 观察到的 IP 不同）
fn discover_public_ipv4() -> Option<std::net::IpAddr> {
    for server in ["stun.cloudflare.com:3478", "stun.l.google.com:19302"] {
        if let Ok(addr) = crate::stun::query_stun(server, 0) {
            if addr.is_ipv4() {
                return Some(addr.ip());
            }
        }
    }
    None
}

/// 探测本机当前使用的出口 IPv4（不发包，只让内核选路）。
/// 用于网络变化检测：切 WiFi / 换网 / 拔网线都会让它变化。
fn probe_default_if_status() -> (crate::netstatus::IfType, u8) {
    let cost = probe_default_if_cost();
    #[cfg(target_os = "linux")]
    {
        if let Ok(content) = std::fs::read_to_string("/proc/net/route") {
            for line in content.lines().skip(1) {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 && parts[1] == "00000000" {
                    let ifname = parts[0];
                    let iftype = if ifname.starts_with("rmnet") || ifname.starts_with("ccmni") || ifname.starts_with("wwan") {
                        crate::netstatus::IfType::Cellular
                    } else if ifname.starts_with("wlan") || ifname.starts_with("wifi") {
                        crate::netstatus::IfType::Wifi
                    } else if ifname.starts_with("eth") || ifname.starts_with("usb") {
                        crate::netstatus::IfType::Ethernet
                    } else {
                        crate::netstatus::IfType::Unknown
                    };
                    return (iftype, cost);
                }
            }
        }
        (crate::netstatus::IfType::Unknown, cost)
    }
    #[cfg(not(target_os = "linux"))]
    {
        (crate::netstatus::IfType::Unknown, cost)
    }
}

fn get_my_local_ipv4() -> Option<std::net::IpAddr> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:53").ok()?;
    let local = sock.local_addr().ok()?;
    match local.ip() {
        std::net::IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_unspecified() => {
            Some(std::net::IpAddr::V4(v4))
        }
        _ => None,
    }
}

/// O(o_cost)：当前默认路由接口的计费性（0=免费 WiFi/有线 1=蜂窝计费）。
/// 简单版（M2）：unix 读 /proc/net/route 的默认路由接口名做启发式——
/// rmnet*/ccmni*/wwan*（蜂窝）→1，其余（wlan/eth/p2p 热点等）→0。
/// TODO(Windows)：无 GBK 编码风险的廉价接口名查询通道；桌面场景几乎恒为
/// WiFi/有线，暂恒 0（拿不准按免费，误判代价低）。
fn probe_default_if_cost() -> u8 {
    #[cfg(unix)]
    if let Ok(text) = std::fs::read_to_string("/proc/net/route") {
        for line in text.lines().skip(1) {
            let mut f = line.split('\t');
            let iface = f.next().unwrap_or("");
            let dest = f.next().unwrap_or("");
            // Destination 00000000 == 默认路由
            if dest == "00000000" {
                let n = iface.to_ascii_lowercase();
                if n.starts_with("rmnet")
                    || n.starts_with("ccmni")
                    || n.starts_with("wwan")
                {
                    return 1;
                }
                return 0;
            }
        }
    }
    0
}

fn get_my_ipv6() -> Option<std::net::SocketAddr> {
    // 方案 1：Google DNS connect（原始方式——快速但 Android 多网卡时可能选错接口）
    if let Ok(sock) = UdpSocket::bind("[::]:0") {
        if sock.connect("[2001:4860:4860::8888]:53").is_ok() {
            if let Ok(local) = sock.local_addr() {
                match local.ip() {
                    std::net::IpAddr::V6(v6) if !v6.is_loopback()
                        && !v6.is_unicast_link_local()
                        && !v6.is_unspecified() => {
                        return Some(std::net::SocketAddr::new(std::net::IpAddr::V6(v6), 9100));
                    }
                    _ => {}
                }
            }
        }
    }
    // 方案 2：接口枚举（跨平台兜底——多网卡场景下枚举所有接口找全局 IPv6）
    // Android 修复（2026-11-10）：WiFi+蜂窝并存时 connect 方案可能绑到蜂窝口（无 IPv6）。
    // 枚举所有接口，优先选 managed（非 temporary、非 EUI-64 随机化）的全局地址。
    if let Ok(addrs) = local_ipv6_addrs() {
        if let Some(best) = addrs.first() {
            return Some(std::net::SocketAddr::new(std::net::IpAddr::V6(*best), 9100));
        }
    }
    None
}

/// 本机全局 IPv6 地址快照（getifaddrs，5s 缓存）：(数量, 首个地址)。
/// 2026-11-13 DSH 判读需求：`v6_send_ok>0` 但 `pipe_v6 req=0 rep=0` 时，
/// 必须能区分「本机无全局源地址仍发包（对端收不到/回不来）」vs「本机有地址但对端不应答」。
fn local_v6_snapshot() -> (usize, String) {
    use std::sync::Mutex;
    static CACHE: std::sync::OnceLock<Mutex<(std::time::Instant, usize, String)>> =
        std::sync::OnceLock::new();
    let m = CACHE.get_or_init(|| {
        Mutex::new((std::time::Instant::now() - Duration::from_secs(10), 0, String::new()))
    });
    let mut g = m.lock().unwrap();
    if g.0.elapsed() >= Duration::from_secs(5) {
        let addrs = local_ipv6_addrs().unwrap_or_default();
        let first = addrs.first().map(|a| a.to_string()).unwrap_or_default();
        *g = (std::time::Instant::now(), addrs.len(), first);
    }
    (g.1, g.2.clone())
}
/// 2026-11-13 DSH 审计修复：Android/Unix 用真 getifaddrs 枚举（原注释自称
/// 「接口枚举」但实际是 UDP connect 探测法——只能发现默认路由所在接口；
/// WiFi+蜂窝并存或 v6 走非默认路由时探不到，req=0 的观测盲区来源之一）。
/// Windows 保留 connect 探测（无 libc getifaddrs，行为已在本地验证）。
#[cfg(unix)]
fn local_ipv6_addrs() -> anyhow::Result<Vec<std::net::Ipv6Addr>> {
    let mut result: Vec<(u32, std::net::Ipv6Addr)> = Vec::new();
    unsafe {
        let mut ifap: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut ifap) != 0 {
            anyhow::bail!("getifaddrs failed");
        }
        let mut cur = ifap;
        while !cur.is_null() {
            let ifa = &*cur;
            if !ifa.ifa_addr.is_null() && (*ifa.ifa_addr).sa_family as i32 == libc::AF_INET6 {
                let sin6 = &*(ifa.ifa_addr as *const libc::sockaddr_in6);
                let v6 = std::net::Ipv6Addr::from(sin6.sin6_addr.s6_addr);
                if !v6.is_loopback()
                    && !v6.is_unicast_link_local()
                    && !v6.is_unspecified()
                    && !v6.is_multicast()
                {
                    // sin6_scope_id：全局地址=0，链路本地=接口索引（已过滤）
                    result.push((sin6.sin6_scope_id, v6));
                }
            }
            cur = ifa.ifa_next;
        }
        libc::freeifaddrs(ifap);
    }
    // 全局优先（scope 小者优先），去重保序
    result.sort_by_key(|(scope, _)| *scope);
    let mut out: Vec<std::net::Ipv6Addr> = Vec::new();
    for (_, a) in result {
        if !out.contains(&a) {
            out.push(a);
        }
    }
    Ok(out)
}

/// Windows：保留 UDP connect 探测（无 getifaddrs；单路由表场景足够）。
#[cfg(not(unix))]
fn local_ipv6_addrs() -> anyhow::Result<Vec<std::net::Ipv6Addr>> {
    let mut result: Vec<std::net::Ipv6Addr> = Vec::new();
    let probes = [
        "2001:4860:4860::8888",  // Google
        "2400:3200::1",          // 百度
        "3fff:1e1::1",           // 电信
    ];
    for target in probes {
        if let Ok(sock) = UdpSocket::bind("[::]:0") {
            if sock.connect(format!("[{}]:53", target)).is_ok() {
                if let Ok(local) = sock.local_addr() {
                    if let std::net::IpAddr::V6(v6) = local.ip() {
                        if !v6.is_loopback() && !v6.is_unicast_link_local()
                            && !v6.is_unspecified() && !result.contains(&v6) {
                            result.push(v6);
                        }
                    }
                }
            }
        }
    }
    Ok(result)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_punch_cadence_early_burst_then_backoff() {
        // 早期高密度（150ms × 31 轮 ≈ 前 4.5s 冲刺），中期 500ms，回落 1s（旧行为）
        assert_eq!(punch_cadence_ms(1), 150);
        assert_eq!(punch_cadence_ms(30), 150);
        assert_eq!(punch_cadence_ms(31), 500);
        assert_eq!(punch_cadence_ms(90), 500);
        assert_eq!(punch_cadence_ms(91), 1000);
        assert_eq!(punch_cadence_ms(5000), 1000);
    }

    #[test]
    fn test_conn_rate_token_bucket() {
        // 语义（2026-11-09 改 token bucket）：突发额度 = burst，持续速率 = rate/s。
        // rate=3、burst=3：一次突发只能放 3 个，第 4 个拒；1s 后回填 3 个令牌。
        let t0 = std::time::Instant::now();
        let mut r = ConnRate::new();
        r.tokens = 3.0;
        r.last = t0;
        assert!(r.allow_at(t0 + Duration::from_millis(100), 3, 3));
        assert!(r.allow_at(t0 + Duration::from_millis(200), 3, 3));
        assert!(r.allow_at(t0 + Duration::from_millis(300), 3, 3));
        assert!(!r.allow_at(t0 + Duration::from_millis(400), 3, 3), "4th in burst must be denied");
        // 1.2s 后回填 3.6 → 上限 3 → 放 3 个
        assert!(r.allow_at(t0 + Duration::from_millis(1500), 3, 3));
        assert!(r.allow_at(t0 + Duration::from_millis(1500), 3, 3));
        assert!(r.allow_at(t0 + Duration::from_millis(1500), 3, 3));
        assert!(!r.allow_at(t0 + Duration::from_millis(1500), 3, 3), "refill capped at burst");
    }

    /// DSH 43KB/s 根因回归：一页 81 个资源/0.35s（≈230 conn/s）在**缺省**配置下
    /// 必须全部放行（突发额度 128 ≥ 80），不能重演「52 次 RATE-LIMIT → 全页重试」。
    #[test]
    fn test_conn_rate_page_burst_passes_with_defaults() {
        let t0 = std::time::Instant::now();
        let mut r = ConnRate::new();
        let rate = conn_rate_limit();
        let burst = conn_burst_cap();
        assert!(burst >= 80, "缺省突发额度必须覆盖一页 SPA 资源数（实测 81）");
        let mut allowed = 0;
        for i in 0..81 {
            if r.allow_at(t0 + Duration::from_millis(4 * i), rate, burst) {
                allowed += 1;
            }
        }
        assert_eq!(allowed, 81, "页面突发被限流拒绝 = 客户端只能重试（DSH 43KB/s 的机制）");
    }

    /// 纯洪流场景（R13 形状）：20 个 bare connect 在 ~200ms 内打进来，burst 压到与 rate
    /// 相同 —— 只能放 burst(5) + 这段时间回填(~1) 个，其余必须拒。
    #[test]
    fn test_conn_rate_flood_still_blocked_when_burst_eq_rate() {
        let t0 = std::time::Instant::now();
        let mut r = ConnRate::new();
        let mut allowed = 0;
        for i in 0..20 {
            if r.allow_at(t0 + Duration::from_millis(10 * i), 5, 5) {
                allowed += 1;
            }
        }
        assert!(allowed <= 7, "20 conn/200ms 在 rate=5/burst=5 下必须被限住（实测 allowed={allowed}）");
    }

    #[test]
    fn test_mf_resolve_target_whitelist_and_compat() {
        // legacy（空载荷）用默认 target：旧客户端行为不变
        assert_eq!(mf_resolve_target(&[], 3389), Ok(3389));
        // 显式指定默认口本身：允许（等价 legacy）
        let same = crate::transport::build_session_start_targeted(1, 3389);
        let (_, _, payload) = crate::transport::parse_stream_frame(&same).unwrap();
        assert_eq!(mf_resolve_target(payload, 3389), Ok(3389));
        // 白名单外：必须显式拒绝，绝不静默改连默认口
        let other = crate::transport::build_session_start_targeted(1, 4455);
        let (_, _, p2) = crate::transport::parse_stream_frame(&other).unwrap();
        assert_eq!(mf_resolve_target(p2, 3389), Err("MF_TARGET_DENIED"));
        // 不认识的新版本：显式拒绝（防止旧端把新载荷当 legacy 静默误路由）
        assert_eq!(mf_resolve_target(&[9, 0, 1], 3389), Err("MF_BAD_FRAME"));
    }

    // ── 2026-11-12 手机→PC 3389 真案：静默梯只能在"确有在途/待发字节"时动手 ──
    /// 契约 §3.1-6「`expect_data=true` 且有应用待发数据或主动 L4 探测在途……空闲 TCP 不算黑洞」：
    /// 纯空闲（无 pending/inflight）静默 10 分钟也只能是 Idle —— RDP 空闲期是合法状态。
    #[test]
    fn silence_verdict_requires_inflight_bytes() {
        let trigger = Duration::from_secs(3);
        let budget = Duration::from_secs(12);
        // 纯空闲：无在途字节 → 永不重置（这就是"3389 一跳就断"的修点）
        assert_eq!(
            silence_verdict(false, Duration::from_secs(600), trigger, budget),
            SilenceVerdict::Idle,
            "无在途字节的连接不得被判死"
        );
        // 有在途但还没到触发阈值 → Idle（正常在途传输）
        assert_eq!(
            silence_verdict(true, Duration::from_secs(1), trigger, budget),
            SilenceVerdict::Idle
        );
        // 有在途 + 超阈值未耗尽预算 → Probe（3s 检测，契约 G4/R1b）
        assert_eq!(
            silence_verdict(true, Duration::from_secs(5), trigger, budget),
            SilenceVerdict::Probe
        );
        // 有在途 + 预算耗尽 → Reset（真黑洞仍要显式失败，G4 ≤15s）
        assert_eq!(
            silence_verdict(true, Duration::from_millis(12_000), trigger, budget),
            SilenceVerdict::Reset
        );
    }

    /// 长时间空闲（如 RDP 空闲 60s）后第一笔在途数据：`silent_for` 早已超过预算，
    /// 必须按"武装时刻"裁剪成 0，否则会**立刻**判死（另一个方向的误杀）。
    #[test]
    fn long_idle_then_first_inflight_is_not_an_instant_reset() {
        let trigger = Duration::from_secs(3);
        let budget = Duration::from_secs(12);
        // 入参是 effective_silent = min(silent_for, armed_for)；刚武装时 armed_for≈0
        let effective = Duration::from_secs(600).min(Duration::from_millis(0));
        assert_eq!(
            silence_verdict(true, effective, trigger, budget),
            SilenceVerdict::Idle,
            "刚武装的那一拍不得判死"
        );
        // 武装后熬过预算仍无进展 → Reset（真黑洞照样抓，不会被这条放宽掉）
        let effective2 = Duration::from_secs(600).min(Duration::from_secs(13));
        assert_eq!(silence_verdict(true, effective2, trigger, budget), SilenceVerdict::Reset);
    }

    /// env 旋钮：未设/空/非法/0 一律返回默认值（A/B 现场调参用，不为过门改数）。
    #[test]
    fn silence_env_knobs_parse_with_defaults() {
        // 不 std::env::set_var：进程级全局会污染并行测试；只验证"未设就走默认"这条分支
        assert_eq!(
            env_duration_ms("VNET_SILENCE_DEFINITELY_UNSET_XYZ", Duration::from_secs(3)),
            Duration::from_secs(3)
        );
        assert_eq!(
            env_duration_ms("VNET_SILENCE_DEFINITELY_UNSET_XYZ", Duration::from_millis(250)),
            Duration::from_millis(250)
        );
        // 默认值本身：与任务契约（3s 检测 / 2s 探测节拍）一致
        assert_eq!(SILENCE_TRIGGER, Duration::from_secs(3));
        assert_eq!(PROBE_INTERVAL, Duration::from_secs(2));
    }

    /// caps 协商（task.md §11 H.2）：add_forward 建 route 前的对端能力判定。
    /// Connection 构造需要真实 relay 注册，单测造不出来（同 mf_resolve_target 的做法），
    /// 这里直接锁死 add_forward 所调用的 mf_caps_check 的全部分支语义。
    #[test]
    fn test_add_forward_rejects_no_caps() {
        // 已收到对端公告（version>0）但 caps=0 → 必须显式 MF_UNSUPPORTED（旧 server）
        let mut remote = crate::netstatus::NetStatus::default();
        remote.version = 3;
        remote.caps = 0;
        let err = mf_caps_check(&remote).unwrap_err();
        let msg = format!("{:#}", err);
        assert!(msg.contains("MF_UNSUPPORTED"), "got: {}", msg);
        assert!(msg.contains("caps=0x0"), "错误里应带对端 caps 值便于排障: {}", msg);

        // 有其它能力位但没有 bit0 → 仍拒绝（按位判定，不是 caps!=0）
        remote.caps = 1 << 5;
        assert!(mf_caps_check(&remote).is_err(), "缺 bit0 必须拒，无论其它位");

        // 已公告且含 bit0 → 放行（新 server）
        remote.caps = crate::netstatus::CAP_MULTI_FORWARD;
        assert!(mf_caps_check(&remote).is_ok());

        // 尚未收到任何公告（version=0，announce 经 relay 异步到达）→ 放行
        // （Option B 向后兼容：旧端不公告 NetStatus；enable_multi_forward 闸门兜底）
        let mut fresh = crate::netstatus::NetStatus::default();
        fresh.version = 0;
        assert!(mf_caps_check(&fresh).is_ok(), "version=0 = 未收到公告，不得误报不支持");
    }

    // ── 债 2 / 债 3（2026-11-11/12 生产经验沉淀）──

    /// 债 2：version==0（对端未公告 NetStatus）必须维持向后兼容放行（Ok）。
    /// 新增的 5s 超时探测只是异步补判（add_forward 内 spawn），不得收紧同步语义：
    /// 旧端「不公告」≠「不支持」，fail-open 语义是兼容窗口的底线。
    #[test]
    fn test_mf_caps_check_version_zero_keeps_fail_open_with_probe() {
        let fresh = crate::netstatus::NetStatus::default();
        assert_eq!(fresh.version, 0);
        // 注意 caps 也为 0：version==0 时连 caps 都没到，不能据此拒绝
        assert!(mf_caps_check(&fresh).is_ok(),
            "version=0 必须 Ok：fail-open 保留，探测（probe_peer_alive 5s）只异步补判");
    }

    /// 债 3 API 冻结：confirm_forward 必须以 (&self, u16, Duration) -> anyhow::Result<()>
    /// 暴露给宿主（ffi/embedding 按此签名调用，改签名即编译失败）；
    /// 债 2 的 probe_peer_alive 同步锁死 (Duration) -> bool。
    /// Connection 构造需要真实 relay 注册，单测造不出来，故只做编译期签名锁。
    #[test]
    fn test_confirm_forward_signature_frozen() {
        let confirm: fn(&Connection, u16, Duration) -> anyhow::Result<()> =
            Connection::confirm_forward;
        let probe: fn(&Connection, Duration) -> bool = Connection::probe_peer_alive;
        let _ = (confirm, probe);
    }

    /// 债 3 行为判定表：本地连不上 → Err；全路径有响应 → Ok；
    /// 接受但静默（黑洞外观）→ timeout 内显式 Err，不得无限挂起（G6）。
    /// 探测体独立成自由函数（confirm_forward_probe），无需真实 relay 即可锁行为。
    #[test]
    fn test_confirm_forward_probe_decision_table() {
        // 1) 无 listener：连接被拒 → 明确 Err（错误信息含 "forward unreachable"）
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let dead_port = l.local_addr().unwrap().port();
        drop(l); // 立刻释放，制造确定无监听的口
        let err = confirm_forward_probe(dead_port, Duration::from_secs(1)).unwrap_err();
        let msg = format!("{:#}", err);
        assert!(msg.contains("forward unreachable"), "got: {}", msg);

        // 2) upstream 正常回话（模拟对端服务 echo）→ Ok
        let echo = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((mut s, _)) = echo.accept() {
                let mut b = [0u8; 4];
                let _ = s.read(&mut b);
                let _ = s.write_all(b"OK!");
            }
        });
        assert!(confirm_forward_probe(echo_port, Duration::from_secs(2)).is_ok(),
            "有响应 = 数据流过全路径，必须 Ok");

        // 3) 接受但永不回应（静默黑洞外观）→ 在超时时限附近显式 Err，不得挂死
        let mute = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let mute_port = mute.local_addr().unwrap().port();
        thread::spawn(move || {
            let _hold = mute.accept(); // 持住连接：不响应、不关闭
        });
        let t0 = Instant::now();
        let err = confirm_forward_probe(mute_port, Duration::from_millis(300)).unwrap_err();
        assert!(t0.elapsed() < Duration::from_secs(2),
            "必须在超时时限附近返回（实测 {:?}），不得无限挂起", t0.elapsed());
        assert!(format!("{:#}", err).contains("forward unreachable"));
    }

    #[test]
    fn test_conn_rate_disabled_at_zero() {
        let t0 = std::time::Instant::now();
        let mut r = ConnRate::new();
        for _ in 0..100 {
            assert!(r.allow_at(t0, 0, 5), "rate=0 disables the limiter");
        }
    }

    #[test]
    fn test_hub_filters_arq_ack_header() {
        let mut hub = ConnHub::new();
        let id = hub.register();
        // ARQ ACK 帧头（type=2, 全零）应被过滤
        hub.push_stream(id, vec![0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(hub.pending(id), 0, "ACK header must be filtered");
        // 正常数据不应被过滤
        hub.push_stream(id, vec![0x03, 0x00, 0x00, 0x13, 0x0E]); // TPKT 头
        assert_eq!(hub.pending(id), 1, "normal data passes through");
    }

    #[test]
    fn test_hub_routes_by_stream_not_owner() {
        // R12 核心语义：两条连接各自收到自己的字节，互不可见
        let mut hub = ConnHub::new();
        let a = hub.register();
        let b = hub.register();
        assert_ne!(a, b);
        hub.push_stream(a, b"AAA".to_vec());
        hub.push_stream(b, b"BBB".to_vec());
        assert_eq!(hub.pop(a), Some(b"AAA".to_vec()));
        assert_eq!(hub.pop(b), Some(b"BBB".to_vec()));
        assert_eq!(hub.pop(a), None);
        // 后来的连接不得抢走先来者的下行路由（旧 owner 语义的 RED）
        hub.push_stream(a, b"AA2".to_vec());
        assert_eq!(hub.pop(b), None, "b must not steal a's downlink");
        assert_eq!(hub.pop(a), Some(b"AA2".to_vec()));
    }

    #[test]
    fn test_hub_stream_end_is_per_stream() {
        let mut hub = ConnHub::new();
        let a = hub.register();
        let b = hub.register();
        hub.mark_ended(a);
        assert!(hub.is_ended(a));
        assert!(!hub.is_ended(b), "one stream's END must not close another");
        // 未知 stream 的 END 不得 panic；is_ended 对已注销流返回 true（视为可关）
        hub.unregister(a);
        assert!(hub.is_ended(a));
    }

    #[test]
    fn test_hub_counters_per_stream() {
        let mut hub = ConnHub::new();
        let a = hub.register();
        hub.add_up_bytes(a, 100);
        hub.push_stream(a, vec![0u8; 40]);
        hub.push_stream(a, vec![0u8; 60]);
        assert_eq!(hub.take_counters(a), (100, 100));
    }

    #[test]
    fn test_hub_register_skips_zero_and_in_use() {
        let mut hub = ConnHub::new();
        let first = hub.register();
        assert_ne!(first, 0, "stream 0 is reserved for P2P inbound");
        let second = hub.register();
        assert_ne!(first, second);
        // 环绕安全：注销后再注册不 panic
        hub.unregister(first);
        let third = hub.register();
        assert_ne!(third, 0);
    }

    // ── 同机 peer_id 占位（2026-11-10 串扰事故）──

    /// 事故矩阵：A 先占位 → B 抢走（newcomer-wins）→ A 连续 3 次看到
    /// 新鲜外来占位 → 退位；期间前 2 次只计数不退位（防瞬态误判）。
    #[test]
    fn test_claim_newcomer_takeover_and_yield() {
        let dir = std::env::temp_dir();
        let id = 799_001u32;
        let path = PeerClaim::path_for(&dir, id);
        let _ = std::fs::remove_file(&path);
        let mut a = PeerClaim::steal_with_pid(&dir, id, 111_111, "test");
        assert_eq!(a.poll(), ClaimPoll::Hold);
        assert_eq!(a.poll(), ClaimPoll::Hold);
        // 新进程 B（pid 222222）无条件抢走
        let _b = PeerClaim::steal_with_pid(&dir, id, 222_222, "test");
        assert_eq!(a.poll(), ClaimPoll::ForeignLive, "第 1 次外来占位只计数");
        assert_eq!(a.poll(), ClaimPoll::ForeignLive, "第 2 次外来占位只计数");
        assert_eq!(a.poll(), ClaimPoll::Superseded, "连续第 3 次必须退位");
        let _ = std::fs::remove_file(&path);
    }

    /// 自愈矩阵：持有人死了（占位过期）→ 本进程夺回继续 Hold。
    #[test]
    fn test_claim_retake_when_holder_dead() {
        let dir = std::env::temp_dir();
        let id = 799_002u32;
        let path = PeerClaim::path_for(&dir, id);
        let _ = std::fs::remove_file(&path);
        let mut a = PeerClaim::steal_with_pid(&dir, id, 111_111, "test");
        let _b = PeerClaim::steal_with_pid(&dir, id, 222_222, "test"); // B 抢走
        // 时钟前跳 30s：B 的占位过期（>CLAIM_FRESH）→ A 夺回
        let later = std::time::SystemTime::now() + Duration::from_secs(30);
        assert_eq!(a.poll_at(later), ClaimPoll::Retaken);
        assert_eq!(a.poll(), ClaimPoll::Hold);
        let _ = std::fs::remove_file(&path);
    }

    /// 清理语义：只删自己的占位；被抢走后 release 是 no-op（不删别人的）。
    #[test]
    fn test_claim_release_only_when_mine() {
        let dir = std::env::temp_dir();
        let id = 799_003u32;
        let path = PeerClaim::path_for(&dir, id);
        let _ = std::fs::remove_file(&path);
        let a = PeerClaim::steal_with_pid(&dir, id, 111_111, "test");
        a.release_if_mine();
        assert!(!path.exists(), "自己的占位应被删除");
        let _b = PeerClaim::steal_with_pid(&dir, id, 222_222, "test");
        a.release_if_mine();
        assert!(path.exists(), "别人的占位不得删除");
        let _ = std::fs::remove_file(&path);
    }

    /// 流 id 基点随机化：多实例基点不全同（否则串扰防护退化回顺序编号），
    /// 且 0 永不分配（P2P 入站聚合保留）。
    #[test]
    fn test_hub_stream_ids_randomized_across_instances() {
        let mut firsts = std::collections::HashSet::new();
        for _ in 0..32 {
            let id = ConnHub::new().register();
            assert_ne!(id, 0, "stream 0 is reserved");
            firsts.insert(id);
        }
        assert!(firsts.len() > 1, "32 个实例的基点不能全同（串扰防护失效）");
    }
}
