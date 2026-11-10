package com.myco.phone;

import java.io.IOException;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * TunnelProxyServer — **本地端口代理的监听面**（"点卡就进"的第 ② 步）。
 *
 * 为什么必须有它：WebView 里的 JS **不能监听 TCP 端口**，而"点卡就进"要求把
 * `http://127.0.0.1:<本地端口>/gw/<id>/?mt=…` 交给 WebView 打开——那个端口只能
 * 由原生 `ServerSocket` 提供。Service Worker 也救不了：它拦不住 WebSocket
 * （DSH 的 `/api/remote.mux` 是 WS）。
 *
 * 数据流（**原生搬字节，JS 管协议**）：
 * ```
 *   浏览器 TCP ─▶ 本类 accept ─ onData(connId,b64) ─▶ JS：seal → 隧道 WS → PC
 *   浏览器 TCP ◀─ write(connId) ◀─ JS：open ◀─ 隧道 WS ◀─ PC
 * ```
 * 语义与 PC 端 `p2p_tunnel.rs` 对齐：**一条本地连接 = 一条到目标端口的隧道**。
 *
 * 2026-10-09 反向连接：监听改绑 `[::]`（Android/Linux 双栈，v4-mapped 同 socket 收）
 * ——同一个端口既服务**本机浏览器**（loopback，原路径一字不变），也接受 **PC 主动
 * 拨来的反向隧道**（非 loopback 入站，首行必须是 `GET /p2p/tunnel`，否则立刻关，
 * 防止暴露口被扫描器当跳板；JS 侧还有验签 + 预期源设备 + 端口白名单 + nonce 四道闸，
 * 见 `p2p-tunnel.ts: acceptTunnel`）。本机全球 IPv6 经 `snapshot()` 暴露给 JS
 * （`ipv6=[a|b|…]`，JS 解析后随 presence 上报——PC 侧据此反向拨号）。
 */
public class TunnelProxyServer {
    /** 单次从浏览器读的上限（16KB，与 PC 端 TUNNEL_CHUNK 同量级）。 */
    private static final int CHUNK = 16 * 1024;
    /**
     * 2026-10-18 晚：**原生 JS 桥冻结看门狗**（后台放久后 WebView 渲染进程被系统
     * 限流/回收，`js.onData` 排进 WebView 后 JS 永远不处理 → 中继侧"接单泵起"但
     * 一条字节都不回，PC 只能吃满 3-6s 预算再重试，P95 直接爆）。
     *
     * 判据：连接已识别为隧道握手（首段以 `GET /p2p/tunnel` 开头）→ 起算；
     * 2.5s 内 JS 没有回写过任何字节 → 判定桥冻结，原生直接关连接（PC 快速失败，
     * 消息落 offline_queue 等补发；手机恢复后再推/对账）。正常隧道则在首个回执
     * 后解除定时器，不影响长连接空闲。
     */
    private static final int JS_ACK_GRACE_MS = 2500;

    private final TunnelJs js;
    private final ConcurrentHashMap<Integer, TunnelProxyConn> conns = new ConcurrentHashMap<Integer, TunnelProxyConn>();
    private final AtomicInteger seq = new AtomicInteger(0);
    private ServerSocket server;
    private volatile boolean running = false;
    private volatile int port = 0;

    public TunnelProxyServer(TunnelJs js) { this.js = js; }

    public int port() { return port; }
    public int liveConns() { return conns.size(); }

