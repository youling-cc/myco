package com.myco.phone;

import java.util.Arrays;

/**
 * TunnelFrameIo — v2 线协议帧编解码器（一个连接一套；发送/接收各自单调序号）。
 *
 * 与 JS `p2p-tunnel.ts` 的 `FrameIo`、Rust `p2p_tunnel.rs` 的 `FrameIo` 逐字节对齐：
 *   · HELLO/CONFIRM：38B 明文帧（[MET2][ver][type][载荷 32B]）
 *   · DATA：[MET2][ver=1][type=3][seq u64 BE][noncePrefix 12B][AES-256-GCM(ct+tag)]
 *   · nonce = prefix 的末 8 字节（大端 u64）异或 seq
 *   · 接收校验顺序与 JS `open()` 一致：魔数 → 长度 → 版本 → 类型 → 前缀 → 序号 → GCM；
 *     **只有 GCM 通过后才推进 recvMaxSeq**（坏帧不能把序号推到未来）。
 *
 * 线程约定（与 NativeRdpConn 的用法绑定）：
 *   · {@link #seal} 只在**单个发送线程**（本地 socket 读线程，sendLock 内）调用；
 *   · {@link #open} 只在**单个接收线程**（TunnelWs reader 线程）调用。
 *   因此内部无锁；跨线程使用由调用方的锁保证。
 */
public class TunnelFrameIo {

    /** 本连接角色（决定方向密钥与确认键的取用）。 */
    public static final int ROLE_ORIGINATOR = 0;
    public static final int ROLE_RESPONDER = 1;

    public final TunnelCrypto.SessionKeys keys;
    public final int role;
    public final String handshakeRaw;

    private final byte[] txKey;
    private final byte[] rxKey;
    private final byte[] confirmKey;
    private final byte[] peerConfirmKey;
    private long sendSeq = 0;
    private long recvMaxSeq = -1; // -1 = 还没收到过（JS 里是 null）
    private boolean sawRecv = false;

    public TunnelFrameIo(TunnelCrypto.SessionKeys keys, int role, String handshakeRaw) {
        this.keys = keys;
        this.role = role;
        this.handshakeRaw = handshakeRaw;
        boolean orig = role == ROLE_ORIGINATOR;
        this.txKey = orig ? keys.c2s : keys.s2c;
        this.rxKey = orig ? keys.s2c : keys.c2s;
        this.confirmKey = orig ? keys.confirmC2s : keys.confirmS2c;
        this.peerConfirmKey = orig ? keys.confirmS2c : keys.confirmC2s;
    }

    // ══════════════════ 握手帧 ══════════════════

    /** HELLO 帧：[MAGIC][ver][HELLO][pub32]。 */
    public static byte[] helloFrame(byte[] pub32) {
        if (pub32 == null || pub32.length != 32) {
            throw new TunnelCrypto.FrameException("hello-malformed", "HELLO 载荷必须 32B");
        }
        byte[] f = new byte[TunnelCrypto.FRAME_HELLO_LEN];
        System.arraycopy(TunnelCrypto.FRAME_MAGIC, 0, f, 0, 4);
        f[4] = (byte) TunnelCrypto.FRAME_FORMAT_VERSION;
        f[5] = (byte) TunnelCrypto.FRAME_HELLO;
        System.arraycopy(pub32, 0, f, 6, 32);
        return f;
    }

    /** 解析 HELLO 帧 → 32B 公钥（校验魔数/版本/类型/长度）。 */
    public static byte[] parseHello(byte[] frame) {
        if (frame == null || frame.length != TunnelCrypto.FRAME_HELLO_LEN
                || !TunnelCrypto.bytesEqual(frame, 0, TunnelCrypto.FRAME_MAGIC, 0, 4)) {
            throw new TunnelCrypto.FrameException("hello-malformed", "加密握手帧无效");
        }
        if ((frame[4] & 0xff) != TunnelCrypto.FRAME_FORMAT_VERSION
                || (frame[5] & 0xff) != TunnelCrypto.FRAME_HELLO) {
            throw new TunnelCrypto.FrameException("hello-malformed", "加密握手帧无效");
        }
        return Arrays.copyOfRange(frame, 6, 38);
    }

    /** 本方向确认帧（明文 MAC 载荷 = HMAC-SHA256(确认键, 握手原文)）。 */
    public byte[] confirmFrame() {
        byte[] mac = TunnelCrypto.hmacSha256(confirmKey, TunnelCrypto.utf8(handshakeRaw));
        byte[] f = new byte[TunnelCrypto.FRAME_HELLO_LEN];
        System.arraycopy(TunnelCrypto.FRAME_MAGIC, 0, f, 0, 4);
        f[4] = (byte) TunnelCrypto.FRAME_FORMAT_VERSION;
        f[5] = (byte) TunnelCrypto.FRAME_CONFIRM;
        System.arraycopy(mac, 0, f, 6, 32);
        return f;
    }

