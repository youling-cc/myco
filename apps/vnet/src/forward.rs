//! multi-forward 客户端监听表（task.md §11 H.2 / H.2.1，2026-11-09 与 myco 冻结的 API）
//!
//! 一个 Connection（= 一对设备）承载多条本地监听：每条 = `local_port → target_port`。
//! 这就是把「N 个服务 = N 个 Connection/注册/P2P 口」收敛为「1 个设备隧道 + N 条转发」的部件。
//!
//! 四条硬语义（myco 2026-11-09 21:28 要求，全部有单测锁死）：
//!   1) 重复 local_port → Err（不静默复用/覆盖）
//!   2) target_port == 0 → Err（bind 之前校验，无副作用）
//!   3) remove_forward 不存在的口 → Err（不静默成功）
//!   4) 任何失败不静默换口、不留半启动状态：bind 成功前不登记，线程起不来即回滚
//!
//! 线程模型：每条转发一个 accept 线程；每条连接独立线程（回调阻塞不影响 accept）。
//! 回压：accept 即交给线程池式 spawn，不设队列——大量瞬时连接由上游 conn limiter 兜底。

use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// 一条转发：本地监听口 → 对端设备上的目标口。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ForwardSpec {
    /// 0 = 由系统分配（实际口回填在 `ForwardInfo::local_port`，宿主必须记录；
    /// 推荐宿主用确定性派生 + 持久化，见 H.1，不要长期依赖 0）。
    pub local_port: u16,
    /// 必须在对端 server 的白名单内（`--target-port` ∪ `VNET_TARGET_PORTS`），
    /// 否则该流被 `STREAM_END(MF_TARGET_DENIED)` 显式拒绝。
    pub target_port: u16,
}

/// 转发快照（宿主轮询用；构造后不持任何锁）。
#[derive(Clone, Debug, PartialEq)]
pub struct ForwardInfo {
    /// 宿主请求的口（0 = 让系统分配）
    pub requested_port: u16,
    /// **实际**绑定的口；status 与 remove_forward 都以它为 key。
    pub local_port: u16,
    pub target_port: u16,
    pub listening: bool,
    /// 累计 accept 次数
    pub accepted: u64,
    /// 当前活跃连接（回调返回后递减）
    pub active: u64,
    /// remove 次数（0/1；多次 remove 同口会先 Err）
    pub stop_calls: u64,
}

