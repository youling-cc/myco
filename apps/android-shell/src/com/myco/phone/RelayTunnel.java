package com.myco.phone;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.ArrayList;

/**
 * RelayTunnel — 云端中继 consumer 侧（手机端，2026-10-11）。
 *
 * 对齐 PC 端 apps/home/src-tauri/src/cloud_relay.rs（预连池）与 p2p_tunnel.rs 的
 * relay_connect/relay_leg；协议权威来源 services/identity-svc/relay.mjs。
 *
 * 协议（:8321 与 identity HTTP 同口复用，服务端首行嗅探分流）：
 *   consumer: TCP → "CONNECT &lt;targetDeviceDid&gt;\n" → 等 "OK\n"
 *             → 之后本连接与 provider（目标设备）的接单连接纯字节对接。
 *   应答：OK / NOT_FOUND（目标未注册）/ BUSY（会话满）/ UNAVAILABLE（等 ACCEPT 超时）。
 *
 * 预连池（对齐 cloud_relay.rs 的 PREDIAL）：深 2、条目寿命 8s（服务端嗅探窗 15s
 * 内有效）。**只预拨 TCP、一行协议都不发**：relay 收到 CONNECT 即下发 SESSION、
 * PC 会为它新开一条接单连接——池里囤 CONNECT 等于让 provider 白挂死会话；裸 TCP
 * 对两端零代价（PC 端同款取舍，见 cloud_relay.rs 的注释）。取用后后台补池。
 *
 * 谁在用：TunnelWs.connect 见到 relay:// URL 即调 connect()（先 CONNECT 中继、
 * 再在同一条 TCP 上做 WS 升级）；MycoShell.relayPredial 调 refill() 预热。
 */
public final class RelayTunnel {
    /** 中继默认地址（identity-svc 同口复用——所有能跑 presence 的网络必达）。 */
    public static final String DEFAULT_HOST = "myco.youling.cc";
    public static final int DEFAULT_PORT = 8321;
    /** 预连池深（对齐 cloud_relay.rs PREDIAL_POOL=2）。 */
    private static final int POOL_DEPTH = 2;
    /** 条目寿命 ms（对齐 PREDIAL_TTL_SECS=8；服务端嗅探窗 15s 留余量）。 */
    private static final long POOL_TTL_MS = 8000;
    /** 拨中继 TCP 的超时（对齐 RELAY_DIAL_TIMEOUT）。 */
    private static final int DIAL_TIMEOUT_MS = 3000;
    /** 等中继应答行（OK/NOT_FOUND/…）的超时（对齐 RELAY_LINE_TIMEOUT）。 */
    private static final int LINE_TIMEOUT_MS = 4000;
    /** 应答行最长（命令都是 ASCII 短行）。 */
    private static final int MAX_LINE = 512;

    private static final ArrayList<Predial> POOL = new ArrayList<Predial>();

    private static class Predial {
        final String host;
        final int port;
        final Socket sock;
        final long born;
        Predial(String h, int p, Socket s) { host = h; port = p; sock = s; born = System.currentTimeMillis(); }
    }

    private RelayTunnel() {}

    // ── 地址解析 ──

    /** "host:port"（IPv6 认 [..] 形态）→ {host, port字符串}；空/坏 → 默认。 */
    public static String[] parseAddr(String addr) {
        String host = DEFAULT_HOST;
        int port = DEFAULT_PORT;
        String t = addr == null ? "" : addr.trim();
        if (!t.isEmpty()) {
            if (t.startsWith("[")) {
                int close = t.indexOf(']');
                if (close > 1) {
                    host = t.substring(1, close);
                    if (close + 1 < t.length() && t.charAt(close + 1) == ':') {
                        try { port = Integer.parseInt(t.substring(close + 2)); } catch (Exception ignored) { }
                    }
                }
            } else {
                int colon = t.lastIndexOf(':');
                if (colon > 0 && isDigits(t.substring(colon + 1))) {
                    host = t.substring(0, colon);
                    try { port = Integer.parseInt(t.substring(colon + 1)); } catch (Exception ignored) { }
                } else {
                    host = t;
                }
            }
        }
        return new String[] { host, String.valueOf(port) };
    }

