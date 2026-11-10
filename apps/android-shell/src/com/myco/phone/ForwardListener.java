package com.myco.phone;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * ForwardListener — 手机端 **vnet 固定端口转发**的监听面（2026-10-22）。
 *
 * 与 {@link TunnelProxyServer} 的分工完全相同（**原生搬字节，JS 管协议**），区别只有两点：
 *  ① 一个固定本地口 = 一个实例（可多开），端口**用户指定**（bind 失败重试 5×300ms，
 *     绝不静默换口——保证"配置里的 127.0.0.1:<端口>"长期不变）；
 *  ② 事件走独立 JS 命名空间 `window.__mycoFwd`（不打扰分享页那条单例通道）。
 *
 * 数据流：
 * ```
 *   本机 RDP/SSH 客户端 ─▶ 127.0.0.1:<固定口> ─▶ 本类 accept ─ onConn/onData ─▶ JS
 *   JS 开隧道（手机作发起方 → PC 侧 dial 目标端口）→ 回写 ─▶ onData 反方向
 * ```
 *
 * 安全：只绑 `127.0.0.1`（不对 LAN 暴露），仅本机应用/浏览器可连。
 */
public class ForwardListener {
    /** JS 侧回调面（由 MainActivity 实现 → evaluateJavascript 到 window.__mycoFwd）。 */
    public interface Sink {
        void onConn(int localPort, int connId);

        void onData(int localPort, int connId, byte[] data);

        void onClosed(int localPort, int connId, String why);

        void onError(int localPort, String msg);
    }

    private static final Map<Integer, ForwardListener> ALL = new ConcurrentHashMap<Integer, ForwardListener>();
    private static volatile Sink sink;
    /** 2026-10-26 P0 修复：connId 全局唯一（跨端口/跨重建都不复用）。 */
    private static final AtomicInteger GLOBAL_SEQ = new AtomicInteger(1);

    private final int localPort;
    private final Map<Integer, Socket> conns = new ConcurrentHashMap<Integer, Socket>();
    private volatile ServerSocket server;
    private volatile boolean running;
    /** accept 线程存活心跳（循环入口 true / finally false）——僵尸监听自愈的判据。 */
    volatile boolean loopAlive;

    private ForwardListener(int localPort) {
        this.localPort = localPort;
    }

    public static void setSink(Sink s) {
        sink = s;
    }

    /** 开一个固定口监听（幂等：已在跑直接返回 ok）。返回 JSON。 */
    public static synchronized String start(int localPort) {
        if (localPort <= 0 || localPort > 65535) return "{\"ok\":false,\"err\":\"端口非法\"}";
        ForwardListener l = ALL.get(localPort);
        if (l != null && l.running) {
            // 2026-10-23 真机（0.3.158 RDP/DSH 全灭）：accept 线程可能早已静默死亡，
            // 但 running 仍 true——TCP 层内核 backlog 照样完成握手（"能连"），应用层
            // 却永不 accept（"无任何数据回"）。自愈：accept 线程不在了就关旧重建。
            if (l.loopAlive) return "{\"ok\":true,\"port\":" + localPort + ",\"already\":true}";
            GwLog.note(null, "vnet-forward 僵尸监听重建 :" + localPort + "（accept 线程已死）");
            ALL.remove(localPort);
            l.shutdown("zombie-rebind");
            l = null;
        }
        ForwardListener fresh = new ForwardListener(localPort);
        String err = fresh.bind();
        if (err != null) return "{\"ok\":false,\"err\":\"" + esc(err) + "\"}";
        ALL.put(localPort, fresh);
        return "{\"ok\":true,\"port\":" + localPort + "}";
    }

    /** 关监听 + 断全部连接（幂等）。 */
    public static synchronized void stop(int localPort) {
        ForwardListener l = ALL.remove(localPort);
        if (l != null) l.shutdown("stopped");
    }

    public static synchronized void stopAll() {
        for (ForwardListener l : ALL.values()) l.shutdown("app-stop");
        ALL.clear();
    }