struct ForwardEntry {
    requested: u16,
    actual: u16,
    target: u16,
    listening: AtomicBool,
    accepted: AtomicU64,
    active: AtomicU64,
    stop_calls: AtomicU64,
    stop: AtomicBool,
    handle: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl ForwardEntry {
    fn info(&self) -> ForwardInfo {
        ForwardInfo {
            requested_port: self.requested,
            local_port: self.actual,
            target_port: self.target,
            listening: self.listening.load(Ordering::Relaxed),
            accepted: self.accepted.load(Ordering::Relaxed),
            active: self.active.load(Ordering::Relaxed),
            stop_calls: self.stop_calls.load(Ordering::Relaxed),
        }
    }
}

/// 收到连接的回调：`(stream, target_port)`。**stream 所有权完全转移**给回调；
/// 表内为每条连接独立 spawn 线程，回调可阻塞（与 run_accept 的 per-conn 线程同构）。
pub type OnAccept = Arc<dyn Fn(TcpStream, u16) + Send + Sync + 'static>;

#[derive(Default)]
pub struct ForwardTable {
    entries: Mutex<Vec<Arc<ForwardEntry>>>,
}

impl ForwardTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// 添加一条转发并立即开始 accept。
    /// 顺序：校验 → 查重 → bind → 起线程 → 登记。任何一步失败都无残留（语义 4）。
    pub fn add(&self, spec: ForwardSpec, on_accept: OnAccept) -> anyhow::Result<ForwardInfo> {
        if spec.target_port == 0 {
            anyhow::bail!("MF_TARGET_INVALID: target_port must not be 0");
        }
        let mut guard = self.entries.lock().unwrap();
        if spec.local_port != 0 && guard.iter().any(|e| e.actual == spec.local_port) {
            anyhow::bail!("MF_PORT_IN_USE: local port {} already forwarded", spec.local_port);
        }
        let listener = TcpListener::bind(("127.0.0.1", spec.local_port)).map_err(|e| {
            // 严格绑定：绑不上就 Err，绝不静默换口（15119 事故的教训）
            anyhow::anyhow!("MF_BIND_FAILED: bind 127.0.0.1:{}: {:#}", spec.local_port, e)
        })?;
        let actual = listener.local_addr()?.port();
        if guard.iter().any(|e| e.actual == actual) {
            // local_port=0 时系统分配撞上已有实际口（概率极低，仍显式失败）
            anyhow::bail!("MF_PORT_IN_USE: assigned local port {} already forwarded", actual);
        }
        listener.set_nonblocking(true)?;

        let entry = Arc::new(ForwardEntry {
            requested: spec.local_port,
            actual,
            target: spec.target_port,
            listening: AtomicBool::new(true),
            accepted: AtomicU64::new(0),
            active: AtomicU64::new(0),
            stop_calls: AtomicU64::new(0),
            stop: AtomicBool::new(false),
            handle: Mutex::new(None),
        });
        let e2 = entry.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("mf-accept-{}", actual))
            .spawn(move || accept_loop(e2, listener, on_accept));
        match spawned {
            Ok(h) => {
                *entry.handle.lock().unwrap() = Some(h);
            }
            Err(e) => {
                // 线程没起来 = 整条转发不存在（listener 已随闭包 drop，端口已释放）
                entry.listening.store(false, Ordering::Relaxed);
                anyhow::bail!("MF_SPAWN_FAILED: accept thread for :{}: {:#}", actual, e);
            }
        }
        let info = entry.info();
        guard.push(entry);
        Ok(info)
    }

    /// 全部转发的快照（锁内 clone 数据，立刻放锁）。
    pub fn list(&self) -> Vec<ForwardInfo> {
        self.entries.lock().unwrap().iter().map(|e| e.info()).collect()
    }

    /// 停止并移除一条转发（key = **实际** local_port）。
    /// 返回 Ok 时 accept 线程已 join、listener 已 drop、端口已释放；
    /// 已交给回调的存量连接不受影响（所有权在回调侧）。
    pub fn remove(&self, local_port: u16) -> anyhow::Result<()> {
        let mut guard = self.entries.lock().unwrap();
        let idx = guard.iter().position(|e| e.actual == local_port).ok_or_else(|| {
            anyhow::anyhow!(
                "MF_NO_SUCH_FORWARD: {} (active forwards: {:?})",
                local_port,
                guard.iter().map(|e| e.actual).collect::<Vec<_>>()
            )
        })?;
        let entry = guard.remove(idx);
        drop(guard); // join 前放锁：accept 线程不依赖表锁
        entry.stop_calls.fetch_add(1, Ordering::Relaxed);
        entry.stop.store(true, Ordering::Relaxed);
        let h = entry.handle.lock().unwrap().take();
        if let Some(h) = h {
            let _ = h.join(); // accept 循环 ≤20ms 一轮，listener 在线程内 drop
        }
        Ok(())
    }

    /// 停止全部（Connection::stop 用）。同样 join 到位，端口全部释放。
    pub fn shutdown(&self) {
        let entries: Vec<Arc<ForwardEntry>> =
            { self.entries.lock().unwrap().drain(..).collect() };
        for e in entries {
            e.stop_calls.fetch_add(1, Ordering::Relaxed);
            e.stop.store(true, Ordering::Relaxed);
            let h = e.handle.lock().unwrap().take();
            if let Some(h) = h {
                let _ = h.join();
            }
        }
    }
}

