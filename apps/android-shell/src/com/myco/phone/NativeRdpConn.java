package com.myco.phone;

import java.io.OutputStream;
import java.net.Socket;
import java.util.ArrayList;
import java.util.List;

import com.myco.phone.TunnelResumeFrames;
import com.myco.phone.TunnelSessionStateMachine;

/**
 * NativeRdpConn — 一条本地 RDP 连接的完整生命周期（顶层类，d8 纪律）。
 *
 * 职责（协调线程 `myco-rdp-<connId>` + 复用两个既有读线程做泵）：
 *   ① 并行拨全部候选腿（每腿一个 {@link NativeRdpDialer}，首个完成加密握手者胜——
 *      与 JS raceCandidates 同构：vnet 场景 relay 腿不让先）
 *   ② 胜者 adopt（补泵握手期 early 帧后接上直通泵）
 *   ③ 冲刷建链前暂存的本地首包（RDP 的 X.224 Connection Request 一包，丢了就僵住）
 *   ④ 双向泵：
 *      上行：ForwardListener 本地读线程 → onLocalData → seal → WS
 *      下行：TunnelWs reader 线程 → pumpFrame(open) → 本地 socket 写回
 *   ⑤ 收尾：本地 EOF/drop → 关 WS（close 帧）；WS 断 → 关本地。双向幂等。
 *
 * 协调线程在 ③ 之后即退场——泵完全由两个读线程驱动，零常驻线程。
 *
 * 关闭语义对齐 JS vnet-forward：本地先关 → ws.close(1000)；隧道先断 →
 * ForwardListener.close（本地 socket 关闭 + drop 事件）。JS 侧 onClosed 回调
 * 对无 session 的连接是 no-op（live map 查不到即返回），不受影响。
 */
public class NativeRdpConn implements Runnable {

    /** 本地读块大小（对齐 Rust TUNNEL_CHUNK 注释的快区：16KB 起步，帧数/吞吐折中）。 */
    static final int CHUNK = 32 * 1024;
    /** 建链前暂存上限（JS pending 是 32 包；32KB×64=2MB，防对端发疯打爆内存）。 */
    private static final int PREQUEUE_MAX_CHUNKS = 64;

    final NativeRdpTunnel.Config cfg;
    final int localPort;
    final int connId;
    private final Socket local;

    /** 建链前暂存的本地首包（onLocalData 在 ForwardListener 读线程上进来）。 */
    private final List<byte[]> preQueue = new ArrayList<byte[]>();
    private final Object sendLock = new Object();
    private volatile boolean pumping = false;

    private final Object localWriteLock = new Object();
    private final Object lifecycleLock = new Object();
    private volatile boolean localClosed = false;
    private volatile boolean wsClosed = false;

    private volatile TunnelWs ws;
    private volatile TunnelFrameIo io;
    private volatile TunnelResumeFrames.Io resumeIo;
    private final TunnelSessionStateMachine session;
    private volatile boolean recovering = false;

    private long inBytes = 0;
    private long outBytes = 0;
    private final long startedAtMs = System.currentTimeMillis();

    NativeRdpConn(NativeRdpTunnel.Config cfg, int localPort, int connId, Socket local) {
        this.cfg = cfg;
        this.localPort = localPort;
        this.connId = connId;
        this.local = local;
        this.session = new TunnelSessionStateMachine(makeSessionId(connId, startedAtMs));
    }

    private static byte[] makeSessionId(int connId, long startedAtMs) {
        byte[] sid = new byte[16];
        for (int i = 0; i < 8; i++) sid[i] = (byte) ((connId >>> (8 * (7 - i))) & 0xff);
        for (int i = 0; i < 8; i++) sid[8 + i] = (byte) ((startedAtMs >>> (8 * (7 - i))) & 0xff);
        return sid;
    }

    // ══════════════════ 协调线程：赛跑 + 接泵 ══════════════════

    @Override
    public void run() {
        try {
            raceAndPump();
        } catch (Throwable t) {
            GwLog.note(null, "native-rdp conn " + connId + " 意外退出 " + t);
            closeLocal("internal-error");
        }
    }

