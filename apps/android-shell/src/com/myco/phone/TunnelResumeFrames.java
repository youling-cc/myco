package com.myco.phone;

import java.util.Arrays;

/**
 * TunnelResumeFrames —— resume 能力帧编解码（会话续传 / 迁移不打断流）—— 不对外叫"协议 v2"，避免与握手协议版本混淆。
 *
 * 与 v1（{@link TunnelFrameIo}）的关系：
 *   · v1 只有 HELLO/CONFIRM/DATA，无会话身份、无 ACK、无重放 → 换腿只能重开；
 *   · v2 在**同一条 AEAD 密钥**上新增 5 种控制帧 + DATA 增加 offset 字段，
 *     让"逻辑会话"可以换到新的 WS 腿继续跑（RESUME）。
 *   · 协商：双方在**握手原文（x-myco-tunnel 头）**里带 `"cap":["resume"]`；
 *           对端 raw 里没有该字段（v1 构建）→ 本连接完全走 v1（本类不参与）。
 *           v1 的 TunnelHandshake 没有 deny_unknown_fields，多余字段被 serde 忽略，
 *           且签名/密钥派生都用 raw 原文 → 加字段不破坏兼容（2026-10-31 评审实证）。
 *
 * 线格式（全部大端）：
 *   DATA   : [METR][ver=1][type=3][seq u64][offset u64][prefix 12][AES-256-GCM(ct+tag)]
 *   CONTROL: [METR][ver=1][type][seq u64][prefix 12][AES-256-GCM(ct+tag)]
 *   控制帧的 plaintext = 各自的固定布局（见下方 codec）。
 *
 * 两条硬约束（安全/正确性，实现与评审都以此为准）：
 *   1. **seq 跨腿单调、永不重置**：nonce = prefix 末 8 字节 XOR seq，若换腿后重置 seq
 *      会复用 nonce（GCM 灾难）；单调也顺带提供重放/乱序检测。
 *   2. **RESUME 的 recvOffset 必须落在 [ackedOffset, sendNext]**：否则 GOAWAY。
 *      这是"重放从 ACK 之后第一个未确认字节开始"的形式化证明，防乱序/截断被误当"已收到"。
 *
 * 纯 Java、无 Android 依赖（JVM 单测：eval/vnetfix/TunnelResumeFramesTest.java）。
 */
public final class TunnelResumeFrames {

    /**
     * resume 能力帧的独立魔数 `METR`（MAGIC 后一字节 R）。
     *
     * 为什么不复用 v1 的 `MET2` + ver 位：旧 v1 解析器对 MET2 会进入既有校验分支
     * （长度/ver/type），报错路径不确定；换魔数后旧端在"魔数不符"这一步就**干净拒绝**，
     * 不会误读成 v1 DATA 帧（@DSH协议应用 2026-10-31 评审建议）。
     */
    public static final byte[] MAGIC = {0x4d, 0x45, 0x54, 0x52};
    /** 帧版本（resume 能力帧固定 1；与握手协议版本号无关）。 */
    public static final int VERSION = 1;

    // 帧类型（v1 已占 1/2/3；DATA 在 v2 里布局不同，但类型值沿用 3，靠 ver 区分）
    public static final int T_DATA = 3;
    public static final int T_SESSION_OPEN = 4;
    public static final int T_SESSION_ACK = 5;
    public static final int T_ACK = 6;
    public static final int T_RESUME = 7;
    public static final int T_RESUME_ACK = 8;
    public static final int T_GOAWAY = 9;

    /** DATA 头长度：MAGIC4 + ver1 + type1 + seq8 + offset8 + prefix12。 */
    public static final int DATA_HEADER = 34;
    /** 控制帧头长度：MAGIC4 + ver1 + type1 + seq8 + prefix12。 */
    public static final int CTL_HEADER = 26;
    /** GCM tag 长度。 */
    public static final int TAG_LEN = 16;
    /** sessionId 长度。 */
    public static final int SESSION_ID_LEN = 16;

    // GOAWAY 原因码（对端日志/审计用）
    public static final int GOAWAY_USER_CLOSED = 0;
    public static final int GOAWAY_RECOVERY_TIMEOUT = 1;
    public static final int GOAWAY_PROTOCOL_ERROR = 2;
    public static final int GOAWAY_PEER_GONE = 3;