    /**
     * 起监听（幂等）。返回本地端口。
     * 绑 `[::]`（双栈）：loopback 走浏览器（原路径），外部地址接受 PC 反向拨入
     * （acceptLoop 里按来源分流 + 协议首行闸）。
     * 失败抛 IOException（消息给人看，不吐术语）。
     *
     * 2026-10-12 端口持久化（对齐 PC 端 p2p_tunnel 的 port_memo）：已开的分享页
     * URL 绑在**本地口**上（`127.0.0.1:39739/gw/…`），app 重启后原随机口换号 →
     * 旧页面刷新/reload 一律 ERR_CONNECTION_REFUSED（笔记本同款病灶，手机实测
     * 39739 恒定只是因为进程没重启）。现在优先复用上次的口（落盘记忆），被占用
     * （随机端口冲突概率低）才回落随机并记新口——重启后旧页面刷新即恢复。
     */
    public synchronized int start() throws IOException {
        if (running && server != null && !server.isClosed()) return port;
        ServerSocket ss = bindPreferred();
        this.server = ss;
        this.port = ss.getLocalPort();
        this.running = true;
        savePortMemo(this.port);
        Thread t = new Thread(new TunnelAccept(this), "myco-tunnel-listen");
        t.setDaemon(true);
        t.start();
        js.onStart(port);
        return port;
    }

    /** 端口记忆文件（getExternalFilesDir/tunnel-port.txt；无线程 Context 时静默跳过）。 */
    private java.io.File portMemoFile() {
        try {
            android.content.Context c = TunnelProxyService.appContext();
            if (c == null) return null;
            java.io.File d = c.getExternalFilesDir(null);
            return d == null ? null : new java.io.File(d, "tunnel-port.txt");
        } catch (Exception e) {
            return null;
        }
    }

    private int loadPortMemo() {
        try {
            java.io.File f = portMemoFile();
            if (f == null || !f.isFile()) return 0;
            java.io.BufferedReader r = new java.io.BufferedReader(new java.io.FileReader(f));
            String s = r.readLine();
            r.close();
            return s == null ? 0 : Integer.parseInt(s.trim());
        } catch (Exception e) {
            return 0;
        }
    }

    private void savePortMemo(int p) {
        try {
            java.io.File f = portMemoFile();
            if (f == null) return;
            java.io.FileWriter w = new java.io.FileWriter(f, false);
            w.write(String.valueOf(p));
            w.close();
        } catch (Exception ignored) {
        }
    }

    private ServerSocket bindPreferred() throws IOException {
        int prefer = loadPortMemo();
        if (prefer > 0) {
            // 2026-10-12：app 刚重启时旧进程的口可能尚未释放（force-stop→秒起）
            // ——重试 5×300ms 再认输，别让"复用同口"败在一次瞬时占用上。
            for (int i = 0; i < 5; i++) {
                try {
                    return new ServerSocket(prefer, 32, java.net.InetAddress.getByName("::"));
                } catch (IOException busy) {
                    if (i == 4) {
                        GwLog.note(null, "tunnel-port 记忆口 " + prefer + " 被占用（重试 5 次），回落随机口（旧页面链接将失效）");
                    } else {
                        try { Thread.sleep(300); } catch (InterruptedException ie) { break; }
                    }
                }
            }
        }
        return new ServerSocket(0, 32, java.net.InetAddress.getByName("::"));
    }

    /** 停监听 + 关掉所有在途连接（幂等）。 */
    public synchronized void stop() {
        running = false;
        if (server != null) {
            try { server.close(); } catch (Exception ignored) { }
            server = null;
        }
        for (Integer id : new java.util.ArrayList<Integer>(conns.keySet())) {
            TunnelProxyConn c = conns.remove(id);
            if (c != null) {
                c.close();
                js.onClose(id.intValue(), "proxy-stopped");
            }
        }
        port = 0;
    }

    public boolean isRunning() { return running; }

    /** JS → 原生：把明文写回浏览器那条 TCP。 */
    public void write(int connId, byte[] data) {
        TunnelProxyConn c = conns.get(Integer.valueOf(connId));
        if (c != null) c.write(data);
    }

    /** JS → 原生：关掉浏览器那条 TCP（隧道断了/协议错）。 */
    public void closeConn(int connId, String why) {
        TunnelProxyConn c = conns.remove(Integer.valueOf(connId));
        if (c != null) {
            c.close();
            js.onClose(connId, why);
        }
    }

    // ── accept 循环（顶层 Runnable 入口）──

