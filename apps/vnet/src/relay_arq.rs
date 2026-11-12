//! RelayArq v3 —— relay 路径 ARQ（快速重传 + SACK + 自适应 RTO）
//!
//! v3 改进：
//! 1. 快速重传（TCP Fast Retransmit）：3 个重复 ACK → 立即重传缺失帧
//! 2. SACK（选择性确认）：ACK 带位图告知已收到的乱序帧 → 发送端只重传真正缺失的
//! 3. 自适应 RTO：EWMA 测量实际 RTT → RTO = SRTT + 4×RTTVAR（TCP RFC 6298）

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};
use crate::transport;

/// ARQ chunk 上限（缺省 1000；实验可经 `VNET_CHUNK` 覆盖——只用于因果实验，
/// 生产缺省值由契约冻结。pub：连接多路复用的内层帧要求「先按此分块、再逐 chunk
/// 加内层头」，保证每个交付项恰好一个内层头，边界不被 ARQ 内部分块打断）
pub fn chunk_size() -> usize {
    static C: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *C.get_or_init(|| {
        std::env::var("VNET_CHUNK").ok().and_then(|v| v.parse().ok()).unwrap_or(1000)
    })
}

/// 发送窗口（帧数，缺省 128；实验可经 `VNET_WINDOW` 覆盖）。
/// 缺省历史：32 是 2026-11-07 前的保守值（当时窗口 64 实测丢包回退——根因是
/// 在途量打穿 64KB OS 接收缓冲，并非窗口本身不可用）。
/// 2026-11-08 升 128，前提与依据（实测闭环）：
/// ① 接收缓冲改为随窗口自动配套（relay.rs::apply_tunable_buffers：
///   window×chunk×4 ≈ 512KB，Windows 内核加倍 ≈1MB），消除旧回退的根因；
/// ② 接收端两遗留缺陷已修（`a3f3e281`：乱序窗联动窗口、迟到重复丢弃）；
/// ③ 生产 C relay 窗口 128 + 1MB 缓冲 24/24 全绿、retrans=0；
/// ④ 业务：RDP 图形高峰 2–8MB/s，32 帧（≈2MB/s）必然卡顿，128 帧消除主因。
pub fn window_size() -> usize {
    static W: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *W.get_or_init(|| {
        std::env::var("VNET_WINDOW").ok().and_then(|v| v.parse().ok()).unwrap_or(128)
    })
}

/// SACK 位图字节数：随窗口联动（位图必须盖住整个窗口，否则乱序恢复退化为
/// 盲目重传）。两端同版本部署，env 一致即协议一致。
pub fn sack_bitmap_bytes() -> usize {
    (window_size() / 8).max(4)
}

const MAX_RETRANS_PER_TICK: usize = 8;
const RTO_DEFAULT_MS: u64 = 200;
const RTO_MIN_MS: u64 = 50;
const RTO_MAX_MS: u64 = 2000;
const FAST_RETRANS_THRESHOLD: u32 = 3;
/// 单个帧的放弃预算：超过这个时间还没被确认，才判定字节永久丢失。
///
/// 来源不是拍数字：契约 G4 规定「alive 外观下数据黑洞不得超过 15 秒」，
/// 静默检测在 3 秒触发，因此重传必须至少能覆盖 `15 - 3 = 12` 秒，
/// 否则 2 秒的真实瞬断（R9b 实测）会被判死——旧实现正是如此：
/// `8 × RTO(200ms) ≈ 1.6s` 就静默丢帧。
/// 12 秒内靠指数退避重传，超过才记账 abandoned 并显式失败。
const ARQ_RETRY_BUDGET_MS: u64 = 12_000;
/// 退避上限：RTO_MAX 的 2 倍，避免 RTO 已经很慢时退避到不可接受
const BACKOFF_CAP_MS: u64 = 2 * RTO_MAX_MS;

/// 在途帧：既要重传，也要能判断「这一帧已经被重试了多久」
struct Inflight {
    frame: Vec<u8>,
    sent_at: Instant,
    /// 首次发送时刻：放弃预算从这一刻算起，不受重传次数/退避影响
    first_sent: Instant,
    retries: u32,
}

/// RFC 6298 §5.5：超时重传时 RTO 指数退避
fn backoff_rto(rto: Duration, retries: u32) -> Duration {
    let factor = 1u32 << retries.min(4);
    let ms = (rto.as_millis() as u64).saturating_mul(factor as u64).min(BACKOFF_CAP_MS);
    Duration::from_millis(ms.max(RTO_MIN_MS))
}

pub struct RelayArq {
    pending: VecDeque<Vec<u8>>,
    next_seq: u32,
    inflight: HashMap<u32, Inflight>,
    /// 放弃预算（默认 `ARQ_RETRY_BUDGET_MS`，测试可缩短）
    retry_budget: Duration,

    next_expected: u32,
    out_of_order: HashMap<u32, Vec<u8>>,
    /// 是否已收到本接收器的首个 DATA 帧。
    /// 新进程/新通道没有历史，首帧 seq 可以是任意值（对端续流或首帧丢失）。
    seen_any: bool,

    // 发送/接收流代际：server 重启生成新 send_epoch，接收端按 epoch 协调重置。
    // DATA 的保留 ack 位（frame[5..9]）承载发送 epoch；ACK 的保留 seq 位（frame[1..5]）回传该 epoch。
    send_epoch: u32,
    recv_epoch: Option<u32>,
    /// 坏包根因修复（2026-11-10 epoch 回摆）：已见过的 epoch 集合。
    /// 同一 epoch 值回摆（旧 epoch 迟到帧在被新 epoch 替代后再次到达）
    /// → 绝不能再当 stream_changed 重置接收状态——那是替换型损坏的根源。
    /// 修法：已见过但不是当前的 epoch → 直接丢弃帧（stale，来自被放弃的旧流）。
    seen_epochs: std::collections::HashSet<u32>,

    // 快速重传
    last_ack_received: u32,
    dup_ack_count: u32,

    // ── ARQ 可观测（2026-11-10 RDP 指针卡顿诊断）──
    /// 累计重传帧数（每次重传 +1；指针卡顿时如果此值跳增 = 丢包问题）
    pub retransmit_count: u64,
    /// 累计窗口满事件数（send 被阻塞时 +1/次；跳增 = 排队问题）
    pub window_full_count: u64,
    /// 最长数据间隙 ms（上次 flush 到现在无新帧可发的最长间隔）
    pub max_stall_ms: u64,
    /// 上次 flush 时刻（用于计算 stall）
    last_flush: Option<std::time::Instant>,

    // 自适应 RTO (TCP RFC 6298)
    srtt: Option<Duration>,
    rttvar: Option<Duration>,

    /// 最近一次“数据面确实有进展”的时刻。
    /// 进展定义（缺一不可，都是可观测事实）：
    /// 1) ACK/SACK 清掉了在途帧；2) 按序交付了应用字节；3) PING 收到 PONG。
    /// 发送新帧不算进展——那只证明我们还在写，不证明对端收到了。
    last_progress: Instant,
    /// 因超过 MAX_RETRIES 被放弃的字节数。放弃 = 字节流中段永久缺失，
    /// 不能再靠重传补齐，必须显式失败（G6），禁止静默丢。
    abandoned_bytes: u64,
    /// 被放弃帧所属的流 id（不去重：同流多帧放弃时 server 侧终结幂等）。
    /// 上层取走后应对每个流显式发 STREAM_END——client 不知道缺口存在，
    /// 只能等上层超时（task.md §6.1-8 契约：放弃必须显式终结受影响流）。
    abandoned_streams: Vec<u16>,
    /// Per-stream retry budget（Phase 1，2026-11-12 RDP P0）：每个流「最老 pending
    /// 帧首次入队」的时刻。单流卡死不再连坐整条隧道——超预算的流只把**自己**
    /// 的 pending 帧原地替换成 STREAM_END（帧数/位置不变，seq 连续性保持），
    /// 其他流照常；inflight 帧不动（继续按整体预算重传 = Phase 2 兜底）。
    /// 在 `send()` 首帧入队时建立，`on_ack()`（handle_ack_v3）确认有进展且该流
    /// 已无 pending 帧时清除——预算只度量「本轮积压」，不跨健康回合累计。
    stream_pending_since: HashMap<u16, Instant>,
    /// 在途探测：nonce + 发出时刻。None = 当前没有探测在等回包。
    probe_nonce: u32,
    probe_at: Option<Instant>,
    /// 发送 pacing（行业标准做法：QUIC RFC 9002 §7.7 / TCP pacing）。
    /// 把一窗口的帧按时间摊开，而不是瞬间突发——突发会在跨 ISP 队列/WiFi
    /// 聚合点被整段丢弃（实测：窗口 384 一次突发 384 包，重传率 10–29%）。
    /// 速率上限 = cwnd / srtt（字节/秒）；RTT 未知时首窗口不设限。
    /// `VNET_PACE`：`0`=关闭（A/B 对照），数值=固定字节/秒，未设=自动。
    pace_override: Option<f64>,
    /// 令牌桶：剩余可发送字节数（按经过时间充能；桶容量 = 一次轮询应发量）
    pace_tokens: f64,
    pace_last: Instant,
    /// 收到对端 STREAM_END（连接关闭信号），上层读后清零
    stream_end_received: bool,
    /// 探测成功次数（只用于诊断/证据，不参与判断）
    pub probes_ok: u64,
    pub probes_sent: u64,

