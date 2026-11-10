// tunnel_resume_frames.rs — resume 能力帧（会话续传）编解码。
//
// 与 Java `TunnelResumeFrames` 同一线格式：独立魔数 `METR`，帧版本 1。
// 目的：换腿时保留逻辑会话，RESUME 后从对端已确认偏移继续收发，而不是重开上层连接。
//
// 帧布局（全部大端）：
//   DATA    = [METR][ver=1][type=3][seq u64][offset u64][prefix 12][AES-256-GCM]
//   CONTROL = [METR][ver=1][type][seq u64][prefix 12][AES-256-GCM]
//
// 两条硬约束：
// 1. seq 跨腿单调不重置：nonce = prefix 末 8 字节 XOR seq，重置会复用 nonce（GCM 灾难）。
// 2. RESUME.recvOffset 必须落在 [ackedOffset, sendNext]，否则拒绝（防乱序/截断被误当已收到）。

use super::{Aes256Gcm, FrameError, Nonce, SessionKeys, TunnelRole, FRAME_MAX_PAYLOAD};
use aes_gcm::aead::{Aead as _, KeyInit as _};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

pub const MAGIC: [u8; 4] = [0x4d, 0x45, 0x54, 0x52];
pub const VERSION: u8 = 1;
pub const T_DATA: u8 = 3;
pub const T_SESSION_OPEN: u8 = 4;
pub const T_SESSION_ACK: u8 = 5;
pub const T_ACK: u8 = 6;
pub const T_RESUME: u8 = 7;
pub const T_RESUME_ACK: u8 = 8;
pub const T_GOAWAY: u8 = 9;
pub const DATA_HEADER: usize = 34;
pub const CTL_HEADER: usize = 26;
pub const TAG_LEN: usize = 16;
pub const SESSION_ID_LEN: usize = 16;

pub const GOAWAY_USER_CLOSED: u8 = 0;
pub const GOAWAY_RECOVERY_TIMEOUT: u8 = 1;
pub const GOAWAY_PROTOCOL_ERROR: u8 = 2;
pub const GOAWAY_PEER_GONE: u8 = 3;

#[derive(Debug, PartialEq)]
pub enum ResumeFrame {
    Data { seq: u64, offset: u64, plaintext: Vec<u8> },
    Control { type_: u8, seq: u64, payload: Vec<u8> },
}

pub struct ResumeIo {
    tx: Aes256Gcm,
    rx: Aes256Gcm,
    prefix: [u8; 12],
    send_seq: Arc<AtomicU64>,
    recv_max_seq: Option<u64>,
}

impl ResumeIo {
    pub fn new(keys: SessionKeys, role: TunnelRole) -> Self {
        let tx = Aes256Gcm::new_from_slice(keys.send_key(role)).expect("32B 密钥");
        let rx = Aes256Gcm::new_from_slice(keys.recv_key(role)).expect("32B 密钥");
        ResumeIo { tx, rx, prefix: keys.prefix, send_seq: Arc::new(AtomicU64::new(0)), recv_max_seq: None }
    }

    pub fn send_seq(&self) -> u64 { self.send_seq.load(Ordering::SeqCst) }
    pub fn recv_max_seq(&self) -> Option<u64> { self.recv_max_seq }
    pub fn shared_send_seq(&self) -> Arc<AtomicU64> { self.send_seq.clone() }
    pub fn set_shared_send_seq(&mut self, seq: Arc<AtomicU64>) { self.send_seq = seq; }

    pub fn seal_data(&mut self, offset: u64, plaintext: &[u8]) -> Vec<u8> {
        self.seal(T_DATA, Some(offset), plaintext)
    }

    pub fn seal_control(&mut self, type_: u8, payload: &[u8]) -> Result<Vec<u8>, FrameError> {
        if !is_control_type(type_) {
            return Err(FrameError::PlaintextOrUnknownFrame);
        }
        Ok(self.seal(type_, None, payload))
    }