    private TunnelResumeFrames() { }

    // ══════════════════ 承载 ══════════════════

    /** DATA 帧解析结果。 */
    public static final class Data {
        public final long seq;
        public final long offset;
        public final byte[] plaintext;

        Data(long seq, long offset, byte[] plaintext) {
            this.seq = seq; this.offset = offset; this.plaintext = plaintext;
        }
    }

    /** 控制帧解析结果（payload 已解密，按类型再用下方 codec 解析）。 */
    public static final class Ctl {
        public final int type;
        public final long seq;
        public final byte[] payload;

        Ctl(int type, long seq, byte[] payload) {
            this.type = type; this.seq = seq; this.payload = payload;
        }
    }

    // ══════════════════ 发送端 ══════════════════

    /** 每连接一套的发送/接收状态（seq 跨腿单调；见类注释约束 1）。 */
    public static final class Io {
        private final byte[] txKey;
        private final byte[] rxKey;
        private final byte[] prefix;
        private long sendSeq = 0;
        private long recvMaxSeq = -1;
        private boolean sawRecv = false;

        public Io(TunnelCrypto.SessionKeys keys, int role) {
            boolean orig = role == TunnelFrameIo.ROLE_ORIGINATOR;
            this.txKey = orig ? keys.c2s : keys.s2c;
            this.rxKey = orig ? keys.s2c : keys.c2s;
            this.prefix = keys.prefix;
        }

        public synchronized long sendSeq() { return sendSeq; }

        /** 换腿时保留发送序号：新 prefix + 旧 seq 复用会构成 GCM nonce 重用。 */
        public synchronized void setSendSeq(long seq) { this.sendSeq = seq; }

        public synchronized long recvMaxSeq() { return recvMaxSeq; }

        /** 加密一帧 DATA（带字节偏移）。 */
        public byte[] sealData(long offset, byte[] plaintext) {
            if (offset < 0) throw new TunnelCrypto.FrameException("bad-offset", "offset 不能为负");
            return seal(T_DATA, offset, plaintext, true);
        }

        /** 加密一帧控制帧。 */
        public byte[] sealControl(int type, byte[] payload) {
            if (!isControlType(type)) {
                throw new TunnelCrypto.FrameException("bad-type", "不是控制帧类型: " + type);
            }
            return seal(type, -1, payload == null ? new byte[0] : payload, false);
        }

        private byte[] seal(int type, long offset, byte[] plaintext, boolean hasOffset) {
            long seq;
            synchronized (this) {
                seq = sendSeq;
                sendSeq += 1;
            }
            byte[] nonce = TunnelFrameIo.nonceFor(prefix, seq);
            byte[] ct = TunnelCrypto.aesGcmEncrypt(txKey, nonce, plaintext);
            int hdr = hasOffset ? DATA_HEADER : CTL_HEADER;
            byte[] f = new byte[hdr + ct.length];
            System.arraycopy(MAGIC, 0, f, 0, 4);
            f[4] = (byte) VERSION;
            f[5] = (byte) type;
            for (int i = 0; i < 8; i++) f[6 + i] = (byte) ((seq >>> (8 * (7 - i))) & 0xff);
            int p = 14;
            if (hasOffset) {
                for (int i = 0; i < 8; i++) f[14 + i] = (byte) ((offset >>> (8 * (7 - i))) & 0xff);
                p = 22;
            }
            System.arraycopy(prefix, 0, f, p, 12);
            System.arraycopy(ct, 0, f, hdr, ct.length);
            return f;
        }