    void acceptLoop() {
        while (running) {
            Socket s;
            try {
                s = server.accept();
            } catch (IOException e) {
                break; // stop() 关了 server
            }
            boolean loopback = s.getInetAddress() != null && s.getInetAddress().isLoopbackAddress();
            // 2026-10-10 热点子网桥接：笔记本等设备经手机热点（同一私有子网）连过来
            // → 按浏览器连接处理（走桥的反向池路由到 PC）。私有地址 = 本地设备
            // （热点客户端/LAN），不会是互联网扫描器（那些是公网地址）。
            boolean privateSubnet = s.getInetAddress() != null && s.getInetAddress().isSiteLocalAddress();
            final int id = seq.incrementAndGet();
            try {
                if (!loopback && !privateSubnet) {
                    // 非内网入站 = 潜在的反向隧道连接（PC 主动拨来）。
                    // 原生侧第一道闸：只放行打向隧道端点的 HTTP 请求（GET /p2p/tunnel…），
                    // 其它（扫描器/乱协议）立刻关——真正的验签/设备/端口/nonce 闸在 JS
                    // （acceptTunnel）。peek 出来的字节原样作为首段 onData 补投（不丢字节）。
                    byte[] first = peekHead(s);
                    if (first == null || !startsWithTunnelGet(first)) {
                        try { s.close(); } catch (Exception ignored) { }
                        continue;
                    }
                    TunnelProxyConn c = new TunnelProxyConn(id, s);
                    conns.put(Integer.valueOf(id), c);
                    Thread t = new Thread(new TunnelConnRead(this, c), "myco-tunnel-c" + id);
                    t.setDaemon(true);
                    t.start();
                    js.onConn(id);
                    if (first.length > 0) {
                        // 已识别为隧道握手：起 JS 桥冻结看门狗（读线程据此超时判定）
                        c.armTunnel(System.currentTimeMillis());
                        try { s.setSoTimeout(JS_ACK_GRACE_MS); } catch (Exception ignored) { }
                        js.onData(id, first);
                    }
                } else {
                    // loopback 或热点/LAN 子网 → 按浏览器连接处理（走桥）
                    TunnelProxyConn c = new TunnelProxyConn(id, s);
                    conns.put(Integer.valueOf(id), c);
                    Thread t = new Thread(new TunnelConnRead(this, c), "myco-tunnel-c" + id);
                    t.setDaemon(true);
                    t.start();
                    js.onConn(id);
                }
            } catch (IOException e) {
                try { s.close(); } catch (Exception ignored) { }
            }
        }
    }

    /** 首行是否以 `GET /p2p/tunnel` 开头（ASCII 前缀比对，越界安全）。 */
    private static boolean startsWithTunnelGet(byte[] b) {
        String want = "GET /p2p/tunnel";
        if (b.length < want.length()) return false;
        for (int i = 0; i < want.length(); i++) {
            if (b[i] != (byte) want.charAt(i)) return false;
        }
        return true;
    }

    /**
     * 读到请求头完（`\r\n\r\n`）或上限/超时为止，返回读到的全部字节。
     * null = 没等到完整头（超时 3s / 连接断）——调用方关连接。
     * 逐字节读是为了不越过头边界（头部就几百字节，一次性成本可忽略）。
     */
    private static byte[] peekHead(Socket s) {
        try {
            s.setSoTimeout(3000);
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream(256);
            int complete = 0; // 连续匹配 \r\n\r\n 的进度
            while (buf.size() < 8192) {
                int b = s.getInputStream().read();
                if (b < 0) break;
                buf.write(b);
                if ((complete == 0 && b == '\r') || (complete == 1 && b == '\n')
                        || (complete == 2 && b == '\r') || (complete == 3 && b == '\n')) {
                    complete++;
                    if (complete == 4) break;
                } else if (b == '\r') {
                    complete = 1;
                } else {
                    complete = 0;
                }
            }
            s.setSoTimeout(0);
            return complete == 4 ? buf.toByteArray() : (buf.size() > 0 ? buf.toByteArray() : null);
        } catch (Exception e) {
            return null;
        }
    }