    fn seal(&mut self, type_: u8, offset: Option<u64>, plaintext: &[u8]) -> Vec<u8> {
        let seq = self.send_seq.fetch_add(1, Ordering::SeqCst);
        let nonce = nonce_for(&self.prefix, seq);
        let ct = self.tx.encrypt(Nonce::from_slice(&nonce), plaintext).expect("GCM 加密不会失败");
        let has_offset = offset.is_some();
        let hdr = if has_offset { DATA_HEADER } else { CTL_HEADER };
        let mut f = Vec::with_capacity(hdr + ct.len());
        f.extend_from_slice(&MAGIC);
        f.push(VERSION);
        f.push(type_);
        f.extend_from_slice(&seq.to_be_bytes());
        if let Some(off) = offset {
            f.extend_from_slice(&off.to_be_bytes());
        }
        f.extend_from_slice(&self.prefix);
        f.extend_from_slice(&ct);
        f
    }

    pub fn open(&mut self, frame: &[u8]) -> Result<ResumeFrame, FrameError> {
        if frame.len() < CTL_HEADER + TAG_LEN || frame[0..4] != MAGIC {
            return Err(FrameError::PlaintextOrUnknownFrame);
        }
        if frame[4] != VERSION {
            return Err(FrameError::WrongVersion);
        }
        let type_ = frame[5];
        let is_data = type_ == T_DATA;
        if !is_data && !is_control_type(type_) {
            return Err(FrameError::PlaintextOrUnknownFrame);
        }
        let hdr = if is_data { DATA_HEADER } else { CTL_HEADER };
        if frame.len() < hdr + TAG_LEN {
            return Err(FrameError::AuthFail);
        }
        if frame.len() - hdr > FRAME_MAX_PAYLOAD {
            return Err(FrameError::AuthFail);
        }
        let seq = get_u64(frame, 6);
        let mut p = 14;
        let offset = if is_data {
            let v = get_u64(frame, 14);
            p = 22;
            v
        } else { 0 };
        if frame[p..p + 12] != self.prefix {
            return Err(FrameError::PlaintextOrUnknownFrame);
        }
        if self.recv_max_seq.is_some_and(|m| seq <= m) {
            return Err(FrameError::ReplayOrOutOfOrder);
        }
        let nonce = nonce_for(&self.prefix, seq);
        let pt = self.rx.decrypt(Nonce::from_slice(&nonce), &frame[hdr..])
            .map_err(|_| FrameError::AuthFail)?;
        self.recv_max_seq = Some(seq);
        Ok(if is_data {
            ResumeFrame::Data { seq, offset, plaintext: pt }
        } else {
            ResumeFrame::Control { type_, seq, payload: pt }
        })
    }
}

pub fn is_control_type(t: u8) -> bool {
    matches!(t, T_SESSION_OPEN | T_SESSION_ACK | T_ACK | T_RESUME | T_RESUME_ACK | T_GOAWAY)
}

fn nonce_for(prefix: &[u8; 12], seq: u64) -> [u8; 12] {
    let mut n = *prefix;
    let tail = u64::from_be_bytes(n[4..12].try_into().unwrap());
    n[4..12].copy_from_slice(&(tail ^ seq).to_be_bytes());
    n
}

pub fn put_u64(b: &mut [u8], off: usize, v: u64) {
    b[off..off + 8].copy_from_slice(&v.to_be_bytes());
}

pub fn get_u64(b: &[u8], off: usize) -> u64 {
    u64::from_be_bytes(b[off..off + 8].try_into().unwrap())
}

fn require_sid(sid: &[u8]) -> Result<(), FrameError> {
    if sid.len() != SESSION_ID_LEN {
        return Err(FrameError::PlaintextOrUnknownFrame);
    }
    Ok(())
}

fn require_len(p: &[u8], n: usize) -> Result<(), FrameError> {
    if p.len() != n {
        return Err(FrameError::PlaintextOrUnknownFrame);
    }
    Ok(())
}

pub fn encode_session_open(sid: &[u8], initial_seq: u64) -> Result<Vec<u8>, FrameError> {
    require_sid(sid)?;
    let mut b = vec![0u8; 24];
    b[..16].copy_from_slice(sid);
    put_u64(&mut b, 16, initial_seq);
    Ok(b)
}