        /** 解一帧；返回 Data（type=DATA）或 Ctl（控制帧）。 */
        public Object open(byte[] frame) {
            if (frame == null || frame.length < CTL_HEADER + TAG_LEN
                    || !TunnelCrypto.bytesEqual(frame, 0, MAGIC, 0, 4)) {
                throw new TunnelCrypto.FrameException("plaintext-or-unknown-frame", "收到明文帧或未知帧类型");
            }
            if ((frame[4] & 0xff) != VERSION) {
                throw new TunnelCrypto.FrameException("wrong-version", "不是 v2 帧（ver=" + (frame[4] & 0xff) + "）");
            }
            int type = frame[5] & 0xff;
            boolean data = type == T_DATA;
            if (!data && !isControlType(type)) {
                throw new TunnelCrypto.FrameException("unknown-frame", "未知帧类型: " + type);
            }
            int hdr = data ? DATA_HEADER : CTL_HEADER;
            if (frame.length < hdr + TAG_LEN) {
                throw new TunnelCrypto.FrameException("auth-fail", "帧过短");
            }
            if (frame.length - hdr > TunnelCrypto.FRAME_MAX_PAYLOAD) {
                throw new TunnelCrypto.FrameException("auth-fail", "帧过大");
            }
            long seq = 0;
            for (int i = 6; i < 14; i++) seq = (seq << 8) | (frame[i] & 0xff);
            long offset = -1;
            int p = 14;
            if (data) {
                offset = 0;
                for (int i = 14; i < 22; i++) offset = (offset << 8) | (frame[i] & 0xff);
                p = 22;
            }
            if (!TunnelCrypto.bytesEqual(frame, p, prefix, 0, 12)) {
                throw new TunnelCrypto.FrameException("prefix-mismatch", "帧 nonce 前缀不符（换钥或串台）");
            }
            synchronized (this) {
                if (sawRecv && seq <= recvMaxSeq) {
                    throw new TunnelCrypto.FrameException("replay-or-out-of-order", "帧序号非递增（重放或乱序）");
                }
            }
            byte[] nonce = TunnelFrameIo.nonceFor(prefix, seq);
            byte[] ct = Arrays.copyOfRange(frame, hdr, frame.length);
            byte[] pt = TunnelCrypto.aesGcmDecrypt(rxKey, nonce, ct);
            synchronized (this) {
                recvMaxSeq = seq;
                sawRecv = true;
            }
            return data ? new Data(seq, offset, pt) : new Ctl(type, seq, pt);
        }
    }

    public static boolean isControlType(int t) {
        return t == T_SESSION_OPEN || t == T_SESSION_ACK || t == T_ACK
                || t == T_RESUME || t == T_RESUME_ACK || t == T_GOAWAY;
    }

    // ══════════════════ 控制帧载荷 codec ══════════════════

    /** SESSION_OPEN: sessionId(16) + initialSeq(8)。 */
    public static byte[] encodeSessionOpen(byte[] sessionId, long initialSeq) {
        requireSid(sessionId);
        byte[] b = new byte[24];
        System.arraycopy(sessionId, 0, b, 0, 16);
        putU64(b, 16, initialSeq);
        return b;
    }

    public static final class SessionOpen {
        public final byte[] sessionId;
        public final long initialSeq;

        SessionOpen(byte[] sid, long seq) { this.sessionId = sid; this.initialSeq = seq; }
    }

    public static SessionOpen decodeSessionOpen(byte[] p) {
        requireLen(p, 24, "session-open");
        return new SessionOpen(Arrays.copyOfRange(p, 0, 16), getU64(p, 16));
    }

    /** SESSION_ACK: sessionId(16) + recvOffset(8)。 */
    public static byte[] encodeSessionAck(byte[] sessionId, long recvOffset) {
        requireSid(sessionId);
        byte[] b = new byte[24];
        System.arraycopy(sessionId, 0, b, 0, 16);
        putU64(b, 16, recvOffset);
        return b;
    }

    public static final class SessionAck {
        public final byte[] sessionId;
        public final long recvOffset;

        SessionAck(byte[] sid, long off) { this.sessionId = sid; this.recvOffset = off; }
    }

    public static SessionAck decodeSessionAck(byte[] p) {
        requireLen(p, 24, "session-ack");
        return new SessionAck(Arrays.copyOfRange(p, 0, 16), getU64(p, 16));
    }

    /** ACK: recvOffset(8)。 */
    public static byte[] encodeAck(long recvOffset) {
        byte[] b = new byte[8];
        putU64(b, 0, recvOffset);
        return b;
    }

    public static long decodeAck(byte[] p) {
        requireLen(p, 8, "ack");
        return getU64(p, 0);
    }