    // 统计
    pub sent: u64,
    pub acked: u64,
    pub retransmitted: u64,
    pub fast_retransmits: u64,
    pub sack_saved: u64, // SACK 避免的不必要重传数
}

/// 生成非零流代际。时间戳 + 进程内单调计数，避免 server 重启后新旧流同号。
fn fresh_epoch() -> u32 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let value = nanos ^ COUNTER.fetch_add(1, Ordering::Relaxed);
    (value as u32).max(1)
}

impl RelayArq {
    pub fn new() -> Self {
        Self {
            pending: VecDeque::new(),
            next_seq: 0,
            inflight: HashMap::new(),
            retry_budget: Duration::from_millis(
                std::env::var("VNET_RETRY_BUDGET_MS").ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(ARQ_RETRY_BUDGET_MS)),
            next_expected: 0,
            out_of_order: HashMap::new(),
            seen_any: false,
            send_epoch: fresh_epoch(),
            recv_epoch: None,
            seen_epochs: std::collections::HashSet::new(),
            last_ack_received: 0,
            dup_ack_count: 0,
            retransmit_count: 0,
            window_full_count: 0,
            max_stall_ms: 0,
            last_flush: Some(Instant::now()),
            srtt: None,
            rttvar: None,
            last_progress: Instant::now(),
            abandoned_bytes: 0,
            abandoned_streams: Vec::new(),
            stream_pending_since: HashMap::new(),
            probe_nonce: 0,
            probe_at: None,
            pace_override: std::env::var("VNET_PACE").ok().and_then(|v| v.parse::<f64>().ok()),
            pace_tokens: 0.0,
            pace_last: Instant::now(),
            stream_end_received: false,
            probes_ok: 0,
            probes_sent: 0,
            sent: 0,
            acked: 0,
            retransmitted: 0,
            fast_retransmits: 0,
            sack_saved: 0,
        }
    }

    // ─── 发送端 ───

    pub fn send(&mut self, payload: &[u8]) {
        for chunk in payload.chunks(chunk_size()) {
            self.pending.push_back(chunk.to_vec());
        }
        // per-stream 预算锚点：该流首个未清空 pending 帧的入队时刻。
        // 已有锚点不刷新——预算从「最老 pending」起算，后续新帧不重置计时。
        // 非流帧（AUTH/裸字节）解析不出 sid 就不记，只跟踪能确定归属的流。
        if let Some((_, sid, _)) = transport::parse_stream_frame(payload) {
            self.stream_pending_since.entry(sid).or_insert_with(Instant::now);
        }
    }

    /// pacing 速率（字节/秒）。None = 不设限。
    /// 自动档 = cwnd/srtt（RFC 9002 §7.7 的 pacing rate 下限）；RTT 未知时
    /// 首窗口不设限，避免慢启动早期被无依据的速率卡住。
    fn pace_rate(&self) -> Option<f64> {
        if let Some(v) = self.pace_override {
            return if v > 0.0 { Some(v) } else { None };
        }
        let srtt = self.srtt?;
        if srtt.as_secs_f64() < 0.001 {
            return None;
        }
        let cwnd = (window_size() * chunk_size()) as f64;
        Some((cwnd / srtt.as_secs_f64()).max(64_000.0))
    }

    /// 距离下一帧可发还差多久（桶空时给调用方的 sleep 建议；上限 1ms）
    pub fn pace_wait(&self) -> Duration {
        Duration::ZERO
    }

    /// 流控 + 重传（自适应 RTO + RFC 6298 指数退避 + 放弃预算）
    pub fn flush_and_tick(&mut self) -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {        let mut new_frames = Vec::new();
        let mut retransmissions = Vec::new();
        let now = Instant::now();
        let rto = self.get_rto();

        let mut retrans_count = 0;
        let mut dead = Vec::new();
        for (seq, f) in self.inflight.iter_mut() {
            // 放弃看「首次发送至今」的时间，不看次数：
            // 次数随 RTO 变化，时间才是契约 G4 能约束的量。
            if now.duration_since(f.first_sent) > self.retry_budget {
                dead.push(*seq);
                continue;
            }
            if retrans_count >= MAX_RETRANS_PER_TICK { continue; }
            if now.duration_since(f.sent_at) > backoff_rto(rto, f.retries) {
                retransmissions.push(f.frame.clone());
                f.sent_at = now;
                f.retries += 1;
                self.retransmitted += 1;
                self.retransmit_count += 1; // 可观测：每次重传计数
                retrans_count += 1;
            }
        }
        for seq in dead {
            // 放弃 = 这一段应用字节永久缺失，字节流完整性已破坏。
            // 必须计数并在 A 侧转成显式失败，不能像以前一样静默移除。
            if let Some(f) = self.inflight.remove(&seq) {
                let payload = f.frame.len().saturating_sub(transport::HEADER_SIZE);
                self.abandoned_bytes += payload as u64;
                // 记下被放弃帧所属的流：该流字节流已残缺，必须由上层显式
                // 终结（STREAM_END），不得让 client 等上层超时才发现。
                // 帧 = 11B ARQ 头 + 内层流帧 [tag][stream:2]；解析不出流 id
                // （非流帧/残帧）就不记——只终结能确定归属的流。
                if let Some((_, sid, _)) = f.frame.get(transport::HEADER_SIZE..)
                    .and_then(transport::parse_stream_frame)
                {
                    self.abandoned_streams.push(sid);
                }
                println!("  [ARQ-LOST] seq={} retried={} elapsed={}ms abandoned_total={}B",
                    seq, f.retries, f.first_sent.elapsed().as_millis(), self.abandoned_bytes);
            }
        }

        // 窗口内按 pending 顺序发新帧；不在 flush 里额外限速。
        // 曾试过的窗口 64 + 突发限速是失败实验：窗口在途量本身超出接收缓冲，
        // 发送侧限速救不了，已回退窗口；该限速也随之撤销，不叠无因果补丁。
        let frame_len_hint = (transport::HEADER_SIZE + chunk_size()) as f64;
        while let Some(chunk) = self.pending.pop_front() {
            if self.inflight.len() >= window_size() {
                self.pending.push_front(chunk);
                self.window_full_count += 1; // 可观测：窗口满计数
                break;
            }
            // pacing：令牌桶按经过时间充能，本次 flush 最多发「这段应发量」。
            // 桶容量 = max(rate×1ms, 2 帧)：既允许每次轮询发出该发的帧，
            // 又不会把整窗口一次性放出（那正是突发丢包的来源）。
            let pace_rate = self.pace_rate();
            if let Some(rate) = pace_rate {
                let now_p = Instant::now();
                // 桶容量 = 1 个轮询周期 × 速率（实测 3ms 配额只会增加突发与重传：2.6–3.1MB/s、retrans 2135，已回滚）
                let cap = (rate * 0.001).max(2.0 * frame_len_hint);
                let elapsed = now_p.saturating_duration_since(self.pace_last).as_secs_f64();
                self.pace_tokens = (self.pace_tokens + rate * elapsed).min(cap);
                self.pace_last = now_p;
                let need = (transport::HEADER_SIZE + chunk.len()) as f64;
                if self.pace_tokens < need {
                    self.pending.push_front(chunk);
                    break;
                }
                self.pace_tokens -= need;
            }
            let seq = self.next_seq;
            self.next_seq = self.next_seq.wrapping_add(1);
            let frame = build_data_frame_inner(seq, self.send_epoch, &chunk);
            new_frames.push(frame.clone());
            self.inflight.insert(seq, Inflight {
                frame,
                sent_at: Instant::now(),
                first_sent: Instant::now(),
                retries: 0,
            });
            self.sent += 1;
        }

        // 可观测：数据间隙 = 本次 flush 距上次的间隔（>1000ms 记录）
        if let Some(prev) = self.last_flush {
            let gap = prev.elapsed().as_millis() as u64;
            if gap > self.max_stall_ms { self.max_stall_ms = gap; }
        }
        self.last_flush = Some(Instant::now());
        (new_frames, retransmissions)
    }

    // ─── 接收端 ───