pub fn decode_session_open(p: &[u8]) -> Result<([u8; 16], u64), FrameError> {
    require_len(p, 24)?;
    let mut sid = [0u8; 16];
    sid.copy_from_slice(&p[..16]);
    Ok((sid, get_u64(p, 16)))
}

pub fn encode_session_ack(sid: &[u8], recv_offset: u64) -> Result<Vec<u8>, FrameError> {
    require_sid(sid)?;
    let mut b = vec![0u8; 24];
    b[..16].copy_from_slice(sid);
    put_u64(&mut b, 16, recv_offset);
    Ok(b)
}

pub fn decode_session_ack(p: &[u8]) -> Result<([u8; 16], u64), FrameError> {
    require_len(p, 24)?;
    let mut sid = [0u8; 16];
    sid.copy_from_slice(&p[..16]);
    Ok((sid, get_u64(p, 16)))
}

pub fn encode_ack(recv_offset: u64) -> Vec<u8> {
    let mut b = vec![0u8; 8];
    put_u64(&mut b, 0, recv_offset);
    b
}

pub fn decode_ack(p: &[u8]) -> Result<u64, FrameError> {
    require_len(p, 8)?;
    Ok(get_u64(p, 0))
}

pub fn encode_resume(sid: &[u8], recv_offset: u64, send_offset: u64) -> Result<Vec<u8>, FrameError> {
    require_sid(sid)?;
    let mut b = vec![0u8; 32];
    b[..16].copy_from_slice(sid);
    put_u64(&mut b, 16, recv_offset);
    put_u64(&mut b, 24, send_offset);
    Ok(b)
}

pub fn decode_resume(p: &[u8]) -> Result<([u8; 16], u64, u64), FrameError> {
    require_len(p, 32)?;
    let mut sid = [0u8; 16];
    sid.copy_from_slice(&p[..16]);
    Ok((sid, get_u64(p, 16), get_u64(p, 24)))
}

pub fn encode_goaway(reason: u8, recv_offset: u64, send_offset: u64) -> Vec<u8> {
    let mut b = vec![0u8; 17];
    b[0] = reason;
    put_u64(&mut b, 1, recv_offset);
    put_u64(&mut b, 9, send_offset);
    b
}

pub fn decode_goaway(p: &[u8]) -> Result<(u8, u64, u64), FrameError> {
    require_len(p, 17)?;
    Ok((p[0], get_u64(p, 1), get_u64(p, 9)))
}

/// RESUME 的 recvOffset 必须落在 [ackedOffset, sendNext]，否则拒绝。
pub fn validate_resume_offset(recv_offset: u64, acked_offset: u64, send_next: u64) -> Result<(), FrameError> {
    if send_next < acked_offset || recv_offset < acked_offset || recv_offset > send_next {
        return Err(FrameError::ResumeOffsetInvalid);
    }
    Ok(())
}

/// 服务端收到的首帧动作（SESSION_OPEN / RESUME）。
#[derive(Debug, PartialEq, Eq)]
pub enum ResumeServerAction {
    SessionOpen { sid: [u8; 16], initial_seq: u64 },
    Resume { sid: [u8; 16], replay_from: u64 },
}

/// 服务端处理首帧并生成回应帧。
///
/// - SESSION_OPEN：建立逻辑会话，回 SESSION_ACK(recvOffset=0)；
/// - RESUME：校验对端声明的 recvOffset 在 [ackedOffset, sendNext] 内，回 RESUME_ACK；
/// - 其它类型一律拒绝，避免把普通 DATA 当成会话首帧。
pub fn server_accept_first_frame(
    io: &mut ResumeIo,
    frame: &[u8],
    acked_offset: u64,
    send_next: u64,
) -> Result<(ResumeServerAction, Vec<u8>), FrameError> {
    let opened = io.open(frame)?;
    let ResumeFrame::Control { type_, payload, .. } = opened else {
        return Err(FrameError::PlaintextOrUnknownFrame);
    };
    match type_ {
        T_SESSION_OPEN => {
            let (sid, initial_seq) = decode_session_open(&payload)?;
            let ack = io.seal_control(T_SESSION_ACK, &encode_session_ack(&sid, 0)?)?;
            Ok((ResumeServerAction::SessionOpen { sid, initial_seq }, ack))
        }
        T_RESUME => {
            let (sid, recv_offset, _send_offset) = decode_resume(&payload)?;
            validate_resume_offset(recv_offset, acked_offset, send_next)?;
            let ack = io.seal_control(T_RESUME_ACK, &encode_ack(acked_offset))?;
            Ok((ResumeServerAction::Resume { sid, replay_from: recv_offset }, ack))
        }
        _ => Err(FrameError::PlaintextOrUnknownFrame),
    }
}