    /** RESUME: sessionId(16) + recvOffset(8) + sendOffset(8)。 */
    public static byte[] encodeResume(byte[] sessionId, long recvOffset, long sendOffset) {
        requireSid(sessionId);
        byte[] b = new byte[32];
        System.arraycopy(sessionId, 0, b, 0, 16);
        putU64(b, 16, recvOffset);
        putU64(b, 24, sendOffset);
        return b;
    }

    public static final class Resume {
        public final byte[] sessionId;
        public final long recvOffset;
        public final long sendOffset;

        Resume(byte[] sid, long ro, long so) {
            this.sessionId = sid; this.recvOffset = ro; this.sendOffset = so;
        }
    }

    public static Resume decodeResume(byte[] p) {
        requireLen(p, 32, "resume");
        return new Resume(Arrays.copyOfRange(p, 0, 16), getU64(p, 16), getU64(p, 24));
    }

    /** RESUME_ACK: recvOffset(8)。 */
    public static byte[] encodeResumeAck(long recvOffset) {
        return encodeAck(recvOffset);
    }

    public static long decodeResumeAck(byte[] p) {
        return decodeAck(p);
    }

    /** GOAWAY: reason(1) + recvOffset(8) + sendOffset(8)。 */
    public static byte[] encodeGoaway(int reason, long recvOffset, long sendOffset) {
        byte[] b = new byte[17];
        b[0] = (byte) reason;
        putU64(b, 1, recvOffset);
        putU64(b, 9, sendOffset);
        return b;
    }

    public static final class Goaway {
        public final int reason;
        public final long recvOffset;
        public final long sendOffset;

        Goaway(int r, long ro, long so) { this.reason = r; this.recvOffset = ro; this.sendOffset = so; }
    }

    public static Goaway decodeGoaway(byte[] p) {
        requireLen(p, 17, "goaway");
        return new Goaway(p[0] & 0xff, getU64(p, 1), getU64(p, 9));
    }

    /**
     * P0 约束：RESUME 的 recvOffset 必须落在 [ackedOffset, sendNext]。
     *
     * 语义：调用方（收到 RESUME 的一方）手里有
     *   · sendNext    = 本端已发出的最后一个字节的下一位置（未确认上界）
     *   · ackedOffset = 对端 ACK 已确认到的位置（已确认下界）
     * 对端说"我收到了 recvOffset" —— 它既不能小于已确认下界（那说明它退化了/重放旧状态），
     * 也不能大于本端发过的量（说明它收到过本端没发的数据 = 伪造/串台）。
     *
     * @throws TunnelCrypto.FrameException code=resume-offset-invalid
     */
    public static void validateResumeOffset(long recvOffset, long ackedOffset, long sendNext) {
        if (ackedOffset < 0 || sendNext < ackedOffset) {
            throw new TunnelCrypto.FrameException("resume-offset-invalid", "本端记账异常 acked=" + ackedOffset + " next=" + sendNext);
        }
        if (recvOffset < ackedOffset) {
            throw new TunnelCrypto.FrameException("resume-offset-invalid",
                    "对端回退到已确认位置之前 recv=" + recvOffset + " acked=" + ackedOffset);
        }
        if (recvOffset > sendNext) {
            throw new TunnelCrypto.FrameException("resume-offset-invalid",
                    "对端声称收到未发送的数据 recv=" + recvOffset + " next=" + sendNext);
        }
    }

    // ══════════════════ 工具 ══════════════════

    private static void requireSid(byte[] sid) {
        if (sid == null || sid.length != SESSION_ID_LEN) {
            throw new TunnelCrypto.FrameException("bad-session-id", "sessionId 必须 16B");
        }
    }

    private static void requireLen(byte[] p, int len, String what) {
        if (p == null || p.length != len) {
            throw new TunnelCrypto.FrameException("bad-payload", what + " 载荷长度应为 " + len + "，实际 " + (p == null ? -1 : p.length));
        }
    }

    public static void putU64(byte[] b, int off, long v) {
        for (int i = 0; i < 8; i++) b[off + i] = (byte) ((v >>> (8 * (7 - i))) & 0xff);
    }

    public static long getU64(byte[] b, int off) {
        long v = 0;
        for (int i = 0; i < 8; i++) v = (v << 8) | (b[off + i] & 0xff);
        return v;
    }
}