    private static boolean isDigits(String s) {
        if (s == null || s.isEmpty()) return false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < '0' || c > '9') return false;
        }
        return true;
    }

    // ── 预连池（深 2 / TTL 8s；只拨 TCP 不上协议） ──

    /** 池里新鲜条目数（诊断快照用）。 */
    public static synchronized int poolAlive() {
        dropStale(System.currentTimeMillis());
        return POOL.size();
    }

    /** 池深（诊断快照用）。 */
    public static int poolDepth() { return POOL_DEPTH; }

    /** 顺手清过期条目（调用方持锁）。 */
    private static void dropStale(long now) {
        for (int i = POOL.size() - 1; i >= 0; i--) {
            Predial p = POOL.get(i);
            if (now - p.born >= POOL_TTL_MS) {
                POOL.remove(i);
                closeQuietly(p.sock);
            }
        }
    }

    /** 取一条新鲜预连（最新鲜先出）。池空 → null（调用方现拨，行为不变）。 */
    private static synchronized Socket take(String host, int port) {
        dropStale(System.currentTimeMillis());
        for (int i = POOL.size() - 1; i >= 0; i--) {
            Predial p = POOL.get(i);
            if (p.host.equals(host) && p.port == port) {
                POOL.remove(i);
                return p.sock;
            }
        }
        return null;
    }

    /** 后台补池到水位（非阻塞；失败静默——预连是纯优化，真用腿时现拨照常）。 */
    public static void refill(final String host, final int port) {
        int need;
        synchronized (POOL) {
            long now = System.currentTimeMillis();
            for (int i = POOL.size() - 1; i >= 0; i--) {
                Predial p = POOL.get(i);
                if (!(p.host.equals(host) && p.port == port) || now - p.born >= POOL_TTL_MS) {
                    POOL.remove(i);
                    closeQuietly(p.sock);
                }
            }
            need = POOL_DEPTH - POOL.size();
        }
        for (int i = 0; i < need; i++) {
            Thread t = new Thread(new Runnable() {
                @Override public void run() { dialIntoPool(host, port); }
            }, "myco-relay-predial");
            t.setDaemon(true);
            t.start();
        }
    }

    /** 拨一条裸 TCP 进池（一行协议都不发）；池满/失败即放手。 */
    private static void dialIntoPool(String host, int port) {
        try {
            Socket s = dial(host, port);
            synchronized (POOL) {
                dropStale(System.currentTimeMillis());
                if (POOL.size() < POOL_DEPTH) {
                    POOL.add(new Predial(host, port, s));
                    return;
                }
            }
            closeQuietly(s); // 并发补池赢了——放手，连接 close 即关
        } catch (Exception ignored) { }
    }

    private static Socket dial(String host, int port) throws IOException {
        Socket s = new Socket();
        s.setTcpNoDelay(true);
        s.connect(new InetSocketAddress(host, port), DIAL_TIMEOUT_MS);
        return s;
    }

    // ── consumer 连接（CONNECT → OK） ──

    /**
     * consumer 连中继：TCP（优先预连池）→ CONNECT &lt;did&gt; → 等 OK。
     * 返回的 socket 已与 provider（目标设备）配对成纯字节管道（调用方直接在其上
     * 做 /p2p/tunnel 的 WS 升级）。用后随手补池。
     */
    public static Socket connect(String host, int port, String targetDid) throws IOException {
        Socket s = take(host, port);
        if (s == null) {
            s = dial(host, port);
        }
        refill(host, port); // 用后随手补（下一条中继腿继续吃现成的）
        boolean ok = false;
        try {
            GwLog.note(null, "relay-consumer CONNECT begin target=" + targetDid.substring(Math.max(0, targetDid.length() - 4)));
            OutputStream os = s.getOutputStream();
            InputStream is = s.getInputStream();
            os.write(("CONNECT " + targetDid + "\n").getBytes("UTF-8"));
            os.flush();
            s.setSoTimeout(LINE_TIMEOUT_MS);
            String line = readLine(is);
            GwLog.note(null, "relay-consumer CONNECT response=" + line);
            s.setSoTimeout(0);
            if (!line.equals("OK")) {
                if (line.equals("NOT_FOUND")) throw new IOException("对方设备不在线（云端中转无此设备）");
                if (line.equals("BUSY")) throw new IOException("对方设备的云端通道忙，稍后再试");
                if (line.equals("UNAVAILABLE")) throw new IOException("对方设备没接上云端通道，稍后再试");
                throw new IOException("云端中转响应异常");
            }
            ok = true;
            return s;
        } finally {
            if (!ok) closeQuietly(s);
        }
    }

    /** 读一行（字节级——绝不消费 '\n' 之后的数据；应答都是 ASCII 短行）。 */
    private static String readLine(InputStream is) throws IOException {
        StringBuilder sb = new StringBuilder();
        while (true) {
            int b = is.read();
            if (b < 0) throw new IOException("云端中转连接提前关闭");
            if (b == '\n') return sb.toString().trim();
            sb.append((char) b);
            if (sb.length() > MAX_LINE) throw new IOException("云端中转应答异常");
        }
    }

    private static void closeQuietly(Socket s) {
        try { if (s != null) s.close(); } catch (Exception ignored) { }
    }
}