/// 逻辑会话/传输腿状态机（与 Java TunnelSessionStateMachine 同语义）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState { Connecting, Open, Recovering, Closed }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadAction { Normal, Throttled, Pause }

pub struct ResumeSession {
    pub session_id: [u8; 16],
    pub state: SessionState,
    pub leg: u32,
    pub send_next: u64,
    pub acked_offset: u64,
    pub recv_offset: u64,
    pending: std::collections::VecDeque<Vec<u8>>,
    pending_bytes: usize,
    recovery_deadline_ms: i64,
}

impl ResumeSession {
    pub const RECOVERY_WINDOW_MS: i64 = 15_000;
    pub const THROTTLE_AFTER: usize = 128 * 1024;
    pub const PAUSE_AFTER: usize = 256 * 1024;

    pub fn new(session_id: [u8; 16]) -> Self {
        ResumeSession {
            session_id,
            state: SessionState::Connecting,
            leg: 0,
            send_next: 0,
            acked_offset: 0,
            recv_offset: 0,
            pending: std::collections::VecDeque::new(),
            pending_bytes: 0,
            recovery_deadline_ms: -1,
        }
    }

    pub fn upper_connection_open(&self) -> bool { self.state != SessionState::Closed }
    pub fn pending_bytes(&self) -> usize { self.pending_bytes }
    pub fn recovery_deadline_ms(&self) -> i64 { self.recovery_deadline_ms }

    /// 当前读背压档位（供泵与单测共用；>128KB 降速，>256KB 停读）。
    pub fn read_action(&self) -> ReadAction {
        if self.pending_bytes > Self::PAUSE_AFTER { ReadAction::Pause }
        else if self.pending_bytes > Self::THROTTLE_AFTER { ReadAction::Throttled }
        else { ReadAction::Normal }
    }

    pub fn on_leg_open(&mut self) {
        if self.state == SessionState::Closed { return; }
        self.leg += 1;
        self.state = SessionState::Open;
        self.recovery_deadline_ms = -1;
    }

    pub fn on_leg_dead(&mut self, now_ms: i64) {
        if self.state == SessionState::Closed { return; }
        self.state = SessionState::Recovering;
        self.recovery_deadline_ms = now_ms + Self::RECOVERY_WINDOW_MS;
    }

    pub fn on_local_data(&mut self, data: &[u8]) -> ReadAction {
        if self.state == SessionState::Closed || data.is_empty() { return ReadAction::Pause; }
        self.pending.push_back(data.to_vec());
        self.pending_bytes += data.len();
        self.send_next += data.len() as u64;
        if self.pending_bytes > Self::PAUSE_AFTER { ReadAction::Pause }
        else if self.pending_bytes > Self::THROTTLE_AFTER { ReadAction::Throttled }
        else { ReadAction::Normal }
    }

    pub fn on_ack(&mut self, offset: u64) {
        if offset <= self.acked_offset { return; }
        self.acked_offset = offset.min(self.send_next);
        let base = self.send_next - self.pending_bytes as u64;
        let mut cut = self.acked_offset.saturating_sub(base) as usize;
        while cut > 0 {
            let Some(front) = self.pending.front_mut() else { break; };
            if cut >= front.len() {
                cut -= front.len();
                self.pending_bytes -= front.len();
                self.pending.pop_front();
            } else {
                let rest = front.split_off(cut);
                self.pending_bytes -= cut;
                *front = rest;
                break;
            }
        }
    }