    /** 当前监听列表 JSON：`{"ok":true,"forwards":[{"port":23389,"alive":true,...},...]}` */
    public static String list() {
        StringBuilder sb = new StringBuilder("{\"ok\":true,\"forwards\":[");
        boolean first = true;
        for (Integer p : ALL.keySet()) {
            ForwardListener l = ALL.get(p);
            if (l == null || !l.running) continue;
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"port\":").append(p)
              .append(",\"alive\":").append(l.loopAlive)
              .append(",\"conns\":").append(l.conns.size()).append('}');
        }
        return sb.append("]}").toString();
    }

    /** JS → 本地 socket 写字节。 */
    public static void send(int localPort, int connId, byte[] data) {
        ForwardListener l = ALL.get(localPort);
        if (l == null) return;
        l.write(connId, data);
    }

    /** JS 主动关一条连接。 */
    public static void close(int localPort, int connId, String why) {
        ForwardListener l = ALL.get(localPort);
        if (l == null) return;
        l.drop(connId, why == null ? "js-close" : why);
    }

    // ────────────────── 实例实现 ──────────────────

    private String bind() {
        // 用户指定口：重试 5×300ms（旧进程刚退时端口可能瞬时占用），失败就报错、
        // 不回落随机口——"固定口"承诺优先于"先起来再说"。
        String last = null;
        for (int i = 0; i < 5; i++) {
            try {
                server = new ServerSocket(localPort, 16, InetAddress.getByName("127.0.0.1"));
                running = true;
                Thread t = new Thread(new Acceptor(this), "myco-fwd-listen-" + localPort);
                t.setDaemon(true);
                t.start();
                GwLog.note(null, "vnet-forward 监听 127.0.0.1:" + localPort);
                return null;
            } catch (Exception e) {
                last = e.toString();
                try {
                    Thread.sleep(300);
                } catch (InterruptedException ie) {
                    break;
                }
            }
        }
        if (sink != null) sink.onError(localPort, "bind failed: " + last);
        GwLog.note(null, "vnet-forward 端口 " + localPort + " 绑定失败: " + last);
        return "端口 " + localPort + " 绑定失败：" + last;
    }

    /** 接受循环（顶层 Runnable 类见下；R8 对内嵌类会炸——用静态顶层类）。
     * 2026-10-23 加固：旧实现任何一处异常（accept 偶发 IOException、onConn 派发抛错、
     * 起读线程失败）都会让循环 break 且零日志——真机表现为"TCP 能连但无任何数据回"，
     * 且 state() 仍报 running（僵尸监听）。现在：全部异常就地隔离+落 GwLog，accept
     * 异常退避重试（绝不让单次异常杀死监听），循环退出必留痕。 */
    void acceptLoop() {
        loopAlive = true;
        ServerSocket ss = server;
        GwLog.note(null, "vnet-forward accept-loop 起跑 :" + localPort);
        try {
            while (running && ss != null && !ss.isClosed()) {
                Socket s;
                try {
                    s = ss.accept();
                } catch (Exception e) {
                    if (!running || ss == null || ss.isClosed()) break; // 正常 stop
                    GwLog.note(null, "vnet-forward accept 异常 :" + localPort + " " + e);
                    try { Thread.sleep(500); } catch (InterruptedException ie) { break; }
                    continue;
                }
                final int connId = GLOBAL_SEQ.getAndIncrement();
                conns.put(connId, s);
                GwLog.note(null, "vnet-forward conn accept :" + localPort + "/" + connId);
                // 2026-10-26 RDP 原生数据面：23389（已 arm）由 NativeRdpTunnel 接管——
                // 协议栈（X25519/AES-GCM/帧序号）在 Java，不派 onConn 给 JS（冻结免疫）。
                // 其他端口原样走 JS 路径，行为不变。
                try {
                    if (NativeRdpTunnel.take(localPort, connId, s)) {
                        // 原生接管：本地读线程照常起（字节经 onRead → NativeRdpTunnel）
                    } else {
                        Sink k = sink;
                        if (k != null) k.onConn(localPort, connId);
                    }
                } catch (Throwable t) {
                    GwLog.note(null, "vnet-forward onConn 派发异常 :" + localPort + "/" + connId + " " + t);
                }
                try {
                    Thread rt = new Thread(new Reader(this, s, connId), "myco-fwd-read-" + localPort + "-" + connId);
                    rt.setDaemon(true);
                    rt.start();
                } catch (Throwable t) {
                    GwLog.note(null, "vnet-forward 读线程启动异常 :" + localPort + "/" + connId + " " + t);
                }
            }
        } catch (Throwable t) {
            GwLog.note(null, "vnet-forward accept-loop 意外退出 :" + localPort + " " + t);
        } finally {
            loopAlive = false;
            GwLog.note(null, "vnet-forward accept-loop 退出 :" + localPort + " running=" + running);
        }
    }

    void onRead(int connId, byte[] data) {
        // 2026-10-26 RDP 原生数据面：原生接管的连接，字节直接进 Java 加密泵（不过 JS）。
        // 判据只看连接注册表（不看 armed）——disarm 瞬间在途连接仍走原生收尾，不串台。
        if (NativeRdpTunnel.peekNative(localPort, connId)) {
            NativeRdpTunnel.onLocalData(localPort, connId, data);
            return;
        }
        Sink k = sink;
        if (k != null) k.onData(localPort, connId, data);
    }

    void onEof(int connId, String why) {
        drop(connId, why);
    }

    private void write(int connId, byte[] data) {
        Socket s = conns.get(connId);
        if (s == null) return;
        try {
            OutputStream os = s.getOutputStream();
            os.write(data);
            os.flush();
        } catch (Exception e) {
            drop(connId, "write-fail");
        }
    }

    private void drop(int connId, String why) {
        // 2026-10-26 RDP 原生数据面：本地连接关闭时通知原生侧收尾 WS（幂等）。
        boolean nativeOwned = NativeRdpTunnel.peekNative(localPort, connId);
        if (nativeOwned) {
            try {
                NativeRdpTunnel.onLocalGone(localPort, connId, why);
            } catch (Throwable ignored) {
            }
        }
        Socket s = conns.remove(connId);
        if (s == null) return;
        try {
            s.close();
        } catch (Exception ignored) {
        }
        if (nativeOwned) return; // 原生连接不再向冻结的 WebView 排无意义 JS 事件
        Sink k = sink;
        if (k != null) k.onClosed(localPort, connId, why);
    }

    private void shutdown(String why) {
        running = false;
        try {
            ServerSocket ss = server;
            if (ss != null) ss.close();
        } catch (Exception ignored) {
        }
        server = null;
        for (Integer id : new java.util.ArrayList<Integer>(conns.keySet())) drop(id, why);
        GwLog.note(null, "vnet-forward 停止 127.0.0.1:" + localPort);
    }

    static String esc(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ");
    }
}

/** 接受循环（顶层类：d8/R8 对内嵌类会 NPE）。 */
class Acceptor implements Runnable {
    private final ForwardListener owner;

    Acceptor(ForwardListener o) {
        this.owner = o;
    }

    @Override
    public void run() {
        owner.acceptLoop();
    }
}

/** 单连接读循环。 */
class Reader implements Runnable {
    private final ForwardListener owner;
    private final java.net.Socket sock;
    private final int connId;

    Reader(ForwardListener o, java.net.Socket s, int id) {
        this.owner = o;
        this.sock = s;
        this.connId = id;
    }

    @Override
    public void run() {
        byte[] buf = new byte[16 * 1024];
        try {
            InputStream is = sock.getInputStream();
            while (true) {
                int n = is.read(buf);
                if (n < 0) break;
                if (n == 0) continue;
                byte[] out = new byte[n];
                System.arraycopy(buf, 0, out, 0, n);
                owner.onRead(connId, out);
            }
            owner.onEof(connId, "eof");
        } catch (Exception e) {
            owner.onEof(connId, "read-fail");
        }
    }
}