    private void raceAndPump() {
        List<String> legs = cfg.legs;
        NativeRdpDialer[] dialers = new NativeRdpDialer[legs.size()];
        Thread[] threads = new Thread[legs.size()];
        for (int i = 0; i < legs.size(); i++) {
            dialers[i] = new NativeRdpDialer(this, legs.get(i), i);
            threads[i] = new Thread(dialers[i], "myco-rdp-dial-" + connId + "-" + i);
            threads[i].setDaemon(true);
        }
        for (Thread t : threads) t.start();

        NativeRdpDialer win = null;
        long deadline = System.currentTimeMillis() + NativeRdpTunnel.RACE_TOTAL_MS;
        while (System.currentTimeMillis() < deadline && !localClosed) {
            win = firstDone(dialers);
            if (win != null) break;
            if (allDone(dialers)) break;
            try {
                Thread.sleep(40);
            } catch (InterruptedException e) {
                break;
            }
        }
        if (win == null) {
            String why = joinErrs(dialers);
            for (NativeRdpDialer d : dialers) d.cancel();
            NativeRdpTunnel.noteFail(connId, localPort, why);
            closeLocal("no-route");
            return;
        }
        // 败者收尾（其 PC 侧会话随 WS 关闭自然回收）
        for (NativeRdpDialer d : dialers) {
            if (d != win) d.cancel();
        }
        // 2026-10-26 P1 竞态修复：本地/WS 在 winner 发布前已关时，
        // 绝不再 adopt——否则会留下一条挂在 PC 侧的孤儿隧道。
        synchronized (lifecycleLock) {
            if (localClosed || wsClosed || win.wsClosed || win.ws == null || win.io == null) {
                win.cancel();
                NativeRdpTunnel.noteFail(connId, localPort, "closed-before-adopt");
                closeLocal("closed-before-adopt");
                return;
            }
            ws = win.ws;
            io = win.io;
            wsClosed = false;
        }
        NativeRdpTunnel.noteEstablished(connId, localPort, win.name, System.currentTimeMillis() - startedAtMs);
        // 下行接泵（锁内补泵 early/残余帧，见 NativeRdpDialer.adopt）
        win.adopt();
        openResumeSession();
        // adopt 期间本地/WS 可能已关：再查一次，避免对已死连接冲首包
        if (localClosed || wsClosed) {
            wsClose("closed-after-adopt");
            return;
        }
        // 上行开泵：先冲暂存首包再放行直通（sendLock 保证 seal 序列化）
        synchronized (sendLock) {
            if (localClosed || wsClosed) {
                pumping = false;
                preQueue.clear();
                wsClose("closed-before-pump");
                return;
            }
            pumping = true;
            for (byte[] chunk : preQueue) {
                sealSendLocked(chunk);
            }
            preQueue.clear();
        }
    }

    private void openResumeSession() {
        if (io == null || ws == null) return;
        long oldSeq = resumeIo == null ? 0 : resumeIo.sendSeq();
        resumeIo = new TunnelResumeFrames.Io(io.keys, io.role);
        if (oldSeq > 0) resumeIo.setSendSeq(oldSeq);
        try {
            if (session.state() == TunnelSessionStateMachine.State.CONNECTING) {
                session.onLegOpen();
                ws.sendBinary(resumeIo.sealControl(
                        TunnelResumeFrames.T_SESSION_OPEN,
                        TunnelResumeFrames.encodeSessionOpen(session.sessionId(), 0)));
            } else if (session.state() == TunnelSessionStateMachine.State.RECOVERING) {
                ws.sendBinary(resumeIo.sealControl(
                        TunnelResumeFrames.T_RESUME,
                        TunnelResumeFrames.encodeResume(session.sessionId(), session.recvOffset(), session.sendNext())));
            }
        } catch (Exception e) {
            GwLog.note(null, "native-rdp conn " + connId + " resume open 失败 " + e);
        }
    }

    private static NativeRdpDialer firstDone(NativeRdpDialer[] ds) {
        // 数组序 = JS 候选优先序（direct → relay）：同刻多腿成功时直连优先
        for (NativeRdpDialer d : ds) {
            if (d.done && d.err.isEmpty()) return d;
        }
        return null;
    }

    private static boolean allDone(NativeRdpDialer[] ds) {
        for (NativeRdpDialer d : ds) {
            if (!d.done) return false;
        }
        return true;
    }

    private static String joinErrs(NativeRdpDialer[] ds) {
        StringBuilder sb = new StringBuilder();
        for (NativeRdpDialer d : ds) {
            if (d.err.isEmpty()) continue;
            if (sb.length() > 0) sb.append(" ; ");
            sb.append(d.name).append(':').append(d.err.length() > 120 ? d.err.substring(0, 120) : d.err);
            if (sb.length() > 600) break;
        }
        return sb.length() == 0 ? "race timeout" : sb.toString();
    }

    // ══════════════════ 上行：本地字节 → 密文帧（ForwardListener 读线程） ══════════════════

    /** ForwardListener 读线程进来（onRead → NativeRdpTunnel.onLocalData → 这里）。 */
    void onLocalData(byte[] data) {
        if (data == null || data.length == 0) return;
        synchronized (sendLock) {
            if (!pumping) {
                if (preQueue.size() >= PREQUEUE_MAX_CHUNKS) {
                    // 静默丢 TCP 中间字节会把流打坏——溢出必须断链，让客户端重连。
                    pumping = false;
                    preQueue.clear();
                    closeLocal("prequeue-overflow");
                    wsClose("prequeue-overflow");
                    return;
                }
                preQueue.add(data);
                return;
            }
            sealSendLocked(data);
        }
    }