    /// 处理收到的 relay 数据
    /// 返回 (交付数据, 回发ACK(含SACK), 快速重传帧)
    pub fn on_packet(&mut self, data: &[u8]) -> (Vec<Vec<u8>>, Option<Vec<u8>>, Vec<Vec<u8>>) {
        if let Some((ptype, seq, ack, payload)) = transport::parse_packet(data) {
            match ptype {
                transport::TYPE_DATA => {
                    // DATA 的 ack 保留位承载发送端 epoch。
                    let (deliver, ack_seq) = self.handle_data(seq, ack, &payload);
                    // ACK 带 SACK 位图，并在保留 seq 位回传接收端所属 epoch
                    let ack_frame = if ack_seq != u32::MAX {
                        let bitmap = self.build_sack_bitmap();
                        Some(build_ack_with_sack(ack_seq, self.recv_epoch.unwrap_or(0), &bitmap))
                    } else { None };
                    (deliver, ack_frame, Vec::new())
                }
                transport::TYPE_ACK => {
                    // ACK 的 seq 保留位是被确认 DATA 的 epoch。
                    let fast = self.handle_ack_v3(seq, ack, &payload);
                    (Vec::new(), None, fast)
                }
                transport::TYPE_PING => {
                    // 对端在等数据面往返证据：原样回 PONG（不进入应用字节流）。
                    (Vec::new(), Some(transport::build_pong(seq)), Vec::new())
                }
                transport::TYPE_PONG => {
                    // 只有自己发过的 nonce 才算证据；别人的/过期的 PONG 不得刷新进度。
                    if self.probe_at.is_some() && seq == self.probe_nonce {
                        self.probe_at = None;
                        self.last_progress = Instant::now();
                        self.probes_ok += 1;
                        println!("  [A_probe_data_plane] pong nonce={} ok_total={}", seq, self.probes_ok);
                    }
                    (Vec::new(), None, Vec::new())
                }
                transport::TYPE_STREAM_END => {
                    // 对端服务已关闭 → 本端应关闭对应应用连接。置标志由上层读取。
                    self.stream_end_received = true;
                    println!("  [ARQ] STREAM_END received from peer");
                    (Vec::new(), None, Vec::new())
                }
                _ => (Vec::new(), None, Vec::new()),
            }
        } else {
            (Vec::new(), None, Vec::new())
        }
    }

    /// 是否收到了对端的 STREAM_END（连接关闭信号）。由上层读取后清零。
    pub fn take_stream_end(&mut self) -> bool {
        std::mem::take(&mut self.stream_end_received)
    }

    /// 当前观测到的对端发送 epoch（None = 还没收到过 DATA）。
    /// server 侧用它检测「client 重启换代」→ 该 peer 的所有应用流随旧进程死亡，
    /// 必须清空 per-stream upstream（epoch 变化 = 旧流永不再来）。
    pub fn recv_epoch(&self) -> Option<u32> {
        self.recv_epoch
    }

    fn handle_data(&mut self, seq: u32, epoch: u32, data: &[u8]) -> (Vec<Vec<u8>>, u32) {
        let mut ordered = Vec::new();
        // ── 坏包根因修复（2026-11-10）：epoch 单调化，绝不回摆 ──
        // 旧机制：epoch 变化 → 无条件重置接收状态。在 epoch churn（如控制帧放弃风暴）
        // 下，旧 epoch 的迟到帧会再次触发 stream_changed → 接收状态回摆 → 已交付的数据
        // 被重新交付（替换型损坏：同字节数不同 SHA）。
        // 修法：记录所有已见 epoch。已见过但不是当前的 epoch → 帧来自被放弃的旧流 → 丢弃。
        if epoch != 0 {
            if let Some(cur) = self.recv_epoch {
                if epoch != cur && self.seen_epochs.contains(&epoch) {
                    // 回摆：这个 epoch 我们已经超越，帧是旧流的残留重传
                    println!("  [ARQ-EPOCH-DROP] epoch={} is superseded (current={}), seq={} len={} — stale frame from abandoned stream",
                        epoch, cur, seq, data.len());
                    let ack = if self.next_expected == 0 { u32::MAX }
                              else { self.next_expected.wrapping_sub(1) };
                    return (Vec::new(), ack); // 丢弃帧，照常 ACK 当前位置
                }
            }
        }
        // epoch 变化 = 对端发送流已换代（如 server 重启）。
        // 必须以本帧 seq 重建接收状态；旧流的 next_expected/out_of_order 不得污染新流。
        let stream_changed = match self.recv_epoch {
            None => true,
            Some(old) => epoch != 0 && old != epoch,
        };
        if stream_changed {
            // ── 坏包观测（2026-11-10 DSH 移交）：epoch 竞态是嫌疑 #2。旧 epoch 在途帧
            // 迟到 → 再次触发 stream_changed → 状态回摆 → 同长度帧错位交付。
            // 必须记录完整决策链：旧 epoch、新 epoch、跳变时 out_of_order 里有什么。
            let old_epoch = self.recv_epoch;
            let ooo_count = self.out_of_order.len();
            let ooo_bytes: usize = self.out_of_order.values().map(|v| v.len()).sum();
            self.seen_epochs.insert(epoch); // 单调化：这个 epoch 从此已知
            self.recv_epoch = Some(epoch);
            self.seen_any = true;
            self.next_expected = seq;
            self.out_of_order.clear();
            println!("  [ARQ-EPOCH] CHANGE old={:?} new={} first_seq={} ooo_dropped[{}] ({}B)",
                old_epoch, epoch, seq, ooo_count, ooo_bytes);
        } else if !self.seen_any {
            // 同 epoch 的接收器初始化：首帧可以因丢包而非 0。
            self.seen_any = true;
            self.next_expected = seq;
            self.out_of_order.clear();
            println!("  [ARQ-INIT] first DATA seq={} epoch={} len={}", seq, epoch, data.len());
        } else {
            // 乱序容忍窗：必须大于发送窗口（合法乱序跨度 ≤ 窗口），否则突发乱序的
            // 首帧会被误判为「流重置」→ 跳号 + 丢弃乱序缓冲 → 字节流空洞但 ACK 照发。
            // 实测（2026-11-08 生产 relay，窗口 128）：固定 64 时 4/6 样本
            // 「EOF at 0/4」（内层帧解析崩坏，快则 158ms、慢则 12s 阶梯判死）。
            // 窗口联动 + 64 裕量：窗口内的乱序永远合法入缓冲，超窗才考虑重置。
            // 乱序容忍窗：必须大于发送窗口（合法乱序跨度 ≤ 窗口 + SACK 打开的跨度）。
            // 实测（2026-11-08 生产 relay，窗口 128）：固定 64 时 4/6 样本
            // 「EOF at 0/4」（乱序首帧被误判为流重置 → 跳号丢字节）。
            let reorder_margin = window_size() as u32 + 64;
            // 落后帧 = 迟到重复（网络延迟复制/旧重传），已交付过 → 丢弃，绝不重放。
            // 旧实现在这里「向后重置」→ 重复交付 → 字节流损坏（实测多交付 1994B，
            // sink 框架崩坏 → 秒 EOF）。epoch 协调接管重启语义后，向后重置无合法场景。
            if seq.wrapping_add(reorder_margin) < self.next_expected {
                println!("  [ARQ-STALE-DROP] seq={} next_expected={} gap={} len={} (late duplicate, already delivered)",
                    seq, self.next_expected, self.next_expected.wrapping_sub(seq), data.len());
            } else if seq > self.next_expected.wrapping_add(reorder_margin)
                    && self.out_of_order.is_empty() {
                // ── 坏包观测：RESYNC-FWD 是嫌疑 #1（静默空洞）。
                // 记录跳过的确切 seq 范围和字节量——这是交付侧的空洞证据。
                let skipped_seqs = seq.wrapping_sub(self.next_expected);
                println!("  [ARQ-RESYNC-FWD] seq={} next_expected={} SKIPPING {} seqs [{}..{}] margin={} len={} (SILENT HOLE RISK)",
                    seq, self.next_expected, skipped_seqs, self.next_expected, seq.wrapping_sub(1), reorder_margin, data.len());
                self.next_expected = seq;
                self.out_of_order.clear();
            }
        }
        if seq == self.next_expected {
            ordered.push(data.to_vec());
            self.next_expected = self.next_expected.wrapping_add(1);
            while let Some(buf) = self.out_of_order.remove(&self.next_expected) {
                ordered.push(buf);
                self.next_expected = self.next_expected.wrapping_add(1);
            }
        } else if seq > self.next_expected {
            self.out_of_order.insert(seq, data.to_vec());
        }
        let ack = if self.next_expected == 0 { u32::MAX }
                  else { self.next_expected.wrapping_sub(1) };
        if !ordered.is_empty() {
            // 真正交付了应用字节 = 数据面有进展
            self.last_progress = Instant::now();
        }
        (ordered, ack)
    }