fn accept_loop(entry: Arc<ForwardEntry>, listener: TcpListener, on_accept: OnAccept) {
    while !entry.stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _peer)) => {
                // 同 connection.rs run_accept 的修复：listener non-blocking →
                // accepted socket 继承非阻塞 → down 线程 write_all WouldBlock
                // 被误判致命 → 连接截断。accept 后恢复阻塞模式。
                let _ = stream.set_nonblocking(false);
                // TCP 缓冲区调优（与 connection.rs 同款，socket2 跨平台）
                let tcp_buf = std::env::var("VNET_TCP_BUF").ok()
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(256 * 1024);
                {
                    let sr = socket2::SockRef::from(&stream);
                    let _ = sr.set_send_buffer_size(tcp_buf);
                    let _ = sr.set_recv_buffer_size(tcp_buf);
                }
                entry.accepted.fetch_add(1, Ordering::Relaxed);
                entry.active.fetch_add(1, Ordering::Relaxed);
                let cb = on_accept.clone();
                let tgt = entry.target;
                let e2 = entry.clone();
                let spawned = std::thread::Builder::new()
                    .name(format!("mf-conn-{}", tgt))
                    .spawn(move || {
                        cb(stream, tgt);
                        e2.active.fetch_sub(1, Ordering::Relaxed);
                    });
                if spawned.is_err() {
                    // 线程起不来：不能让 active 永远挂账
                    entry.active.fetch_sub(1, Ordering::Relaxed);
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(e) => {
                eprintln!("  [FWD] accept :{}: {}", entry.actual, e);
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    }
    entry.listening.store(false, Ordering::Relaxed);
    // listener 在此 drop → 端口立即释放，可原地重新 add
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    /// 找一个空闲口（bind(0) 后读端口再释放；本地测试足够）
    fn free_port() -> u16 {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let p = l.local_addr().unwrap().port();
        drop(l);
        p
    }

    fn tag_cb() -> OnAccept {
        // 收到连接就写 "t<target>" 然后关——路由证据 + 计数验证两用
        Arc::new(|mut s: TcpStream, t: u16| {
            let _ = s.write_all(format!("t{}", t).as_bytes());
        })
    }

    /// 语义 2：target_port=0 必须 Err，且无副作用
    #[test]
    fn test_target_zero_rejected() {
        let t = ForwardTable::new();
        let err = t
            .add(ForwardSpec { local_port: 0, target_port: 0 }, tag_cb())
            .unwrap_err();
        assert!(format!("{:#}", err).contains("MF_TARGET_INVALID"), "got: {:#}", err);
        assert!(t.list().is_empty(), "失败后不得有残留");
    }

    /// 语义 1：重复 local_port 必须 Err
    #[test]
    fn test_duplicate_port_rejected() {
        let t = ForwardTable::new();
        let p = free_port();
        let info = t.add(ForwardSpec { local_port: p, target_port: 25997 }, tag_cb()).unwrap();
        assert_eq!(info.local_port, p);
        let err = t
            .add(ForwardSpec { local_port: p, target_port: 25998 }, tag_cb())
            .unwrap_err();
        assert!(format!("{:#}", err).contains("MF_PORT_IN_USE"), "got: {:#}", err);
        assert_eq!(t.list().len(), 1, "重复添加不得新增条目");
    }

    /// 语义 4：bind 失败必须 Err、不静默换口、无半启动残留
    #[test]
    fn test_bind_failure_no_residue_no_silent_change() {
        let t = ForwardTable::new();
        let occupied = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let p = occupied.local_addr().unwrap().port();
        let err = t
            .add(ForwardSpec { local_port: p, target_port: 25997 }, tag_cb())
            .unwrap_err();
        let msg = format!("{:#}", err);
        assert!(msg.contains("MF_BIND_FAILED"), "got: {}", msg);
        assert!(t.list().is_empty(), "bind 失败后不得有残留");
    }

    /// 语义 3：remove 不存在的口必须 Err（带现存口列表，便于排障）
    #[test]
    fn test_remove_unknown_rejected() {
        let t = ForwardTable::new();
        let p = free_port();
        t.add(ForwardSpec { local_port: p, target_port: 25997 }, tag_cb()).unwrap();
        let err = t.remove(p + 1).unwrap_err();
        let msg = format!("{:#}", err);
        assert!(msg.contains("MF_NO_SUCH_FORWARD"), "got: {}", msg);
        assert!(msg.contains(&p.to_string()), "错误信息应列出在用口: {}", msg);
    }

    /// local_port=0：系统分配，实际口回填且 != 0
    #[test]
    fn test_auto_port_reports_actual() {
        let t = ForwardTable::new();
        let info = t.add(ForwardSpec { local_port: 0, target_port: 25997 }, tag_cb()).unwrap();
        assert_eq!(info.requested_port, 0);
        assert_ne!(info.local_port, 0);
        assert!(info.listening);
        t.remove(info.local_port).unwrap();
    }

    /// 端到端：连接进来 → 回调拿到 (stream, target) → 计数正确归位
    #[test]
    fn test_accept_dispatch_and_counters() {
        let t = ForwardTable::new();
        let info = t.add(ForwardSpec { local_port: 0, target_port: 25998 }, tag_cb()).unwrap();
        let mut c = TcpStream::connect(("127.0.0.1", info.local_port)).unwrap();
        let mut buf = [0u8; 16];
        let n = c.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"t25998", "回调必须收到正确的 target_port");
        // accepted=1；连接关闭后 active 应回 0
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let l = t.list();
            assert_eq!(l.len(), 1);
            if l[0].accepted == 1 && l[0].active == 0 {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "counters did not settle: {:?}", l);
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        t.remove(info.local_port).unwrap();
    }

    /// remove 后：表空、端口立即可重绑（listener 已 drop）
    #[test]
    fn test_remove_releases_port_for_rebind() {
        let t = ForwardTable::new();
        let p = free_port();
        t.add(ForwardSpec { local_port: p, target_port: 25997 }, tag_cb()).unwrap();
        t.remove(p).unwrap();
        assert!(t.list().is_empty());
        // 端口必须已释放：原地重绑应成功（remove 已 join accept 线程）
        let relabel = TcpListener::bind(("127.0.0.1", p)).unwrap();
        drop(relabel);
        // 重挂在同一口也应成功
        let info = t.add(ForwardSpec { local_port: p, target_port: 25999 }, tag_cb()).unwrap();
        assert_eq!(info.local_port, p);
    }

    /// remove 时已建立的连接继续存活（所有权已转移），只是不再接受新连接
    #[test]
    fn test_remove_keeps_live_connections() {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let rx = Arc::new(std::sync::Mutex::new(rx));
        let tx = Arc::new(tx);
        let cb: OnAccept = Arc::new(move |mut s: TcpStream, t: u16| {
            // 阻塞到测试放行，模拟长连接
            let _ = rx.lock().unwrap().recv();
            let _ = s.write_all(format!("t{}", t).as_bytes());
        });
        let t = ForwardTable::new();
        let p = free_port();
        t.add(ForwardSpec { local_port: p, target_port: 25997 }, cb).unwrap();
        let mut c1 = TcpStream::connect(("127.0.0.1", p)).unwrap();
        // 等 accepted=1（确保连接已进回调）
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while t.list()[0].accepted == 0 {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        t.remove(p).unwrap();
        // 新连接必须被拒（端口已关）
        assert!(TcpStream::connect(("127.0.0.1", p)).is_err(), "remove 后不得再接受新连接");
        // 存量连接必须还能完成数据交付
        tx.send(()).unwrap();
        let mut buf = [0u8; 16];
        let n = c1.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"t25997");
    }

    /// shutdown（Connection::stop 路径）：全部停止、端口释放
    #[test]
    fn test_shutdown_stops_all() {
        let t = ForwardTable::new();
        let p1 = free_port();
        let p2 = free_port();
        t.add(ForwardSpec { local_port: p1, target_port: 25997 }, tag_cb()).unwrap();
        t.add(ForwardSpec { local_port: p2, target_port: 25998 }, tag_cb()).unwrap();
        t.shutdown();
        assert!(t.list().is_empty());
        assert!(TcpStream::connect(("127.0.0.1", p1)).is_err());
        assert!(TcpStream::connect(("127.0.0.1", p2)).is_err());
    }
}