    /** 校验对端确认帧（不一致 = MITM/降级/密钥不一致 → confirm-mismatch）。 */
    public void acceptConfirm(byte[] frame) {
        if (frame == null || frame.length != TunnelCrypto.FRAME_HELLO_LEN
                || !TunnelCrypto.bytesEqual(frame, 0, TunnelCrypto.FRAME_MAGIC, 0, 4)) {
            throw new TunnelCrypto.FrameException("hello-malformed", "加密握手帧无效");
        }
        if ((frame[4] & 0xff) != TunnelCrypto.FRAME_FORMAT_VERSION
                || (frame[5] & 0xff) != TunnelCrypto.FRAME_CONFIRM) {
            throw new TunnelCrypto.FrameException("plaintext-or-unknown-frame", "收到明文帧或未知帧类型");
        }
        byte[] want = TunnelCrypto.hmacSha256(peerConfirmKey, TunnelCrypto.utf8(handshakeRaw));
        if (!TunnelCrypto.bytesEqual(frame, 6, want, 0, 32)) {
            throw new TunnelCrypto.FrameException("confirm-mismatch", "会话密钥确认失败");
        }
    }

    // ══════════════════ 数据帧 ══════════════════

    /** 已发送帧数（诊断）。 */
    public synchronized long sentFrames() {
        return sendSeq;
    }

    /** 数据帧 nonce = prefix 末 8 字节（大端 u64）异或 seq（与 JS nonceFor 一致）。 */
    public static byte[] nonceFor(byte[] prefix12, long seq) {
        byte[] n = prefix12.clone();
        long tail = 0;
        for (int i = 4; i < 12; i++) tail = (tail << 8) | (n[i] & 0xff);
        tail ^= seq;
        for (int i = 11; i >= 4; i--) {
            n[i] = (byte) (tail & 0xff);
            tail >>>= 8;
        }
        return n;
    }

    /** 加密一帧（序号自增；调用方保证单线程）。 */
    public byte[] seal(byte[] plaintext) {
        long seq;
        synchronized (this) {
            seq = sendSeq;
            sendSeq += 1;
        }
        byte[] nonce = nonceFor(keys.prefix, seq);
        byte[] ct = TunnelCrypto.aesGcmEncrypt(txKey, nonce, plaintext);
        byte[] f = new byte[TunnelCrypto.FRAME_DATA_HEADER + ct.length];
        System.arraycopy(TunnelCrypto.FRAME_MAGIC, 0, f, 0, 4);
        f[4] = (byte) TunnelCrypto.FRAME_FORMAT_VERSION;
        f[5] = (byte) TunnelCrypto.FRAME_DATA;
        for (int i = 0; i < 8; i++) f[6 + i] = (byte) ((seq >>> (8 * (7 - i))) & 0xff);
        System.arraycopy(keys.prefix, 0, f, 14, 12);
        System.arraycopy(ct, 0, f, TunnelCrypto.FRAME_DATA_HEADER, ct.length);
        return f;
    }

    /**
     * 解一帧 → 明文（校验结构 + nonce 前缀 + tag + 单调序号）。
     * 校验顺序与 JS open() 一致；GCM 通过后才推进 recvMaxSeq。
     */
    public byte[] open(byte[] frame) {
        if (frame == null || frame.length < 4
                || !TunnelCrypto.bytesEqual(frame, 0, TunnelCrypto.FRAME_MAGIC, 0, 4)) {
            throw new TunnelCrypto.FrameException("plaintext-or-unknown-frame", "收到明文帧或未知帧类型");
        }
        if (frame.length < TunnelCrypto.FRAME_DATA_HEADER + 16) {
            throw new TunnelCrypto.FrameException("auth-fail", "帧过短");
        }
        if ((frame[4] & 0xff) != TunnelCrypto.FRAME_FORMAT_VERSION) {
            throw new TunnelCrypto.FrameException("plaintext-or-unknown-frame", "收到明文帧或未知帧类型");
        }
        if ((frame[5] & 0xff) != TunnelCrypto.FRAME_DATA) {
            // HELLO/CONFIRM 只允许出现在握手阶段；数据阶段收到即拒（防降级/注入）
            throw new TunnelCrypto.FrameException("plaintext-or-unknown-frame", "收到明文帧或未知帧类型");
        }
        if (frame.length - TunnelCrypto.FRAME_DATA_HEADER > TunnelCrypto.FRAME_MAX_PAYLOAD) {
            throw new TunnelCrypto.FrameException("auth-fail", "帧过大");
        }
        long seq = 0;
        for (int i = 6; i < 14; i++) seq = (seq << 8) | (frame[i] & 0xff);
        if (!TunnelCrypto.bytesEqual(frame, 14, keys.prefix, 0, 12)) {
            throw new TunnelCrypto.FrameException("prefix-mismatch", "帧 nonce 前缀不符（换钥或串台）");
        }
        synchronized (this) {
            if (sawRecv && seq <= recvMaxSeq) {
                throw new TunnelCrypto.FrameException("replay-or-out-of-order", "帧序号非递增（重放或乱序）");
            }
        }
        byte[] nonce = nonceFor(keys.prefix, seq);
        byte[] ct = Arrays.copyOfRange(frame, TunnelCrypto.FRAME_DATA_HEADER, frame.length);
        byte[] pt = TunnelCrypto.aesGcmDecrypt(rxKey, nonce, ct);
        synchronized (this) {
            recvMaxSeq = seq;
            sawRecv = true;
        }
        return pt;
    }
}