    /// 构建 SACK 位图（next_expected 之后的已接收乱序帧）
    fn build_sack_bitmap(&self) -> Vec<u8> {
        let n = sack_bitmap_bytes();
        let mut bitmap = vec![0u8; n];
        let base = self.next_expected;
        for &seq in self.out_of_order.keys() {
            let offset = seq.wrapping_sub(base);
            if offset > 0 && offset < (n * 8) as u32 {
                bitmap[(offset / 8) as usize] |= 1 << (offset % 8);
            }
        }
        bitmap
    }

    // ─── 发送端 ACK 处理（快速重传 + SACK + 自适应 RTO） ───

    fn handle_ack_v3(&mut self, epoch: u32, ack: u32, payload: &[u8]) -> Vec<Vec<u8>> {
        // 只接受当前发送 epoch 的 ACK；旧 server/旧流的 ACK 不得清除本轮在途帧。
        if epoch != self.send_epoch { return Vec::new(); }
        if ack == u32::MAX { return Vec::new(); }
        let inflight_before = self.inflight.len();
        let mut fast_retransmit = Vec::new();

        // 自适应 RTO：测量 RTT（用被 ACK 的帧的发送时间）
        if let Some(f) = self.inflight.get(&ack) {
            self.update_rtt(f.sent_at.elapsed());
        }

        // 快速重传：3 个重复 ACK → 立即重传 ack+1
        if ack == self.last_ack_received {
            self.dup_ack_count += 1;
            if self.dup_ack_count >= FAST_RETRANS_THRESHOLD {
                let missing = ack.wrapping_add(1);
                if let Some(f) = self.inflight.get_mut(&missing) {
                    fast_retransmit.push(f.frame.clone());
                    f.sent_at = Instant::now();
                    f.retries = f.retries.saturating_add(1);
                    self.retransmitted += 1;
                    self.fast_retransmits += 1;
                }
                self.dup_ack_count = 0;
            }
        } else {
            self.dup_ack_count = 0;
            self.last_ack_received = ack;
        }

        // 正常累积 ACK：删除 ≤ ack 的帧
        self.inflight.retain(|seq, _| *seq > ack);

        // SACK：删除接收端已有的帧（避免不必要重传）。
        // 位图长度按实际 payload 解（发送端窗口可能不同版本/不同 env，
        // 位图长度即协议：payload 有多少字节就解多少位）
        if payload.len() >= 4 {
            let base = ack.wrapping_add(1);
            for i in 0..(payload.len() * 8) {
                if payload[i / 8] & (1 << (i % 8)) != 0 {
                    let seq = base.wrapping_add(i as u32);
                    if self.inflight.remove(&seq).is_some() {
                        self.sack_saved += 1;
                    }
                }
            }
        }

        // 在途帧被清掉（累积 ACK 或 SACK）= 对端确实收到了字节 = 数据面有进展
        if self.inflight.len() < inflight_before {
            self.acked += (inflight_before - self.inflight.len()) as u64;
            self.last_progress = Instant::now();
            // per-stream 预算收尾（Phase 1）：有进展时清掉已无 pending 帧的流锚点——
            // 该流本轮积压已全部离队，预算计时不跨健康回合（否则健康流会带着
            // 陈旧锚点在下一轮静默中被误判「卡了 12s」）。
            if !self.stream_pending_since.is_empty() {
                let live: std::collections::HashSet<u16> = self.pending.iter()
                    .filter_map(|item| transport::parse_stream_frame(item).map(|(_, sid, _)| sid))
                    .collect();
                self.stream_pending_since.retain(|sid, _| live.contains(sid));
            }
        }

        fast_retransmit
    }

    // ─── 数据面静默检测 / 恢复梯支撑 ───

    /// `expect_data` 的判定：有应用字节排队，或有在途未确认帧。
    /// 空闲 TCP 连接两者都为空 → 永远不会被判成黑洞。
    pub fn expect_data(&self) -> bool {
        !self.pending.is_empty() || !self.inflight.is_empty()
    }

    /// 距离最近一次数据面进展过了多久（检测阈值 3s 由 A 侧施加）
    pub fn silent_for(&self) -> Duration {
        self.last_progress.elapsed()
    }

    /// 已被放弃、永久缺失的字节数。>0 表示字节流完整性已破坏。
    pub fn abandoned_bytes(&self) -> u64 {
        self.abandoned_bytes
    }

    /// 取走「因放弃预算耗尽而字节流残缺」的流 id（取走即清空，不重复消费）。
    /// 调用方（server relay 主循环）应对每个 sid 显式发 STREAM_END 并移除
    /// 该流，让 client 秒级失败重连（task.md §6.1-8），禁止静默留下缺口。
    pub fn take_abandoned_streams(&mut self) -> Vec<u16> {
        std::mem::take(&mut self.abandoned_streams)
    }

    /// 清零放弃字节计数（按流终结路径用；防止下一轮静默检测重复触发）
    pub fn clear_abandoned_bytes(&mut self) {
        self.abandoned_bytes = 0;
    }

    /// Per-stream retry budget（Phase 1，RDP P0 修复）：找出「最老 pending 帧入队
    /// 超过 `budget`」的流，并把这些流的 pending 载荷**原地**替换成 STREAM_END。
    ///
    /// 不变量：
    /// - 同帧数、同位置替换——pending 尚未分配 seq，替换不动发送序号，
    ///   seq 连续性保持（这是两阶段方案的核心：不 reset、不换 epoch）；
    /// - 只动 pending，不动 inflight（在途帧继续按整体预算重传以维持有序性）；
    /// - 不碰 `abandoned_bytes`（那是 Phase 2 整条 ARQ 判死的口径，必须原样保留）；
    /// - 受害流记入 `abandoned_streams` 供上层显式终结；
    /// - 锚点移除后不重复触发；同流若有新数据再入队，`send()` 会重新计时。
    pub fn exhausted_streams(&mut self, budget: Duration) -> Vec<u16> {
        let now = Instant::now();
        let stuck: Vec<(u16, Instant)> = self.stream_pending_since.iter()
            .filter(|(_, since)| now.duration_since(**since) > budget)
            .map(|(sid, since)| (*sid, *since))
            .collect();
        if stuck.is_empty() { return Vec::new(); }
        for (sid, since) in &stuck {
            self.stream_pending_since.remove(sid);
            let mut replaced = 0usize;
            let mut bytes = 0usize;
            for item in self.pending.iter_mut() {
                if let Some((_, s, _)) = transport::parse_stream_frame(item) {
                    if s == *sid {
                        bytes += item.len();
                        *item = transport::wrap_stream_frame(
                            transport::STREAM_TAG_STREAM_END, *sid, b"STREAM_BUDGET_EXHAUSTED");
                        replaced += 1;
                    }
                }
            }
            // 上层（server 主循环 / client 静默梯）取走后对该流显式 STREAM_END
            self.abandoned_streams.push(*sid);
            println!("  [ARQ] stream {} budget exhausted ({}ms): pending frames replaced with STREAM_END, {}B abandoned",
                sid, now.duration_since(*since).as_millis(), bytes);
        }
        stuck.into_iter().map(|(sid, _)| sid).collect()
    }

    pub fn inflight_bytes(&self) -> usize {
        self.inflight.values()
            .map(|f| f.frame.len().saturating_sub(transport::HEADER_SIZE))
            .sum()
    }

    /// `A_probe_data_plane`：发一个端到端 PING。
    /// 已有探测在等回包时不重复发（返回空帧），避免探测风暴掩盖真实时延。
    pub fn start_probe(&mut self) -> Vec<u8> {
        if self.probe_at.is_some() {
            return Vec::new();
        }
        self.probe_nonce = self.probe_nonce.wrapping_add(1).max(1);
        self.probe_at = Some(Instant::now());
        self.probes_sent += 1;
        transport::build_ping(self.probe_nonce)
    }

    /// 探测是否已超时（timeout 由 A 侧按 RTO 推导）
    pub fn probe_expired(&self, timeout: Duration) -> bool {
        self.probe_at.map_or(false, |at| at.elapsed() >= timeout)
    }

    pub fn probe_outstanding(&self) -> bool {
        self.probe_at.is_some()
    }

    pub fn clear_probe(&mut self) {
        self.probe_at = None;
    }

    /// `A_retransmit_all`：把所有在途帧立刻重发一次（不等 RTO），
    /// 并重置重传计时器。这是**字节保留**的重建动作：不丢任何应用字节，
    /// 因此可以在流未断时安全使用。
    pub fn retransmit_all(&mut self) -> Vec<Vec<u8>> {
        let now = Instant::now();
        self.inflight.values_mut().map(|f| {
            f.sent_at = now;
            f.retries = f.retries.saturating_add(1);
            f.frame.clone()
        }).collect()
    }

    /// 放弃预算（默认 12s，测试可缩短到 ms 级）
    pub fn set_retry_budget(&mut self, budget: Duration) {
        self.retry_budget = budget;
    }