    /** seal + 发送（必须持 sendLock：FrameIo.seal 的序号递增要串行）。 */
    private void sealSendLocked(byte[] chunk) {
        if (localClosed || wsClosed) return;
        TunnelResumeFrames.Io framer = resumeIo;
        TunnelWs w = ws;
        if (framer == null || w == null) return;
        try {
            w.sendBinary(framer.sealData(session.sendNext(), chunk));
            session.onLocalData(chunk);
            outBytes += chunk.length;
        } catch (Exception e) {
            closeLocal("send-fail");
            wsClose("send-fail");
        }
    }

    // ══════════════════ 下行：密文帧 → 本地字节（TunnelWs reader 线程） ══════════════════

    /** NativeRdpDialer 转来的密文帧：解密 → 写回本地 socket。 */
    void pumpFrame(byte[] frame) {
        TunnelResumeFrames.Io framer = resumeIo;
        if (framer == null) return;
        try {
            Object opened = framer.open(frame);
            if (opened instanceof TunnelResumeFrames.Data) {
                TunnelResumeFrames.Data d = (TunnelResumeFrames.Data) opened;
                session.onDataReceived(d.plaintext.length);
                if (d.plaintext.length > 0) writeLocal(d.plaintext);
                inBytes += d.plaintext.length;
                // 回 ACK：让对端推进已确认偏移并裁剪待重放缓冲。
                ws.sendBinary(resumeIo.sealControl(
                        TunnelResumeFrames.T_ACK,
                        TunnelResumeFrames.encodeAck(session.recvOffset())));
            } else if (opened instanceof TunnelResumeFrames.Ctl) {
                TunnelResumeFrames.Ctl c = (TunnelResumeFrames.Ctl) opened;
                if (c.type == TunnelResumeFrames.T_ACK) {
                    session.onAck(TunnelResumeFrames.decodeAck(c.payload));
                } else if (c.type == TunnelResumeFrames.T_RESUME_ACK) {
                    long acked = TunnelResumeFrames.decodeAck(c.payload);
                    byte[] replay = session.onResume(acked, System.currentTimeMillis());
                    if (replay.length > 0) ws.sendBinary(resumeIo.sealData(acked, replay));
                    recovering = false;
                } else if (c.type == TunnelResumeFrames.T_SESSION_ACK) {
                    // 提供端 RESUME miss 后回 SESSION_ACK：重置为新会话，避免把旧数据重放到已消失会话。
                    session.reset();
                    session.onLegOpen();
                    recovering = false;
                } else if (c.type == TunnelResumeFrames.T_GOAWAY) {
                    closeLocal("goaway");
                }
            }
        } catch (java.io.IOException e) {
            closeLocal("resume-send-fail");
        } catch (TunnelCrypto.FrameException e) {
            GwLog.note(null, "native-rdp conn " + connId + " 帧错误 " + e.code + " → 关闭");
            closeLocal("enc-fail-" + e.code);
            wsClose("enc-fail");
        } catch (RuntimeException e) {
            GwLog.note(null, "native-rdp conn " + connId + " resume 状态错误 " + e);
            closeLocal("resume-state-error");
            wsClose("resume-state-error");
        }
    }

    private void writeLocal(byte[] pt) {
        try {
            synchronized (localWriteLock) {
                OutputStream os = local.getOutputStream();
                os.write(pt);
                os.flush();
            }
        } catch (Exception e) {
            closeLocal("write-fail");
        }
    }

    // ══════════════════ 关闭（双向幂等） ══════════════════

    /** 本地连接没了（EOF/drop/stop，ForwardListener 调）→ 收尾 WS + 清账。 */
    void onLocalGone(String why) {
        wsClose("local-closed");
        closeLocal(why == null || why.isEmpty() ? "local-closed" : why);
    }

    /** WS 断了（dialer.onClosed → 这里）→ 不直接关本地，进入 RECOVERING 并重拨/RESUME。 */
    void onWsClosed(int code, String reason) {
        if (localClosed) return;
        if (recovering) return;
        session.onLegDead(System.currentTimeMillis());
        recovering = true;
        wsClose("tunnel-closed-" + code);
        Thread t = new Thread(() -> {
            try {
                raceAndPump();
            } catch (Throwable e) {
                GwLog.note(null, "native-rdp conn " + connId + " resume 重拨异常 " + e);
            } finally {
                recovering = false;
            }
        }, "myco-rdp-resume-" + connId);
        t.setDaemon(true);
        t.start();
    }

    /** 关本地（幂等）：socket 已由 ForwardListener.drop 关闭，这里只清账。 */
    private void closeLocal(String why) {
        synchronized (lifecycleLock) {
            if (localClosed) return;
            localClosed = true;
        }
        try {
            local.close();
        } catch (Exception ignored) {
        }
        NativeRdpTunnel.noteConnClosed(this, why, inBytes, outBytes);
    }

    /** 关 WS（幂等）：发 close 帧再断 TCP。 */
    void wsClose(String why) {
        synchronized (lifecycleLock) {
            if (wsClosed) return;
            wsClosed = true;
        }
        TunnelWs w = ws;
        if (w != null) {
            try {
                w.abort();
            } catch (Throwable ignored) {
            }
        }
    }
}
