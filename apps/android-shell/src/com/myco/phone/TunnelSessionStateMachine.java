package com.myco.phone;

import java.io.ByteArrayOutputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.List;

/**
 * TunnelSessionStateMachine — 逻辑会话/传输腿分离（P2b，纯 Java，无 Android 依赖）。
 *
 * 黑盒语义：
 * - 腿死只进入 RECOVERING，**不向本地连接发 FIN/RST**；
 * - 新腿 RESUME 成功后，从对端 ACK 之后的首个未确认字节按序重放；
 * - 只有超过恢复窗口（默认 15s）或收到非法 RESUME，才 CLOSED（GOAWAY）。
 *
 * 背压（评审口径）：
 * - sendBuf > 128KB：限速（继续读，降为 1/4 速），不硬停；
 * - sendBuf > 256KB：停读，防内存无限增长。
 */
public final class TunnelSessionStateMachine {
    public enum State { CONNECTING, OPEN, RECOVERING, CLOSED }

    public enum ReadAction { NORMAL, THROTTLED, PAUSE }

    public static final long DEFAULT_RECOVERY_WINDOW_MS = 15_000L;
    public static final int THROTTLE_AFTER = 128 * 1024;
    public static final int PAUSE_AFTER = 256 * 1024;

    private final byte[] sessionId;
    private final long recoveryWindowMs;
    private State state = State.CONNECTING;
    private int leg = 0;
    private long recoveringSince = -1;
    private long recoveryDeadline = -1;

    private long sendNext = 0;       // 本端已生成的字节偏移（下一位置）
    private long ackedOffset = 0;    // 对端已确认的位置
    private long recvOffset = 0;     // 对端已消费的位置（接收方向）
    private final Deque<byte[]> pending = new ArrayDeque<>();
    private long pendingBytes = 0;

    public TunnelSessionStateMachine(byte[] sessionId) {
        this(sessionId, DEFAULT_RECOVERY_WINDOW_MS);
    }

    public TunnelSessionStateMachine(byte[] sessionId, long recoveryWindowMs) {
        if (sessionId == null || sessionId.length != 16) throw new IllegalArgumentException("sessionId 必须 16B");
        this.sessionId = sessionId.clone();
        this.recoveryWindowMs = recoveryWindowMs;
    }

    public byte[] sessionId() { return sessionId.clone(); }
    public State state() { return state; }
    public int leg() { return leg; }
    public long sendNext() { return sendNext; }
    public long ackedOffset() { return ackedOffset; }
    public long recvOffset() { return recvOffset; }
    public long pendingBytes() { return pendingBytes; }
    public long recoveryDeadline() { return recoveryDeadline; }

    /** 对端 RESUME miss 后回 SESSION_ACK：重置为一个全新的逻辑会话。 */
    public void reset() {
        state = State.CONNECTING;
        leg = 0;
        recoveringSince = -1;
        recoveryDeadline = -1;
        sendNext = 0;
        ackedOffset = 0;
        recvOffset = 0;
        pending.clear();
        pendingBytes = 0;
    }

    /** 接收方向消费字节（驱动 RESUME 的 recvOffset 推进）。 */
    public void onDataReceived(long n) { recvOffset += n; }

    /** 本地连接是否应对上层保持打开（RECOVERING 期间必须为 true）。 */
    public boolean upperConnectionOpen() { return state != State.CLOSED; }

    /** 建腿/首腿成功。 */
    public void onLegOpen() {
        if (state == State.CLOSED) return;
        leg += 1;
        state = State.OPEN;
        recoveringSince = -1;
        recoveryDeadline = -1;
    }

    /** 当前腿死：只换状态，不关上层。 */
    public void onLegDead(long nowMs) {
        if (state == State.CLOSED) return;
        state = State.RECOVERING;
        recoveringSince = nowMs;
        recoveryDeadline = nowMs + recoveryWindowMs;
    }

    /** 上层产生的数据进入发送缓冲（重放/背压用）。 */
    public ReadAction onLocalData(byte[] data) {
        if (state == State.CLOSED || data == null || data.length == 0) return ReadAction.PAUSE;
        pending.addLast(data.clone());
        pendingBytes += data.length;
        sendNext += data.length;
        if (pendingBytes > PAUSE_AFTER) return ReadAction.PAUSE;
        if (pendingBytes > THROTTLE_AFTER) return ReadAction.THROTTLED;
        return ReadAction.NORMAL;
    }

    /** 对端确认：释放已确认缓冲，推进 ackedOffset。 */
    public void onAck(long offset) {
        if (offset <= ackedOffset) return;
        ackedOffset = Math.min(offset, sendNext);
        while (!pending.isEmpty()) {
            byte[] head = pending.peekFirst();
            long end = ackedOffset - (sendNext - pendingBytes);
            if (end <= 0) break;
            if (end >= head.length) {
                pendingBytes -= head.length;
                pending.removeFirst();
            } else {
                byte[] rest = Arrays.copyOfRange(head, (int) end, head.length);
                pendingBytes -= end;
                pending.removeFirst();
                pending.addFirst(rest);
                break;
            }
        }
    }

    /**
     * 新腿 RESUME：校验 offset 后返回**从该偏移起**的重放片段。
     * 不合法则 GOAWAY，绝不把乱序/截断误当“已收到”。
     */
    public byte[] onResume(long peerRecvOffset, long nowMs) {
        if (state != State.RECOVERING) {
            if (state == State.OPEN) return new byte[0];
            throw new IllegalStateException("非恢复中不能 RESUME");
        }
        TunnelResumeFrames.validateResumeOffset(peerRecvOffset, ackedOffset, sendNext);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        long skip = peerRecvOffset - (sendNext - pendingBytes);
        for (byte[] chunk : pending) {
            if (skip >= chunk.length) {
                skip -= chunk.length;
                continue;
            }
            if (skip > 0) {
                out.write(chunk, (int) skip, chunk.length - (int) skip);
                skip = 0;
            } else {
                out.write(chunk, 0, chunk.length);
            }
        }
        state = State.OPEN;
        leg += 1;
        recoveringSince = -1;
        recoveryDeadline = -1;
        return out.toByteArray();
    }

    /** 恢复窗口检查：到点才允许暴露失败。 */
    public void tick(long nowMs) {
        if (state == State.RECOVERING && nowMs >= recoveryDeadline) {
            state = State.CLOSED;
        }
    }

    /** 对端彻底不可恢复/协议错误时的主动终止（唯一允许 GOAWAY 的另外两条路径）。 */
    public void goaway() { state = State.CLOSED; }

    /** 测试/诊断：当前窗口剩余毫秒；非 RECOVERING 返回 -1。 */
    public long recoveringRemainingMs(long nowMs) {
        return state == State.RECOVERING ? recoveryDeadline - nowMs : -1;
    }

    /** 未确认数据的字节序列（诊断，不暴露给上层业务）。 */
    public List<byte[]> pendingChunks() {
        List<byte[]> out = new ArrayList<>();
        for (byte[] b : pending) out.add(b.clone());
        return out;
    }
}