    pub fn retry_budget(&self) -> Duration {
        self.retry_budget
    }

    /// `A_reset_transport`：丢弃本流的 ARQ 状态并换代。
    /// 只有确定放弃这条应用连接时才可以调用——它会丢弃 pending/inflight，
    /// 也就是丢字节。新流用新 `send_epoch`，对端收到首帧即 `stream_changed`
    /// 重建接收状态（这是 relay 路径唯一能用的流重建信号）。
    /// ⚠️ 2026-11-10 坏包修复：此函数**不得**因控制帧（PING/PONG，3B）放弃而调用——
    /// 那会换 epoch → 接收端回摆 → 替换型数据损坏。控制帧放弃走
    /// `take_abandoned_streams()` 按流终结，不整条 reset、不换 epoch。
    pub fn reset_stream(&mut self) {
        // ── 坏包观测：reset_stream 是嫌疑 #3 的入口（放弃→级联）和 #2 的触发器
        // （换 epoch → 竞态）。记录完整丢弃状态。
        let pending_count = self.pending.len();
        let inflight_count = self.inflight.len();
        let ooo_count = self.out_of_order.len();
        let next_seq = self.next_seq;
        let next_exp = self.next_expected;
        let old_epoch = self.send_epoch;
        if pending_count > 0 || inflight_count > 0 || ooo_count > 0 {
            println!("  [ARQ-RESET] DISCARDING pending={}B/{}f inflight={}B/{}f ooo={}B/{}f next_seq={} next_exp={} old_epoch={}",
                self.pending.iter().map(|v| v.len()).sum::<usize>(), pending_count,
                self.inflight.values().map(|f| f.frame.len()).sum::<usize>(), inflight_count,
                self.out_of_order.values().map(|v| v.len()).sum::<usize>(), ooo_count,
                next_seq, next_exp, old_epoch);
        }
        self.pending.clear();
        self.inflight.clear();
        self.out_of_order.clear();
        self.next_expected = 0;
        self.recv_epoch = None;
        self.seen_any = false;
        self.send_epoch = fresh_epoch();
        self.last_ack_received = 0;
        self.dup_ack_count = 0;
        self.abandoned_bytes = 0;
        self.abandoned_streams.clear();
        // per-stream 预算锚点随整条流状态一并作废：reset 后 pending 已清空，
        // 残留锚点会让同号新流（u16 环绕复用）继承陈旧计时而被提前误判耗尽。
        self.stream_pending_since.clear();
        self.probe_at = None;
        self.last_progress = Instant::now();
    }

    // ─── 自适应 RTO (TCP RFC 6298) ───

    fn update_rtt(&mut self, rtt: Duration) {
        match (self.srtt, self.rttvar) {
            (None, _) => {
                self.srtt = Some(rtt);
                self.rttvar = Some(rtt / 2);
            }
            (Some(srtt), Some(rttvar)) => {
                let diff = if rtt > srtt { rtt - srtt } else { srtt - rtt };
                self.srtt = Some(srtt.mul_f64(0.875) + rtt.mul_f64(0.125));
                self.rttvar = Some(rttvar.mul_f64(0.75) + diff.mul_f64(0.25));
            }
            _ => {}
        }
    }

    fn get_rto(&self) -> Duration {
        match (self.srtt, self.rttvar) {
            (Some(srtt), Some(rttvar)) => {
                let rto = srtt + rttvar * 4;
                rto.clamp(Duration::from_millis(RTO_MIN_MS), Duration::from_millis(RTO_MAX_MS))
            }
            _ => Duration::from_millis(RTO_DEFAULT_MS),
        }
    }

    // ─── 状态查询 ───

    pub fn pending_count(&self) -> usize { self.pending.len() }
    pub fn inflight_count(&self) -> usize { self.inflight.len() }
    pub fn rtt_ms(&self) -> Option<u64> { self.srtt.map(|r| r.as_millis() as u64) }
    pub fn rto_ms(&self) -> u64 { self.get_rto().as_millis() as u64 }
}

fn build_data_frame_inner(seq: u32, epoch: u32, data: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(transport::HEADER_SIZE + data.len());
    frame.push(transport::TYPE_DATA);
    frame.extend_from_slice(&seq.to_be_bytes());
    frame.extend_from_slice(&epoch.to_be_bytes());
    frame.extend_from_slice(&(data.len() as u16).to_be_bytes());
    frame.extend_from_slice(data);
    frame
}

fn build_ack_with_sack(ack_seq: u32, epoch: u32, bitmap: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(transport::HEADER_SIZE + bitmap.len());
    frame.push(transport::TYPE_ACK);
    frame.extend_from_slice(&epoch.to_be_bytes());
    frame.extend_from_slice(&ack_seq.to_be_bytes());
    frame.extend_from_slice(&(bitmap.len() as u16).to_be_bytes());
    frame.extend_from_slice(bitmap);
    frame
}

// ─── 测试 ───

#[cfg(test)]
mod tests {
    use super::*;

    // ─── A/B 量化对比测试 ───

    /// A/B：快速重传恢复时间
    #[test]
    fn ab_fast_retransmit_recovery() {
        let mut sender = RelayArq::new();
        let mut receiver = RelayArq::new();
        sender.send(&vec![0u8; 10_000]);
        let (frames, _) = sender.flush_and_tick();

        let t0 = Instant::now();
        for i in 0..5 { let (_, a, _) = receiver.on_packet(&frames[i]); if let Some(x) = a { let _ = sender.on_packet(&x); } }
        // 帧 5 丢失，帧 6-9 到达
        for i in 6..10 {
            let (_, a, _) = receiver.on_packet(&frames[i]);
            if let Some(x) = a {
                let (_, _, fast) = sender.on_packet(&x);
                for f in fast { let _ = receiver.on_packet(&f); }
            }
        }
        let v3_ms = t0.elapsed().as_millis();
        println!("\n  ═══ A/B: 快速重传恢复时间 ═══");
        println!("  v2 (RTO 等待): ~200ms");
        println!("  v3 (快速重传): {}ms", v3_ms);
        println!("  改善: {}x", 200 / v3_ms.max(1));
        assert!(v3_ms < 50);
        assert_eq!(sender.fast_retransmits, 1);
    }

    /// A/B：SACK 节省重传
    #[test]
    fn ab_sack_savings() {
        let mut sender = RelayArq::new();
        let mut receiver = RelayArq::new();
        sender.send(&vec![0u8; 32_000]);
        let (frames, _) = sender.flush_and_tick();

        let lost = [5usize, 10, 15, 20, 25];
        for (i, f) in frames.iter().enumerate() {
            if !lost.contains(&i) {
                let (_, a, _) = receiver.on_packet(f);
                if let Some(x) = a { let _ = sender.on_packet(&x); }
            }
        }

        let remaining = sender.inflight_count();
        println!("\n  ═══ A/B: SACK 重传节省 ═══");
        println!("  v2 (无SACK): RTO后重传 27 帧 (22 帧冗余)");
        println!("  v3 (有SACK): 仅重传 {} 帧 (0 帧冗余)", remaining);
        println!("  SACK 已标记: {} 帧到达", sender.sack_saved);
        println!("  节省: {} 次不必要重传 ({:.1}x 改善)", 27 - remaining, 27.0 / remaining.max(1) as f64);
        assert_eq!(remaining, 5);
        assert!(sender.sack_saved >= 22);
    }

    /// A/B：自适应 RTO
    #[test]
    fn ab_adaptive_rto() {
        let mut sender = RelayArq::new();
        let mut receiver = RelayArq::new();
        for _ in 0..4 {
            sender.send(b"x");
            let (frames, _) = sender.flush_and_tick();
            let (_, a, _) = receiver.on_packet(&frames[0]);
            std::thread::sleep(Duration::from_millis(50));
            let _ = sender.on_packet(&a.unwrap());
        }
        println!("\n  ═══ A/B: 自适应 RTO ═══");
        println!("  v2 (固定):   RTO = 200ms");
        println!("  v3 (自适应): RTT = {}ms → RTO = {}ms", sender.rtt_ms().unwrap_or(0), sender.rto_ms());
        println!("  改善: {}ms 更快超时检测", 200 - sender.rto_ms());
        assert!(sender.rto_ms() < 200);
    }