    /// 新腿 RESUME：校验 offset 后返回从该偏移起的重放数据。
    ///
    /// 2026-11-02 真案：旧实现遇到 state==Open 直接返回空重放。可"新腿 RESUME 到达
    /// 提供端"意味着客户端已经判旧腿死亡——提供端可能还没收完旧腿的收尾，此时它看到
    /// 的仍是 Open。若因此跳过重放，旧腿上**已发未确认**的字节就永久丢失（B 验收
    /// 断腿场景的头号杀手）。只要 offset 合法就照常重放；Connecting/Closed 才拒绝。
    pub fn on_resume(&mut self, peer_recv_offset: u64) -> Result<Vec<u8>, FrameError> {
        if self.state == SessionState::Connecting || self.state == SessionState::Closed {
            return Err(FrameError::ResumeOffsetInvalid);
        }
        validate_resume_offset(peer_recv_offset, self.acked_offset, self.send_next)?;
        let base = self.send_next - self.pending_bytes as u64;
        let mut skip = peer_recv_offset.saturating_sub(base) as usize;
        let mut out = Vec::new();
        for chunk in &self.pending {
            if skip >= chunk.len() {
                skip -= chunk.len();
                continue;
            }
            out.extend_from_slice(&chunk[skip..]);
            skip = 0;
        }
        self.state = SessionState::Open;
        self.leg += 1;
        self.recovery_deadline_ms = -1;
        Ok(out)
    }