    /** 单条连接：读浏览器字节 → 投给 JS（顶层 Runnable 入口）。 */
    void readLoop(TunnelProxyConn c) {
        byte[] buf = new byte[CHUNK];
        try {
            java.io.InputStream in = c.sock.getInputStream();
            while (running && !c.isClosed()) {
                int n;
                try {
                    n = in.read(buf);
                } catch (java.net.SocketTimeoutException te) {
                    // 2026-10-18 晚 看门狗：隧道握手已到但 JS 桥 2.5s 没回一个字节
                    // → 判定 WebView 桥冻结，关连接让 PC 快速失败（别吃满 3-6s 预算）。
                    if (c.tunnelArmed() && !c.jsWrote()
                            && System.currentTimeMillis() - c.tunnelAt() >= JS_ACK_GRACE_MS) {
                        GwLog.note(null, "tunnel-js-frozen 看门狗：隧道握手 " + JS_ACK_GRACE_MS
                                + "ms 无 JS 回写，关连接（conn=" + c.id + "）");
                        break;
                    }
                    // 正常长连接（已回执/非隧道）：恢复无限等待继续跑
                    try { c.sock.setSoTimeout(0); } catch (Exception ignored) { }
                    continue;
                }
                if (n < 0) break;
                if (n == 0) continue;
                byte[] chunk = new byte[n];
                System.arraycopy(buf, 0, chunk, 0, n);
                if (!c.tunnelArmed() && startsWithTunnelGet(chunk)) {
                    // relay provider 泵进来的隧道握手是 loopback 连接（走浏览器分支），
                    // 这里按首字节识别并装上同一套看门狗。
                    c.armTunnel(System.currentTimeMillis());
                    try { c.sock.setSoTimeout(JS_ACK_GRACE_MS); } catch (Exception ignored) { }
                }
                js.onData(c.id, chunk);
                if (c.jsWrote()) {
                    // 桥已回写（101/错误响应/帧）：解除定时器，进入正常长连接
                    try { c.sock.setSoTimeout(0); } catch (Exception ignored) { }
                }
            }
        } catch (IOException ignored) {
            // 浏览器侧断开属正常
        } finally {
            boolean removed = conns.remove(Integer.valueOf(c.id)) != null;
            c.close();
            if (removed) js.onClose(c.id, "本地连接已关");
        }
    }

    /** 诊断：给 EnvServer/日志用的一行摘要。
     *  2026-10-09：追加 `ipv6=[a|b|…]`（本机全球 IPv6，`|` 分隔）——JS 从
     *  `MycoShell.tunnelState()` 解析后随 presence 上报，PC 侧据此反向拨号。 */
    public String snapshot() {
        return "proxy port=" + port + " running=" + running + " conns=" + conns.size()
                + " ipv6=[" + joinGlobalIpv6() + "]";
    }

    /** 本机全部全球 IPv6（去 zone 后缀、去重保序；`|` 连接）。 */
    private static String joinGlobalIpv6() {
        StringBuilder sb = new StringBuilder();
        try {
            java.util.Enumeration<java.net.NetworkInterface> ns = java.net.NetworkInterface.getNetworkInterfaces();
            java.util.LinkedHashSet<String> seen = new java.util.LinkedHashSet<String>();
            while (ns != null && ns.hasMoreElements()) {
                java.net.NetworkInterface n = ns.nextElement();
                if (!n.isUp() || n.isLoopback()) continue;
                java.util.Enumeration<java.net.InetAddress> as = n.getInetAddresses();
                while (as.hasMoreElements()) {
                    java.net.InetAddress a = as.nextElement();
                    if (!(a instanceof java.net.Inet6Address)) continue;
                    if (a.isLinkLocalAddress() || a.isAnyLocalAddress() || a.isLoopbackAddress()) continue;
                    String h = a.getHostAddress();
                    int z = h.indexOf('%');
                    if (z >= 0) h = h.substring(0, z);
                    if (h.contains(":")) seen.add(h);
                }
            }
            for (String h : seen) {
                if (sb.length() > 0) sb.append('|');
                sb.append(h);
            }
        } catch (Exception ignored) {
            // 无权限/无接口：上报不了 IPv6（反向连接不可用，直连路径不受影响）
        }
        return sb.toString();
    }
}