    /// A/B：综合 100 帧 10% 丢包
    #[test]
    fn ab_comprehensive() {
        let mut sender = RelayArq::new();
        let mut receiver = RelayArq::new();
        sender.send(&vec![0u8; 100_000]);
        let (frames, _) = sender.flush_and_tick();

        let lost: Vec<usize> = (0..10).map(|i| i * 10 + 5).collect();
        for (i, f) in frames.iter().enumerate() {
            if !lost.contains(&i) {
                let (_, a, _) = receiver.on_packet(f);
                if let Some(x) = a {
                    let (_, _, fast) = sender.on_packet(&x);
                    for fr in fast { let _ = receiver.on_packet(&fr); }
                }
            }
        }
        let (_, retrans) = sender.flush_and_tick();
        let retrans_count = retrans.len();
        for f in retrans { let _ = receiver.on_packet(&f); }

        let v3_total = sender.fast_retransmits as usize + retrans_count;
        println!("\n  ═══ A/B: 100帧 10%丢包综合 ═══");
        println!("  v2 预期: 重传 ~90 帧 (~80 帧冗余)");
        println!("  v3 实测: 快速重传 {} + RTO重传 {} = {} 总重传",
            sender.fast_retransmits, sender.retransmitted, v3_total);
        println!("  SACK 节省: {} 次", sender.sack_saved);
        println!("  改善: {:.1}x 减少重传", 90.0 / v3_total.max(1) as f64);
    }


    // ① 快速重传测试
    #[test]
    fn test_fast_retransmit_on_3_dup_acks() {
        let mut sender = RelayArq::new();
        let mut receiver = RelayArq::new();

        // 发 8 帧，帧 2 丢失
        sender.send(&vec![0u8; 8000]); // 8 chunks
        let (frames, _) = sender.flush_and_tick();
        assert_eq!(frames.len(), 8);

        // 帧 0,1 正常到达
        for i in 0..2 {
            let (_, ack, _) = receiver.on_packet(&frames[i]);
            if let Some(a) = ack { let _ = sender.on_packet(&a); }
        }

        // 帧 2 丢失！帧 3,4,5 到达 → 3 个重复 ACK(1)
        let mut fast_retransmit_frames = Vec::new();
        for i in 3..6 {
            let (_, ack, _) = receiver.on_packet(&frames[i]);
            if let Some(a) = ack {
                let (_, _, fast) = sender.on_packet(&a);
                fast_retransmit_frames.extend(fast);
            }
        }

        // 第 3 个重复 ACK 触发快速重传
        assert!(!fast_retransmit_frames.is_empty(),
            "fast retransmit should trigger on 3rd dup ACK");
        assert_eq!(sender.fast_retransmits, 1);

        // 重传帧给接收端 → 帧全交付
        let (deliver, _, _) = receiver.on_packet(&fast_retransmit_frames[0]);
        // 帧 2 + 3,4,5（从 out_of_order 释放）= 4 块交付
        assert!(deliver.len() >= 4,
            "frame 2 + buffered 3,4,5 should all deliver, got {} chunks", deliver.len());
    }

    // ② SACK 测试
    #[test]
    fn test_sack_avoids_unnecessary_retransmit() {
        let mut sender = RelayArq::new();
        let mut receiver = RelayArq::new();

        // 发 8 帧
        sender.send(&vec![0u8; 8000]);
        let (frames, _) = sender.flush_and_tick();
        assert_eq!(frames.len(), 8);

        // 帧 2 和 5 丢失，其余到达
        for i in [0, 1, 3, 4, 6, 7] {
            let (_, ack, _) = receiver.on_packet(&frames[i]);
            if let Some(a) = ack { let _ = sender.on_packet(&a); }
        }

        // SACK 应该让 sender 知道帧 3,4,6,7 已到达
        // sender 的 inflight 应该只剩帧 2 和 5
        let inflight_before = sender.inflight_count();

        // 验证：SACK 已清除已到达帧
        // 帧 0,1 被累积 ACK 清除
        // 帧 3,4,6,7 被 SACK 清除
        // 帧 2,5 仍在 inflight
        assert!(inflight_before <= 2,
            "SACK should have removed received frames, inflight={}", inflight_before);
        assert!(sender.sack_saved >= 4,
            "SACK should have saved at least 4 retransmissions, saved={}", sender.sack_saved);
    }

    // ③ 自适应 RTO 测试
    #[test]
    fn test_adaptive_rto() {
        let mut sender = RelayArq::new();

        // 初始 RTO = 默认 200ms
        assert_eq!(sender.rto_ms(), 200);

        // 发帧并模拟 50ms RTT 的 ACK
        sender.send(b"hello");
        let (frames, _) = sender.flush_and_tick();

        let mut receiver = RelayArq::new();
        let (_, ack, _) = receiver.on_packet(&frames[0]);

        // 模拟 50ms 延迟
        std::thread::sleep(Duration::from_millis(50));
        if let Some(a) = ack {
            let _ = sender.on_packet(&a);
        }

        // SRTT ≈ 50ms, RTO = SRTT + 4×RTTVAR ≈ 50 + 4×25 = 150ms
        let rto = sender.rto_ms();
        assert!(rto < 200, "adaptive RTO should be < default after 50ms RTT, got {}", rto);
        assert!(rto >= 50, "adaptive RTO should be >= RTT, got {}", rto);

        // 多次 RTT 测量后 RTO 应收敛
        for _ in 0..5 {
            sender.send(b"x");
            let (frames, _) = sender.flush_and_tick();
            let (_, ack, _) = receiver.on_packet(&frames[0]);
            std::thread::sleep(Duration::from_millis(50));
            if let Some(a) = ack { let _ = sender.on_packet(&a); }
        }
        let final_rto = sender.rto_ms();
        assert!(final_rto < 150, "RTO should converge toward SRTT+4*RTTVAR ≈ 100ms, got {}", final_rto);
    }

    // 流控窗口测试：一次填满窗口（或全量，若总量小于窗口），剩余留在 pending。
    // 窗口无关写法：缺省窗口变更（32→128）后无需改此测试。
    #[test]
    fn test_flow_control_window() {
        let mut raq = RelayArq::new();
        raq.send(&vec![0u8; 100_000]);
        let (frames, _) = raq.flush_and_tick();
        let total = (100_000 + chunk_size() - 1) / chunk_size();
        assert_eq!(frames.len(), total.min(window_size()));
        assert_eq!(raq.pending_count(), total.saturating_sub(window_size()));
    }

    // 回环测试（保留）
    #[test]
    fn test_roundtrip() {
        let mut sender = RelayArq::new();
        let mut receiver = RelayArq::new();
        let data = b"hello v3";
        sender.send(data);
        let (frames, _) = sender.flush_and_tick();
        let mut all = Vec::new();
        for f in &frames {
            let (deliver, ack, _) = receiver.on_packet(f);
            all.extend(deliver);
            if let Some(a) = ack { let _ = sender.on_packet(&a); }
        }
        assert_eq!(all.concat(), data);
        assert_eq!(sender.inflight_count(), 0);
    }

    /// 对端续流时，本端是新 RelayArq：第一帧无论 seq 是多少都必须初始化并交付。
    /// 这是 server 重启后 client 继续发送的确定性红例（R1b）。
    #[test]
    fn test_first_frame_accepts_nonzero_sequence() {
        let mut receiver = RelayArq::new();
        let (deliver, ack) = receiver.handle_data(7, 1, b"resume");
        assert_eq!(deliver.len(), 1, "新接收器首帧 seq=7 被错误卡在乱序缓存");
        assert_eq!(deliver[0], b"resume");
        assert_eq!(ack, 7);
    }

    /// 发送端换代（server 重启）必须让接收器按新 epoch 重置，不能把新流当旧重复帧。
    #[test]
    fn test_new_sender_epoch_resets_receiver() {
        fn frame(seq: u32, epoch: u32, data: &[u8]) -> Vec<u8> {
            let mut f = build_data_frame_inner(seq, epoch, data);
            f[5..9].copy_from_slice(&epoch.to_be_bytes()); // DATA 的保留 ack 位承载 epoch
            f
        }
        let mut receiver = RelayArq::new();
        let (d1, _, _) = receiver.on_packet(&frame(5, 111, b"old"));
        assert_eq!(d1.len(), 1);
        let (d2, ack, _) = receiver.on_packet(&frame(0, 222, b"new"));
        assert_eq!(d2.len(), 1, "新 epoch 的 seq=0 被误判为旧流重复帧");
        assert_eq!(d2[0], b"new");
        assert_eq!(ack.unwrap()[5..9], 0u32.to_be_bytes(), "ACK 应确认新 epoch 的 seq=0");
    }

    /// 旧 epoch 的 ACK 不得清除当前 epoch 的在途帧。
    #[test]
    fn test_stale_epoch_ack_is_ignored() {
        let mut sender = RelayArq::new();
        sender.send(b"current");
        let (frames, _) = sender.flush_and_tick();
        assert_eq!(frames.len(), 1);
        let current_epoch = u32::from_be_bytes(frames[0][5..9].try_into().unwrap());
        let mut ack = build_ack_with_sack(0, current_epoch, &[]);
        ack[1..5].copy_from_slice(&(current_epoch.wrapping_add(1)).to_be_bytes());
        let _ = sender.on_packet(&ack);
        assert_eq!(sender.inflight_count(), 1, "旧 epoch ACK 错误清空了当前在途帧");
    }