    pub fn tick(&mut self, now_ms: i64) {
        if self.state == SessionState::Recovering && now_ms >= self.recovery_deadline_ms {
            self.state = SessionState::Closed;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys() -> SessionKeys {
        SessionKeys {
            c2s: [1u8; 32],
            s2c: [2u8; 32],
            prefix: [3u8; 12],
            confirm_c2s: [4u8; 32],
            confirm_s2c: [5u8; 32],
        }
    }

    fn pair() -> (ResumeIo, ResumeIo) {
        (ResumeIo::new(keys(), TunnelRole::Originator), ResumeIo::new(keys(), TunnelRole::Responder))
    }

    #[test]
    fn data_roundtrip_and_offset() {
        let (mut a, mut b) = pair();
        let pt = b"hello-resume";
        let f = a.seal_data(1000, pt);
        match b.open(&f).expect("open") {
            ResumeFrame::Data { seq, offset, plaintext } => {
                assert_eq!(seq, 0);
                assert_eq!(offset, 1000);
                assert_eq!(plaintext, pt);
            }
            _ => panic!("not data"),
        }
    }

    #[test]
    fn shared_send_seq_survives_new_leg() {
        let (mut a, _) = pair();
        let _ = a.seal_data(0, b"a");
        let seq = a.shared_send_seq();
        let mut next_leg = ResumeIo::new(keys(), TunnelRole::Originator);
        next_leg.set_shared_send_seq(seq);
        let f = next_leg.seal_data(1, b"b");
        assert_eq!(get_u64(&f, 6), 1, "换腿后 seq 必须接着旧腿，不得从 0 重来");
    }

    #[test]
    fn control_roundtrip_all_types() {
        let (mut a, mut b) = pair();
        let sid = [0x11u8; 16];
        let so = a.seal_control(T_SESSION_OPEN, &encode_session_open(&sid, 42).unwrap()).unwrap();
        match b.open(&so).expect("session open") {
            ResumeFrame::Control { type_, payload, .. } => {
                assert_eq!(type_, T_SESSION_OPEN);
                assert_eq!(decode_session_open(&payload).unwrap(), (sid, 42));
            }
            _ => panic!(),
        }
        let sa = a.seal_control(T_SESSION_ACK, &encode_session_ack(&sid, 1024).unwrap()).unwrap();
        match b.open(&sa).expect("session ack") {
            ResumeFrame::Control { type_, payload, .. } => {
                assert_eq!(type_, T_SESSION_ACK);
                assert_eq!(decode_session_ack(&payload).unwrap(), (sid, 1024));
            }
            _ => panic!(),
        }
        let ack = a.seal_control(T_ACK, &encode_ack(2048)).unwrap();
        match b.open(&ack).expect("ack") {
            ResumeFrame::Control { type_, payload, .. } => {
                assert_eq!(type_, T_ACK);
                assert_eq!(decode_ack(&payload).unwrap(), 2048);
            }
            _ => panic!(),
        }
        let rs = a.seal_control(T_RESUME, &encode_resume(&sid, 4096, 3000).unwrap()).unwrap();
        match b.open(&rs).expect("resume") {
            ResumeFrame::Control { type_, payload, .. } => {
                assert_eq!(type_, T_RESUME);
                assert_eq!(decode_resume(&payload).unwrap(), (sid, 4096, 3000));
            }
            _ => panic!(),
        }
        let ra = a.seal_control(T_RESUME_ACK, &encode_ack(5120)).unwrap();
        match b.open(&ra).expect("resume ack") {
            ResumeFrame::Control { type_, payload, .. } => {
                assert_eq!(type_, T_RESUME_ACK);
                assert_eq!(decode_ack(&payload).unwrap(), 5120);
            }
            _ => panic!(),
        }
        let gw = a.seal_control(T_GOAWAY, &encode_goaway(GOAWAY_RECOVERY_TIMEOUT, 6144, 7000)).unwrap();
        match b.open(&gw).expect("goaway") {
            ResumeFrame::Control { type_, payload, .. } => {
                assert_eq!(type_, T_GOAWAY);
                assert_eq!(decode_goaway(&payload).unwrap(), (GOAWAY_RECOVERY_TIMEOUT, 6144, 7000));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn reject_wrong_version_unknown_type_short_prefix_and_replay() {
        let (mut a, mut b) = pair();
        let good = a.seal_data(0, b"x");
        let mut bad_ver = good.clone();
        bad_ver[4] = 2;
        assert_eq!(b.open(&bad_ver), Err(FrameError::WrongVersion));
        let mut bad_type = good.clone();
        bad_type[5] = 99;
        assert_eq!(b.open(&bad_type), Err(FrameError::PlaintextOrUnknownFrame));
        let short = &good[..45];
        assert_eq!(b.open(short), Err(FrameError::AuthFail));
        let mut bad_prefix = good.clone();
        bad_prefix[26] ^= 0x7f;
        assert_eq!(b.open(&bad_prefix), Err(FrameError::PlaintextOrUnknownFrame));
        b.open(&good).expect("first");
        assert_eq!(b.open(&good), Err(FrameError::ReplayOrOutOfOrder));
    }

    #[test]
    fn resume_offset_boundaries() {
        assert!(validate_resume_offset(1000, 500, 2000).is_ok());
        assert!(validate_resume_offset(500, 500, 2000).is_ok());
        assert!(validate_resume_offset(2000, 500, 2000).is_ok());
        assert_eq!(validate_resume_offset(499, 500, 2000), Err(FrameError::ResumeOffsetInvalid));
        assert_eq!(validate_resume_offset(2001, 500, 2000), Err(FrameError::ResumeOffsetInvalid));
    }

    #[test]
    fn server_session_open_and_resume_handshake() {
        let (mut client, mut server) = pair();
        let sid = [0x22u8; 16];
        let so = client.seal_control(T_SESSION_OPEN, &encode_session_open(&sid, 0).unwrap()).unwrap();
        let (action, ack) = server_accept_first_frame(&mut server, &so, 0, 0).expect("session open");
        assert_eq!(action, ResumeServerAction::SessionOpen { sid, initial_seq: 0 });
        match client.open(&ack).expect("session ack") {
            ResumeFrame::Control { type_, payload, .. } => {
                assert_eq!(type_, T_SESSION_ACK);
                assert_eq!(decode_session_ack(&payload).unwrap(), (sid, 0));
            }
            _ => panic!(),
        }
        let rs = client.seal_control(T_RESUME, &encode_resume(&sid, 3, 10).unwrap()).unwrap();
        let (action, ack) = server_accept_first_frame(&mut server, &rs, 3, 10).expect("resume");
        assert_eq!(action, ResumeServerAction::Resume { sid, replay_from: 3 });
        match client.open(&ack).expect("resume ack") {
            ResumeFrame::Control { type_, payload, .. } => {
                assert_eq!(type_, T_RESUME_ACK);
                assert_eq!(decode_ack(&payload).unwrap(), 3);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn server_rejects_bad_resume_offset() {
        let (mut client, mut server) = pair();
        let sid = [0x33u8; 16];
        let rs = client.seal_control(T_RESUME, &encode_resume(&sid, 99, 10).unwrap()).unwrap();
        assert_eq!(
            server_accept_first_frame(&mut server, &rs, 3, 10),
            Err(FrameError::ResumeOffsetInvalid)
        );
    }

    #[test]
    fn resume_session_replays_unacked_and_keeps_upper_open() {
        let mut s = ResumeSession::new([0x44u8; 16]);
        s.on_leg_open();
        s.on_local_data(b"hello ");
        s.on_local_data(b"world");
        s.on_ack(3);
        s.on_leg_dead(1000);
        assert!(s.upper_connection_open());
        assert_eq!(s.state, SessionState::Recovering);
        let replay = s.on_resume(3).expect("resume");
        assert_eq!(replay, b"lo world");
        assert_eq!(s.state, SessionState::Open);
        assert_eq!(s.leg, 2);
    }

    #[test]
    fn resume_replays_even_when_provider_still_marked_open() {
        // B 真机：新腿 RESUME 先到、提供端还没收尾旧腿 → 仍必须从对端偏移重放。
        let mut s = ResumeSession::new([0x45u8; 16]);
        s.on_leg_open();
        s.on_local_data(b"0123456789");
        s.on_ack(4);
        let replay = s.on_resume(4).expect("resume");
        assert_eq!(replay, b"456789", "已发未确认字节必须重放");
        assert_eq!(s.state, SessionState::Open);
        assert_eq!(s.leg, 2);
        assert_eq!(s.on_resume(4).expect("second resume").len(), 6);
    }

    #[test]
    fn resume_rejects_connecting_session() {
        let mut s = ResumeSession::new([0x46u8; 16]);
        assert_eq!(s.on_resume(0), Err(FrameError::ResumeOffsetInvalid));
    }

    #[test]
    fn resume_session_backpressure_and_timeout() {
        let mut s = ResumeSession::new([0x55u8; 16]);
        s.on_leg_open();
        assert_eq!(s.on_local_data(&vec![0u8; 130 * 1024]), ReadAction::Throttled);
        assert_eq!(s.on_local_data(&vec![0u8; 130 * 1024]), ReadAction::Pause);
        s.on_leg_dead(1000);
        s.tick(1000 + ResumeSession::RECOVERY_WINDOW_MS - 1);
        assert_eq!(s.state, SessionState::Recovering);
        s.tick(1000 + ResumeSession::RECOVERY_WINDOW_MS);
        assert_eq!(s.state, SessionState::Closed);
        assert!(!s.upper_connection_open());
    }

    #[test]
    fn read_action_matches_backpressure_thresholds() {
        let mut s = ResumeSession::new([0x66u8; 16]);
        assert_eq!(s.read_action(), ReadAction::Normal);
        s.on_local_data(&vec![0u8; 130 * 1024]);
        assert_eq!(s.read_action(), ReadAction::Throttled);
        s.on_local_data(&vec![0u8; 130 * 1024]);
        assert_eq!(s.read_action(), ReadAction::Pause);
        s.on_ack(s.send_next);
        assert_eq!(s.read_action(), ReadAction::Normal);
    }

    #[test]
    fn seq_is_monotonic_and_nonce_not_reused() {
        let (mut a, _b) = pair();
        let f1 = a.seal_data(0, b"same");
        let f2 = a.seal_data(1, b"same");
        assert_eq!(get_u64(&f1, 6) + 1, get_u64(&f2, 6));
        assert_ne!(f1, f2, "same plaintext different seq must not reuse ciphertext/nonce");
    }
}
