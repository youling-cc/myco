package com.myco.phone;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * NativeRdpDialer — 一条候选腿的拨号 + v2 加密握手（顶层类，d8 纪律）。
 *
 * 一腿一线程，与 JS `raceCandidates` 的并行赛跑同构（vnet 的 relay 腿不让先，
 * 2026-10-25 真机 RED：让先 300ms 时 RDP 前台冻结会把 relay 腿直接抹掉）。
 *
 * 流程（= JS `openTunnel` 的 originator 侧，逐字节同协议）：
 *   ① 组握手信封 + 设备签名（Ed25519，种子来自 arm 注入）
 *   ② TunnelWs.connect（ws:// 直连或 relay:// 中继腿，自带 x-myco-tunnel/x-myco-auth 头）
 *   ③ 发 HELLO(临时 X25519 公钥) → 收 HELLO_ACK(对端公钥) → ECDH+HKDF 派生会话密钥
 *   ④ 收 CONFIRM 验 MAC → 回 CONFIRM（两端对称，无死锁——见 Rust crypto_handshake_server）
 *   ⑤ 握手期多余下行帧（PC 收到 CONFIRM 即拨 3389，RDP 服务可能立刻首发）暂存 early，
 *      由 {@link NativeRdpConn#adopt} 按到达序补泵（seq 最小，必须先处理）
 *
 * 本类实现 {@link TunnelWs.Sink}：握手期帧进自己的 inbox（wait/notify），被 adopt 后
 * 直接转发给 conn 的泵。失败/被取消 → 关自己的 WS，不影响其他腿。
 */
public class NativeRdpDialer implements TunnelWs.Sink, Runnable {

    final NativeRdpConn conn;
    final String url;
    final int index;
    /** 腿短名（日志：直连留 host:port，relay 留 relay@host）。 */
    final String name;

    private TunnelCrypto.KeyPair eph;
    private String handshakeRaw;
    private String authHeader;

    /** 握手期收帧箱（本腿私有；锁内操作）。 */
    private final List<byte[]> inbox = new ArrayList<byte[]>();
    private final Object inboxLock = new Object();
    volatile boolean wsClosed = false;
    private String wsCloseReason = "";

    /** 赛跑裁决后：胜者被 conn 接管（此后帧直接进泵），败者取消。 */
    private volatile boolean adopted = false;
    private volatile boolean cancelled = false;

    volatile boolean done = false;
    volatile String err = "";
    volatile TunnelWs ws;
    volatile TunnelFrameIo io;
    /** 握手期到达的多余下行帧（early frames，到达序）。 */
    final List<byte[]> early = new ArrayList<byte[]>();

    NativeRdpDialer(NativeRdpConn conn, String url, int index) {
        this.conn = conn;
        this.url = url;
        this.index = index;
        this.name = shortName(url);
    }

    /** 腿短名（与 JS shortBase 同口径：relay@host / host:port）。 */
    static String shortName(String url) {
        if (url.startsWith("relay://")) {
            int at = url.lastIndexOf('@');
            return "relay@" + (at > 0 ? url.substring(at + 1).split("/")[0] : "?");
        }
        String t = url;
        int p = t.indexOf("://");
        if (p > 0) t = t.substring(p + 3);
        int slash = t.indexOf('/');
        return slash > 0 ? t.substring(0, slash) : t;
    }

    @Override
    public void run() {
        try {
            // 2026-10-26 首连优化：临时钥/签名移到本腿线程，
            // 多候选不再在构造函数里串行付费。
            eph = TunnelCrypto.genEphemeral();
            handshakeRaw = TunnelCrypto.buildTunnelHandshake(
                    conn.cfg.account, conn.cfg.device, conn.cfg.targetPort, TunnelCrypto.nextNonce());
            long ts = System.currentTimeMillis();
            String material = TunnelCrypto.tunnelSignMaterial(conn.cfg.device, ts, handshakeRaw);
            byte[] sig = Ed25519.sign(conn.cfg.seed, TunnelCrypto.utf8(material));
            authHeader = TunnelCrypto.tunnelAuthHeader(conn.cfg.device, ts, TunnelCrypto.b64(sig));

            Map<String, String> headers = new LinkedHashMap<String, String>();
            headers.put("x-myco-tunnel", handshakeRaw);
            headers.put("x-myco-auth", authHeader);
            ws = TunnelWs.connect("rdp" + conn.connId + "-" + index, url, headers, this);
            // ① 发 HELLO（临时公钥）→ 开 reader（对端回帧进 inbox）
            ws.sendBinary(TunnelFrameIo.helloFrame(eph.pub));
            ws.start();
            // ② 收 HELLO_ACK → 对端临时公钥
            byte[] f1 = nextFrame(NativeRdpTunnel.HANDSHAKE_TIMEOUT_MS);
            byte[] peerPub = TunnelFrameIo.parseHello(f1);
            // ③ ECDH + HKDF（originator：ctClient=我方公钥，ctServer=对端公钥）
            TunnelCrypto.SessionKeys keys = TunnelCrypto.deriveWithEcdh(
                    eph.priv, peerPub, eph.pub, peerPub, handshakeRaw);
            io = new TunnelFrameIo(keys, TunnelFrameIo.ROLE_ORIGINATOR, handshakeRaw);
            // ④ 收 CONFIRM 验 MAC → 回 CONFIRM
            io.acceptConfirm(nextFrame(NativeRdpTunnel.HANDSHAKE_TIMEOUT_MS));
            ws.sendBinary(io.confirmFrame());
            // ⑤ 摘出握手期多余下行帧（按到达序，交给 adopt 先泵）
            synchronized (inboxLock) {
                early.addAll(inbox);
                inbox.clear();
            }
            done = true;
        } catch (Throwable t) {
            if (cancelled) {
                // 败者取消：静默收尾
            } else {
                err = t instanceof IOException && t.getMessage() != null ? t.getMessage() : String.valueOf(t);
            }
            done = true;
            closeWs("dial-fail");
        }
    }

    /** 取消（败者/超时）：停止等待、关 WS。 */
    void cancel() {
        cancelled = true;
        closeWs("lost-race");
        synchronized (inboxLock) {
            inboxLock.notifyAll();
        }
    }

    private void closeWs(String why) {
        TunnelWs w = ws;
        if (w != null) {
            try {
                w.abort();
            } catch (Throwable ignored) {
            }
        }
    }

    /** 等下一条握手帧（超时/连接断/被取消 → 抛 IOException）。 */
    private byte[] nextFrame(long timeoutMs) throws IOException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        synchronized (inboxLock) {
            while (true) {
                if (!inbox.isEmpty()) return inbox.remove(0);
                if (cancelled) throw new IOException("已取消");
                if (wsClosed) throw new IOException("握手期间连接断开" + (wsCloseReason.isEmpty() ? "" : "：" + wsCloseReason));
                long left = deadline - System.currentTimeMillis();
                if (left <= 0) throw new IOException("握手超时（" + timeoutMs + "ms）");
                try {
                    inboxLock.wait(Math.min(left, 200L));
                } catch (InterruptedException e) {
                    throw new IOException("等待中断");
                }
            }
        }
    }

    // ══════════════════ TunnelWs.Sink（reader 线程回调） ══════════════════

    @Override
    public void onOpen(TunnelWs w) {
        // connect() 返回即已升级；无需处理
    }

    @Override
    public void onBinary(TunnelWs w, byte[] payload) {
        // 全部帧都过 inboxLock：与 adopt() 的补泵形成全序（到达序），
        // 否则 live 帧可能抢在 early 帧前被泵 → 单调序号检查误判乱序。
        synchronized (inboxLock) {
            if (adopted) {
                conn.pumpFrame(payload);
                return;
            }
            inbox.add(payload);
            inboxLock.notifyAll();
        }
    }

    @Override
    public void onClosed(TunnelWs w, int code, String reason) {
        wsClosed = true;
        wsCloseReason = (reason == null ? "" : reason) + " (" + code + ")";
        synchronized (inboxLock) {
            inboxLock.notifyAll();
        }
        if (adopted) conn.onWsClosed(code, reason);
    }

    /**
     * 胜者被接管：锁内按到达序泵 early + 残余 inbox，然后置 adopted
     * （此后新帧直达 conn 泵——全部过同一把锁，顺序 = 到达序：这些帧 seq 最小且先到）。
     */
    void adopt() {
        synchronized (inboxLock) {
            adopted = true;
            for (byte[] f : early) conn.pumpFrame(f);
            early.clear();
            for (byte[] f : inbox) conn.pumpFrame(f);
            inbox.clear();
        }
    }
}