    // ─── 数据面静默检测（R9）───

    /// 空闲 ARQ 没有待交付数据 → 不能被判成黑洞。
    #[test]
    fn test_idle_arq_is_not_expect_data() {
        let arq = RelayArq::new();
        assert!(!arq.expect_data(), "空闲连接被误判为有待交付数据");
        assert_eq!(arq.abandoned_bytes(), 0);
    }

    /// expect_data 只在有排队/在途字节时为真。
    #[test]
    fn test_expect_data_tracks_pending_and_inflight() {
        let mut arq = RelayArq::new();
        arq.send(b"hello");
        assert!(arq.expect_data(), "有排队字节却认为不期待数据");
        let (frames, _) = arq.flush_and_tick();
        assert_eq!(frames.len(), 1);
        assert!(arq.expect_data(), "有在途未确认帧却认为不期待数据");
        // 对端确认后应为空
        let epoch = u32::from_be_bytes(frames[0][5..9].try_into().unwrap());
        let _ = arq.on_packet(&build_ack_with_sack(0, epoch, &[]));
        assert!(!arq.expect_data(), "全部确认后仍认为期待数据");
    }

    /// PING 必须被回 PONG（端到端往返证据的唯一来源）。
    #[test]
    fn test_ping_is_answered_with_pong() {
        let mut peer = RelayArq::new();
        let (deliver, reply, _) = peer.on_packet(&transport::build_ping(4242));
        assert!(deliver.is_empty(), "PING 不得进入应用字节流");
        let pong = reply.expect("PING 没有回 PONG");
        assert_eq!(pong[0], transport::TYPE_PONG);
        assert_eq!(&pong[1..5], &4242u32.to_be_bytes(), "PONG 必须原样带回 nonce");
    }

    /// 只有自己发过、nonce 对得上的 PONG 才算数据面进展。
    #[test]
    fn test_pong_only_counts_for_outstanding_probe() {
        let mut arq = RelayArq::new();
        // 没有探测在途时的 PONG 不算
        let _ = arq.on_packet(&transport::build_pong(1));
        assert_eq!(arq.probes_ok, 0);
        // 发探测
        let ping = arq.start_probe();
        assert_eq!(ping[0], transport::TYPE_PING);
        assert!(!arq.start_probe().len().gt(&0) && arq.probes_sent == 1, "探测在途时不得重复发");
        assert!(arq.probe_outstanding());
        // 错误 nonce 不算
        let _ = arq.on_packet(&transport::build_pong(999));
        assert!(arq.probe_outstanding(), "错误 nonce 的 PONG 被接受");
        // 正确 nonce 才算
        let nonce = u32::from_be_bytes(ping[1..5].try_into().unwrap());
        let _ = arq.on_packet(&transport::build_pong(nonce));
        assert!(!arq.probe_outstanding());
        assert_eq!(arq.probes_ok, 1);
    }

    /// 放弃预算耗尽必须记入 abandoned_bytes，禁止静默丢字节。
    #[test]
    fn test_retry_budget_exhaustion_reports_abandoned_bytes() {
        let mut arq = RelayArq::new();
        arq.set_retry_budget(Duration::from_millis(400)); // 缩短预算，保持测试快
        arq.send(&vec![0u8; 1000]);
        let (frames, _) = arq.flush_and_tick();
        assert_eq!(frames.len(), 1);
        let mut rounds = 0;
        while arq.abandoned_bytes() == 0 && rounds < 80 {
            std::thread::sleep(Duration::from_millis(50));
            let _ = arq.flush_and_tick();
            rounds += 1;
        }
        assert_eq!(arq.abandoned_bytes(), 1000, "放弃的字节没有记账（静默丢字节）");
        assert_eq!(arq.inflight_count(), 0);
    }

    /// ARQ-LOST 必须上报被放弃帧所属的 stream id（task.md §6.1-8）：
    /// 放弃 = 该流字节流永久缺口，server 必须对该流显式发 STREAM_END，
    /// 否则 client 只能等上层超时才知道流已残缺（真实事故：响应滴流 5s 被上层掐）。
    #[test]
    fn test_retry_budget_exhaustion_reports_abandoned_stream_ids() {
        let mut arq = RelayArq::new();
        arq.set_retry_budget(Duration::from_millis(400)); // 缩短预算，保持测试快
        // 载荷 = 连接多路复用内层帧（DATA on stream 0x1234），与 connection.rs
        // 下行路径 s.arq.send(wrap_stream_frame(...)) 同构
        arq.send(&transport::wrap_stream_frame(transport::STREAM_TAG_DATA, 0x1234, b"payload"));
        let (frames, _) = arq.flush_and_tick();
        assert_eq!(frames.len(), 1);
        assert!(arq.take_abandoned_streams().is_empty(), "尚未放弃就有流被上报");
        let mut rounds = 0;
        while arq.abandoned_bytes() == 0 && rounds < 80 {
            std::thread::sleep(Duration::from_millis(50));
            let _ = arq.flush_and_tick();
            rounds += 1;
        }
        assert!(arq.abandoned_bytes() > 0, "预算耗尽仍未放弃（测试自身失效）");
        let sids = arq.take_abandoned_streams();
        assert_eq!(sids, vec![0x1234u16], "放弃帧的 stream id 没有上报（client 无从得知流已残缺）");
        // 取走即清空：同一放弃事件不得重复触发 STREAM_END
        assert!(arq.take_abandoned_streams().is_empty(), "take 后未清空");
    }

    // ─── per-stream retry budget（Phase 1，RDP P0：单流卡死不连坐）───

    /// 预算内：没有流超预算 → 返回空，pending 不被替换。
    #[test]
    fn test_exhausted_streams_empty_when_no_stream_exceeds_budget() {
        let mut arq = RelayArq::new();
        arq.send(&transport::wrap_stream_frame(transport::STREAM_TAG_DATA, 0x1111, b"stuck-or-not"));
        arq.send(&transport::wrap_stream_frame(transport::STREAM_TAG_DATA, 0x2222, b"healthy"));
        assert!(arq.exhausted_streams(Duration::from_secs(12)).is_empty(),
            "预算内就有流被误判耗尽");
        assert_eq!(arq.pending_count(), 2, "预算内的 pending 帧被动过");
        // 载荷原样保留（未被替换成 STREAM_END）
        for item in arq.pending.iter() {
            let (tag, _, _) = transport::parse_stream_frame(item).unwrap();
            assert_eq!(tag, transport::STREAM_TAG_DATA);
        }
        assert!(arq.take_abandoned_streams().is_empty(), "未耗尽就有流被上报");
    }

    /// 预算后：只有卡死流被上报（锚点移除不重复触发），健康流的 pending 不被替换。
    #[test]
    fn test_exhausted_streams_returns_stuck_sid_after_budget() {
        let mut arq = RelayArq::new();
        arq.send(&transport::wrap_stream_frame(transport::STREAM_TAG_DATA, 0x1111, b"stuck"));
        arq.send(&transport::wrap_stream_frame(transport::STREAM_TAG_DATA, 0x2222, b"healthy"));
        // 把 0x1111 的锚点拨回 13s 前，模拟该流 pending 已卡满 12s 预算
        // （0x2222 保持刚入队，未超预算）
        arq.stream_pending_since.insert(0x1111, Instant::now() - Duration::from_secs(13));
        let sids = arq.exhausted_streams(Duration::from_secs(12));
        assert_eq!(sids, vec![0x1111u16], "卡死流没有被上报（会连坐整条隧道）");
        // 锚点已移除：不重复触发
        assert!(arq.exhausted_streams(Duration::from_secs(12)).is_empty(),
            "同一次卡死被重复上报");
        // 健康流的 pending 载荷原样保留
        let healthy = arq.pending.iter()
            .find(|item| matches!(transport::parse_stream_frame(item),
                Some((_, 0x2222, _))))
            .expect("健康流的 pending 帧丢失");
        let (tag, sid, rest) = transport::parse_stream_frame(healthy).unwrap();
        assert_eq!((tag, sid, rest),
            (transport::STREAM_TAG_DATA, 0x2222, &b"healthy"[..]));
        // 受害流已记入 abandoned_streams（上层显式终结的口径）
        assert!(arq.take_abandoned_streams().contains(&0x1111),
            "耗尽流没有记入 abandoned_streams");
    }

