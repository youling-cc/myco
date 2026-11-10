//! PeerListener —— 同进程 accept 直交（task.md §11 H.3.2 方案 A，2026-11-09 21:35 给 myco）
//!
//! 形态：vnet 只做「认证后的连接来源」，不再替宿主代理字节。
//! 注册了 PeerListener 的端口，server 侧三路径（relay / P2P-v4 / P2P-v6）的
//! SESSION_START **不回连** `127.0.0.1:<target>`，而是：
//!   1. 建一个本地 TCP 对（回环 bind/connect/accept；Windows 无 socketpair(2)）；
//!   2. 把 `(PeerIdentity, 宿主端)` 投进该端口的有界队列，所有权完全转移给宿主；
//!   3. 隧道侧拿另一端当该流的 upstream，照旧泵隧道数据——协议、ARQ、泵逻辑零改动。
//! 宿主拿到的是真 TcpStream（已 nonblocking，tokio `from_std` 直接可用）+ 已验签身份，
//! 无 VNETP 前导、无环回、无自证（方案 B 的三类 bug 就地消灭）。
//!
//! 语义（与 myco 冻结的五点，task.md H.3.2）：
//!   1) 注册/注销：`bind`/`close(self)`（消费式，防重复）；同口重复注册 → Err。
//!   2) TcpStream 所有权完全转移；vnet 侧只保留 accepted 计数，不统计 active。
//!   3) 背压：有界队列满时投递方阻塞等待（HANDOFF_TIMEOUT 内），不丢连接、不静默拒绝；
//!      超时后显式 `STREAM_END(PL_SATURATED)`（G6）。
//!   4) close 后：已 hand-off 的连接继续存活（宿主拥有）；只是不再有新连接进入。
//!   5) conn limiter（conn_rate）在直交模式下仍在 vnet 侧生效（调用方先过限速再投递）。
//!
//! 注册表按端口进程级唯一：server 侧 dispatch 线程（start_server_*）不持有任何
//! Connection 对象，挂接点只能是进程级注册表（与 identity.rs 的全局状态同款模式）。

use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 队列满时的投递等待上限。来源：G4「alive 外观下黑洞 ≤ 15s」——dispatch 线程被
/// 顶住期间同进程其他 peer 的数据也停摆，必须先于 15s 显式收口（取 10s 留余量）。
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(10);
/// 队列满时的轮询间隔（try_send + sleep；宿主 accept 的唤醒粒度足够）
const PUSH_POLL: Duration = Duration::from_millis(5);

/// 已认证连接：所有权完全转移给宿主（H.3.2 五点之 2——vnet 不再持有句柄、
/// 不读写、不传播半关闭；宿主 drop = 关闭）。
#[derive(Debug)]
pub struct PeerConn {
    pub peer: crate::identity::PeerIdentity,
    /// 本端（server 侧）监听口 = SESSION_START 解析出的 target 口
    pub local_port: u16,
    /// 已 set_nonblocking(true)：宿主可直接 `tokio::net::TcpStream::from_std`
    pub stream: std::net::TcpStream,
}

/// 每个端口一个投递槽：有界队列发送端 + stop 旗 + accepted 计数
struct Slot {
    tx: SyncSender<PeerConn>,
    stop: Arc<AtomicBool>,
    accepted: Arc<AtomicU64>,
}

/// 进程级注册表（端口 → 投递槽）。server 侧 dispatch 线程从这里查直交接管点。
static REGISTRY: OnceLock<Mutex<HashMap<u16, Slot>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<u16, Slot>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 由 vnet 的 server 侧 dispatch 投递；宿主用自己的循环取（H.3.2 API 形状）。
#[derive(Debug)]
pub struct PeerListener {
    port: u16,
    rx: Receiver<PeerConn>,
    stop: Arc<AtomicBool>,
    accepted: Arc<AtomicU64>,
}

impl PeerListener {
    /// 按端口注册（核心实现；server-only 宿主进程没有 Connection 对象时用这个）。
    /// 同口重复注册 → Err（语义 1，不静默复用/覆盖）。
    pub fn bind_port(local_port: u16, capacity: usize) -> anyhow::Result<Self> {
        if local_port == 0 {
            anyhow::bail!("PL_PORT_INVALID: local_port must not be 0");
        }
        if capacity == 0 {
            // sync_channel(0) 是 rendezvous 语义：投递会硬等宿主同时 recv，
            // dispatch 线程被钉死的风险不可接受，直接显式拒绝
            anyhow::bail!("PL_INVALID_CAPACITY: capacity must be >= 1");
        }
        let mut reg = registry().lock().unwrap();
        if reg.contains_key(&local_port) {
            anyhow::bail!("PL_PORT_IN_USE: local port {} already has a PeerListener", local_port);
        }
        let (tx, rx) = std::sync::mpsc::sync_channel::<PeerConn>(capacity);
        let stop = Arc::new(AtomicBool::new(false));
        let accepted = Arc::new(AtomicU64::new(0));
        reg.insert(local_port, Slot { tx, stop: stop.clone(), accepted: accepted.clone() });
        drop(reg);
        println!("  [PL] listener bound :{} (capacity={}, in-process accept hand-off)",
            local_port, capacity);
        Ok(Self { port: local_port, rx, stop, accepted })
    }

