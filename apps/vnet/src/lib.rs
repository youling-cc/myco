// vnet-core — UDP-first P2P 隧道，可嵌入 myco 进程内使用
//
// 设计目标：对上层完全黑盒。上层（RDP/DSH/HTTP）仍然连 127.0.0.1:<port>，
// 但隧道跑在宿主进程内，不启动第二个程序、不走 IPC。
//
// RFC 8445 (ICE) / RFC 8489 (STUN) / RFC 4787 (NAT behavior)
// Apache-2.0，自研实现，未参考任何 GPL/LGPL 项目代码。

pub mod stun;
pub mod probe;
pub mod punch;
pub mod relay;
pub mod transport;
pub mod tunnel;
pub mod session;
pub mod crypto;
pub mod connection;
pub mod forward;
pub mod identity;
pub mod peer_listener;
pub mod netstatus;
pub mod pathpipe;
pub mod relay_arq;
pub mod problem;
pub mod env;
pub mod perception;
pub mod cognition;
pub mod decision;
pub mod ffi;
pub mod fwcheck;

pub use fwcheck::{spawn_check as fw_spawn_check, current as fw_current, InboundStatus};
pub use connection::{Connection, start_server, start_server_with_secret,
                     status_file_path, status_file_path_for, list_status_files,
                     write_status, write_status_at, write_status_kv};
pub use peer_listener::{PeerConn, PeerListener};

/// 把 Windows 定时器精度提到 1ms。
///
/// Windows 默认定时器粒度 15.625ms，`thread::sleep(1ms)` 实测睡 ~15.6ms。
/// vnet 的接收线程/主循环是 poll+sleep 结构，探测回复到达时线程大概率在睡眠里，
/// 会把测得 RTT 抬高数毫秒到十几毫秒。嵌入方应在启动隧道前调用一次。
#[cfg(windows)]
pub fn raise_timer_resolution() {
    #[link(name = "winmm")]
    extern "system" {
        fn timeBeginPeriod(uperiod: u32) -> u32;
    }
    unsafe { timeBeginPeriod(1); }
}

#[cfg(not(windows))]
pub fn raise_timer_resolution() {}

/// 嵌入方的推荐初始化：调一次即可
pub fn init() {
    raise_timer_resolution();
}