    /// 替换语义：耗尽流的 pending 帧原地换成 STREAM_END（同帧数、同位置），
    /// 其他流的 pending 帧与全部 inflight 帧不动——seq 连续性由此保持。
    #[test]
    fn test_exhausted_streams_replaces_pending_with_stream_end_in_place() {
        let mut arq = RelayArq::new();
        // 制造超过窗口的 backlog：A 流 130 帧先进（占满 inflight 窗口后溢出到
        // pending），B 流 2 帧最后入队（必在 pending）。chunk=1000B，A 每帧 900B 载荷。
        for i in 0..130u16 {
            let payload = vec![i as u8; 900];
            arq.send(&transport::wrap_stream_frame(transport::STREAM_TAG_DATA, 0xAAAA, &payload));
        }
        arq.send(&transport::wrap_stream_frame(transport::STREAM_TAG_DATA, 0xBBBB, b"healthy-1"));
        arq.send(&transport::wrap_stream_frame(transport::STREAM_TAG_DATA, 0xBBBB, b"healthy-2"));
        let (frames, _) = arq.flush_and_tick();
        assert_eq!(frames.len(), window_size(), "前 128 帧应进 inflight");
        let pending_before = arq.pending_count();
        assert!(pending_before >= 3, "pending 应留有 A 溢出帧与 B 帧（测试前提）");
        let inflight_before = arq.inflight_count();

        // A 流卡满预算 → 只有 A 的 pending 被替换
        arq.stream_pending_since.insert(0xAAAA, Instant::now() - Duration::from_secs(13));
        let sids = arq.exhausted_streams(Duration::from_secs(12));
        assert_eq!(sids, vec![0xAAAAu16]);

        // 帧数不变（seq 连续性）：替换不增删 pending/inflight
        assert_eq!(arq.pending_count(), pending_before, "替换改变了 pending 帧数");
        assert_eq!(arq.inflight_count(), inflight_before, "替换动了 inflight");

        // 逐帧解析验证：A 的 pending 帧 → STREAM_END + 约定载荷；B 的 → 原 DATA
        let mut a_end = 0usize;
        for item in arq.pending.iter() {
            match transport::parse_stream_frame(item) {
                Some((tag, 0xAAAA, rest)) => {
                    assert_eq!(tag, transport::STREAM_TAG_STREAM_END, "A 的 pending 未换成 STREAM_END");
                    assert_eq!(rest, &b"STREAM_BUDGET_EXHAUSTED"[..]);
                    a_end += 1;
                }
                Some((tag, 0xBBBB, rest)) => {
                    assert_eq!(tag, transport::STREAM_TAG_DATA, "B 的 pending 被误改");
                    assert!(rest.starts_with(b"healthy-"), "B 的载荷被误改");
                }
                other => panic!("pending 出现非 A/B 流帧: {:?}", other.map(|(t, s, _)| (t, s))),
            }
        }
        assert!(a_end > 0, "A 在 pending 的溢出帧一帧都没换到（测试前提失效）");
        // inflight 全部保持 DATA（在途帧继续重传，维持 seq 连续性）
        for f in frames.iter() {
            let inner = &f[transport::HEADER_SIZE..];
            let (tag, sid, _) = transport::parse_stream_frame(inner).unwrap();
            assert_eq!(tag, transport::STREAM_TAG_DATA, "inflight 帧被替换（破坏 seq 连续性）");
            assert_eq!(sid, 0xAAAA);
        }
    }

    /// ACK 清锚点：健康回合结束后（有进展且该流无 pending 帧），锚点必须清除，
    /// 否则健康流带着陈旧计时在下一轮静默中被误判「卡了 12s」。
    #[test]
    fn test_stream_pending_since_cleared_after_ack_drains_pending() {
        let mut sender = RelayArq::new();
        let mut receiver = RelayArq::new();
        sender.send(&transport::wrap_stream_frame(transport::STREAM_TAG_DATA, 0x1234, b"payload"));
        let (frames, _) = sender.flush_and_tick();
        assert!(sender.stream_pending_since.contains_key(&0x1234), "send 未建立锚点");
        let (_, ack, _) = receiver.on_packet(&frames[0]);
        let _ = sender.on_packet(&ack.unwrap()); // ACK 清掉在途帧 = 有进展
        assert!(!sender.stream_pending_since.contains_key(&0x1234),
            "ACK 后锚点未清除（健康流会被陈旧计时误判）");
        // 全部确认后的 exhausted_streams 永远为空（无 pending 可替换）
        assert!(sender.exhausted_streams(Duration::from_millis(0)).is_empty());
    }

    /// R9b 的单元级回归：2 秒无 ACK 只是瞬断，绝不允许放弃字节。
    #[test]
    fn test_transient_stall_is_not_abandoned_within_budget() {
        let mut arq = RelayArq::new(); // 默认 12s 预算
        arq.send(b"survive-2s-stall");
        let (frames, _) = arq.flush_and_tick();
        assert_eq!(frames.len(), 1);
        let mut retransmits = 0;
        for _ in 0..12 {
            std::thread::sleep(Duration::from_millis(200)); // 合计 ~2.4s 静默
            let (_, retrans) = arq.flush_and_tick();
            retransmits += retrans.len();
        }
        assert_eq!(arq.abandoned_bytes(), 0, "2 秒静默就放弃字节（瞬断被判死）");
        assert_eq!(arq.inflight_count(), 1, "在途帧已丢失，恢复不可能");
        assert!(retransmits >= 1, "静默期间一次重传都没有");
    }

    /// RFC 6298 指数退避：翻倍且有上限，避免 12 秒预算内打成重传风暴。
    #[test]
    fn test_backoff_doubles_and_caps() {
        let rto = Duration::from_millis(200);
        assert_eq!(backoff_rto(rto, 0).as_millis(), 200);
        assert_eq!(backoff_rto(rto, 1).as_millis(), 400);
        assert_eq!(backoff_rto(rto, 2).as_millis(), 800);
        assert_eq!(backoff_rto(rto, 3).as_millis(), 1600);
        assert_eq!(backoff_rto(rto, 4).as_millis(), 3200);
        assert_eq!(backoff_rto(rto, 99).as_millis(), 3200); // 因子封顶 2^4
        // 慢链路（RTO 已达 2s）也必须被 BACKOFF_CAP_MS 封住，不能退避到不可接受
        assert_eq!(backoff_rto(Duration::from_millis(2000), 99).as_millis() as u64,
                   BACKOFF_CAP_MS);
    }

    /// retransmit_all 是字节保留动作：帧数与 payload 都必须不变。
    #[test]
    fn test_retransmit_all_preserves_bytes() {
        let mut arq = RelayArq::new();
        arq.send(b"abcdefgh");
        let (frames, _) = arq.flush_and_tick();
        assert_eq!(frames.len(), 1);
        let again = arq.retransmit_all();
        assert_eq!(again.len(), 1);
        assert_eq!(&again[0][transport::HEADER_SIZE..], &frames[0][transport::HEADER_SIZE..]);
        assert_eq!(again[0][0], transport::TYPE_DATA);
    }

    /// reset_stream 必须换代（对端据此重建接收状态）并清空在途/待发。
    #[test]
    fn test_reset_stream_bumps_epoch() {
        let mut arq = RelayArq::new();
        arq.send(b"lost");
        let (frames, _) = arq.flush_and_tick();
        let old_epoch = u32::from_be_bytes(frames[0][5..9].try_into().unwrap());
        arq.reset_stream();
        assert!(!arq.expect_data());
        assert_eq!(arq.abandoned_bytes(), 0);
        arq.send(b"fresh");
        let (frames2, _) = arq.flush_and_tick();
        let new_epoch = u32::from_be_bytes(frames2[0][5..9].try_into().unwrap());
        assert_ne!(old_epoch, new_epoch, "reset_stream 未换代，对端会按旧流丢弃新数据");
    }

    // 多帧丢失 + SACK + 快速重传联合测试
    #[test]
    fn test_multi_loss_with_sack_and_fast_retransmit() {
        let mut sender = RelayArq::new();
        let mut receiver = RelayArq::new();

        // 发 16 帧
        sender.send(&vec![0u8; 16000]);
        let (frames, _) = sender.flush_and_tick();
        assert_eq!(frames.len(), 16);

        // 帧 3, 7, 11 丢失，其余到达
        let lost = [3usize, 7, 11];
        for (i, frame) in frames.iter().enumerate() {
            if !lost.contains(&i) {
                let (_, ack, _) = receiver.on_packet(frame);
                if let Some(a) = ack {
                    let (_, _, fast) = sender.on_packet(&a);
                    // 快速重传帧（如果有）
                    for f in fast {
                        let _ = receiver.on_packet(&f);
                    }
                }
            }
        }

        // tick → 重传剩余缺失帧
        let (new_f, retrans_f) = sender.flush_and_tick();
        // 发送重传帧
        for f in retrans_f {
            let (deliver, ack, _) = receiver.on_packet(&f);
            if let Some(a) = ack { let _ = sender.on_packet(&a); }
        }

        // 所有帧应该已交付
        // 验证：SACK 减少了不必要的重传
        assert!(sender.sack_saved > 0, "SACK should have saved retransmissions");
    }
}