    /// H.3.2 冻结的 API 形状（`bind(conn, local_port, cap)`）。
    /// `conn` 仅为接口兼容保留：直交的挂接点在本进程 **server 侧** stream dispatch
    /// （start_server_* 线程），与 client 侧 Connection 无从属关系；注册按端口
    /// 进程级唯一。宿主 server 进程拿不到 Connection 时直接用 [`bind_port`]。
    pub fn bind(
        conn: &std::sync::Arc<crate::connection::Connection>,
        local_port: u16,
        capacity: usize,
    ) -> anyhow::Result<Self> {
        let _ = conn;
        Self::bind_port(local_port, capacity)
    }

    /// 阻塞取一条；通道断开（listener 已关闭）后返回 None，不永久挂起。
    pub fn accept(&self) -> Option<PeerConn> {
        self.rx.recv().ok()
    }

    /// 非阻塞取一条（空/已关闭都返回 None）。
    pub fn try_accept(&self) -> Option<PeerConn> {
        self.rx.try_recv().ok()
    }

    /// 消费式注销（防重复 close）。立即停止接新连接；
    /// **已 hand-off 的连接不受影响**（所有权在宿主，语义 4）。
    pub fn close(self) {
        println!("  [PL] listener :{} closed (handed out {} conn(s); handed-out connections survive)",
            self.port, self.accepted.load(Ordering::Relaxed));
        // 摘表/断通道走 Drop（self 在此 drop）
    }

    /// 该 listener 累计直交出的连接数（vnet 侧唯一保留的计数，语义 2）
    pub fn accepted_count(&self) -> u64 {
        self.accepted.load(Ordering::Relaxed)
    }
}

impl Drop for PeerListener {
    fn drop(&mut self) {
        // 先立 stop 旗（投递侧的 bounded push 立即收口），再摘注册表槽——
        // tx 随槽 drop，阻塞中的 try_send 会收到 Disconnected。
        self.stop.store(true, Ordering::Relaxed);
        registry().lock().unwrap().remove(&self.port);
    }
}

/// 按端口注销（= 关闭该端口的 PeerListener）。
/// 供 remove_forward 同义语/宿主按口收口用；返回是否存在。
/// 注意：PeerListener 对象本身还活着时先调它会先断通道（对象随后 Drop 幂等摘表）。
pub fn close_port(local_port: u16) -> bool {
    let mut reg = registry().lock().unwrap();
    match reg.remove(&local_port) {
        Some(slot) => {
            slot.stop.store(true, Ordering::Relaxed);
            println!("  [PL] listener :{} closed by port (handed out {} conn(s))",
                local_port, slot.accepted.load(Ordering::Relaxed));
            true
        }
        None => false,
    }
}

/// 本地 TCP 对：回环临时口 bind → connect → accept（Windows 无 socketpair(2)，
/// 三步等价实现，两端都是真 TcpStream）。返回 (宿主端, 隧道端)，均 nonblocking——
/// 宿主端对 tokio `from_std`，隧道端与既有回连上游同款非阻塞泵语义。
fn tcp_pair() -> std::io::Result<(TcpStream, TcpStream)> {
    let ln = TcpListener::bind(("127.0.0.1", 0))?;
    let addr = ln.local_addr()?;
    let host_end = TcpStream::connect(addr)?;
    let tunnel_end = ln.accept()?.0;
    host_end.set_nonblocking(true)?;
    tunnel_end.set_nonblocking(true)?;
    Ok((host_end, tunnel_end))
}

fn slot_of(port: u16) -> Option<(SyncSender<PeerConn>, Arc<AtomicBool>, Arc<AtomicU64>)> {
    let reg = registry().lock().unwrap();
    reg.get(&port).map(|s| (s.tx.clone(), s.stop.clone(), s.accepted.clone()))
}

/// server 侧三路径（relay / P2P-v4 / P2P-v6）SESSION_START 建上游时的直交接管点。
/// 调用时机：conn limiter 之后、回连之前。
/// - `Ok(None)`：该口没注册 PeerListener → 调用方走既有回连（VNETP 前导逻辑不变）；
/// - `Ok(Some(tunnel_end))`：直交成功，tunnel_end 作为该流 upstream（nonblocking）；
/// - `Err(code)`：显式拒绝（调用方回 `STREAM_END(code)`，G6 不静默不挂起）。
pub(crate) fn take_upstream(
    ident: Option<&crate::identity::PeerIdentity>,
    local_port: u16,
    path: &str,
) -> Result<Option<TcpStream>, &'static str> {
    let Some((tx, stop, accepted)) = slot_of(local_port) else {
        return Ok(None); // 未注册 → 既有行为
    };
    // fail closed（G3）：直交的卖点就是「认证后的连接来源」。本端没开身份认证时
    // 闸门给不出 PeerIdentity——绝不能把无身份连接伪装成已认证结构交给宿主。
    let Some(peer) = ident else {
        println!("  [PL] DENY port={} code=AUTH_REQUIRED path={} (server identity not enabled; direct hand-off requires verified peer)",
            local_port, path);
        return Err("AUTH_REQUIRED");
    };
    let (host_end, tunnel_end) = match tcp_pair() {
        Ok(p) => p,
        Err(e) => {
            println!("  [PL] DENY port={} code=PL_PAIR_FAILED path={} ({})",
                local_port, path, e);
            return Err("PL_PAIR_FAILED");
        }
    };
    // 有界入队（背压，语义 3）：队列满时在 HANDOFF_TIMEOUT 窗口内等宿主取走，
    // 期间 dispatch 线程停摆 → 隧道 ARQ 窗口收缩 → 对端自然受压（不丢连接）。
    // 超时/关闭都显式拒绝；两端 socket 随返回值/pc drop 而关闭，无悬挂。
    let mut pc = PeerConn { peer: peer.clone(), local_port, stream: host_end };
    let deadline = Instant::now() + HANDOFF_TIMEOUT;
    loop {
        if stop.load(Ordering::Relaxed) {
            println!("  [PL] DENY port={} code=PL_CLOSED path={}", local_port, path);
            return Err("PL_CLOSED");
        }
        match tx.try_send(pc) {
            Ok(()) => {
                accepted.fetch_add(1, Ordering::Relaxed);
                crate::tracelog!("[PL] hand-off port={} did={} key_id={} path={}",
                    local_port, peer.did, peer.key_id, path);
                return Ok(Some(tunnel_end));
            }
            Err(TrySendError::Full(back)) => {
                pc = back;
                if Instant::now() >= deadline {
                    println!("  [PL] DENY port={} code=PL_SATURATED path={} (queue full for {:?})",
                        local_port, path, HANDOFF_TIMEOUT);
                    return Err("PL_SATURATED");
                }
                std::thread::sleep(PUSH_POLL);
            }
            Err(TrySendError::Disconnected(_)) => {
                println!("  [PL] DENY port={} code=PL_CLOSED path={}", local_port, path);
                return Err("PL_CLOSED");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    /// 测试专用端口（契约纪律：独立测试用 20000+，且各用例互不冲突以便并行）
    fn tport(tag: u16) -> u16 {
        25901 + tag
    }

    fn fake_peer(tag: u8) -> crate::identity::PeerIdentity {
        crate::identity::PeerIdentity {
            did: format!("did:myco:pl-test{}", tag),
            key_id: format!("kid{:02x}", tag),
            peer_id: 900 + tag as u32,
            verified_at: 1_730_000_000,
        }
    }

    /// nonblocking 流上带重试的读（回环写完即可读，仅防御 WouldBlock 抖动）
    fn read_expect(s: &mut TcpStream, n: usize) -> Vec<u8> {
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut out = Vec::with_capacity(n);
        let mut buf = [0u8; 256];
        while out.len() < n {
            match s.read(&mut buf) {
                Ok(0) => panic!("EOF before {} bytes (got {})", n, out.len()),
                Ok(k) => out.extend_from_slice(&buf[..k]),
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "read timeout, got {} bytes", out.len());
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(e) => panic!("read: {}", e),
            }
        }
        out
    }

    /// 基本往返：bind → 直交投递 → accept 拿到 (身份, 端口, nonblocking 流)，
    /// 且双向字节都能通（隧道端 ⇄ 宿主端）。
    #[test]
    fn test_bind_accept_roundtrip() {
        let p = tport(1);
        let listener = PeerListener::bind_port(p, 4).unwrap();
        let peer = fake_peer(1);
        let tunnel_end = take_upstream(Some(&peer), p, "test")
            .expect("hand-off must succeed when listener bound")
            .expect("must hand off, not fall back to connect");
        let mut conn = listener.accept().expect("accept must return the handed-off conn");
        assert_eq!(conn.peer, peer, "身份必须原样随连接转移");
        assert_eq!(conn.local_port, p);
        assert!(conn.stream.set_nonblocking(false).is_ok(), "nonblocking 流可正常复用");
        // 隧道 → 宿主
        (&tunnel_end).write_all(b"up-bytes").unwrap();
        assert_eq!(read_expect(&mut conn.stream, 8), b"up-bytes");
        // 宿主 → 隧道（半双工验证即可证明双向）
        let mut te = tunnel_end;
        conn.stream.write_all(b"down").unwrap();
        assert_eq!(read_expect(&mut te, 4), b"down");
        assert_eq!(listener.accepted_count(), 1);
    }

    /// 语义 1：同口重复注册 → Err（不静默复用/覆盖）
    #[test]
    fn test_duplicate_bind_rejected() {
        let p = tport(2);
        let _l1 = PeerListener::bind_port(p, 4).unwrap();
        let err = PeerListener::bind_port(p, 8).unwrap_err();
        let msg = format!("{:#}", err);
        assert!(msg.contains("PL_PORT_IN_USE"), "got: {}", msg);
        // close 后同口可重绑（摘表生效）
        drop(_l1);
        let _l2 = PeerListener::bind_port(p, 4)
            .expect("rebind after close must work");
    }

    /// close 后 accept 返回 None（不永久挂起）：阻塞中的 accept 在端口被注销后必须醒。
    #[test]
    fn test_close_wakes_blocked_accept() {
        let p = tport(3);
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();
        let handle = std::thread::spawn(move || {
            let listener = PeerListener::bind_port(p, 4).unwrap();
            ready_tx.send(()).unwrap();
            // 阻塞在这里；close_port(p) 注销后必须返回 None
            listener.accept()
        });
        ready_rx.recv().unwrap();
        std::thread::sleep(Duration::from_millis(100)); // 确保对端已阻塞在 recv
        assert!(close_port(p), "close_port must find the registered listener");
        let got = handle.join().unwrap();
        assert!(got.is_none(), "blocked accept must return None after close, got {:?}", got.is_some());
    }

    /// 语义 3：有界容量满时投递阻塞（背压）；宿主取走一条后立即疏通。
    #[test]
    fn test_bounded_capacity_backpressure() {
        let p = tport(4);
        let listener = PeerListener::bind_port(p, 1).unwrap();
        // 填满容量 1
        let peer1 = fake_peer(1);
        let _tunnel1 = take_upstream(Some(&peer1), p, "test").unwrap().unwrap();
        // 第二条必须在满队列上阻塞
        let peer2 = fake_peer(2);
        let (started_tx, started_rx) = std::sync::mpsc::channel::<()>();
        let handle = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            take_upstream(Some(&peer2), p, "test")
        });
        started_rx.recv().unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(!handle.is_finished(), "push must block while the bounded queue is full");
        // 宿主取走一条 → 投递必须在一个轮询周期内疏通
        let _conn = listener.try_accept().expect("first conn must be queued");
        let got = handle.join().unwrap().expect("second push must succeed after drain");
        assert!(got.is_some(), "second push hands off a tunnel end");
    }

    /// 语义 4：已 hand-off 的连接在 close 后继续存活（所有权在宿主）
    #[test]
    fn test_handed_out_conn_survives_close() {
        let p = tport(5);
        let listener = PeerListener::bind_port(p, 4).unwrap();
        let peer = fake_peer(3);
        let mut tunnel_end =
            take_upstream(Some(&peer), p, "test").unwrap().unwrap();
        let mut conn = listener.accept().unwrap();
        (&tunnel_end).write_all(b"before-close").unwrap();
        assert_eq!(read_expect(&mut conn.stream, 12), b"before-close");
        listener.close();
        // close 后存量连接必须还能双向交付
        conn.stream.write_all(b"after").unwrap();
        assert_eq!(read_expect(&mut tunnel_end, 5), b"after");
        // 且不再有直交：口已摘表，回到既有回连语义（Ok(None) = legacy connect）
        let got = take_upstream(Some(&peer), p, "test").unwrap();
        assert!(got.is_none(), "closed port must revert to legacy upstream connect");
    }

    /// fail closed（G3）：listener 在口上但身份闸门给不出已验证身份 → 显式 AUTH_REQUIRED，
    /// 绝不把无身份连接交给宿主。
    #[test]
    fn test_no_identity_rejected() {
        let p = tport(6);
        let _listener = PeerListener::bind_port(p, 4).unwrap();
        let err = take_upstream(None, p, "test").unwrap_err();
        assert_eq!(err, "AUTH_REQUIRED");
    }

    /// 未注册端口的口必须走既有回连路径（Ok(None)），不影响非直交流量
    #[test]
    fn test_unregistered_port_falls_back() {
        let got = take_upstream(Some(&fake_peer(9)), tport(7), "test").unwrap();
        assert!(got.is_none(), "unregistered port must return Ok(None) for legacy connect");
    }
}
