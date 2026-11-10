package com.myco.phone;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * TcpDialer —— 手机入向 vnet 隧道用：把隧道解出的明文帧泵到 `127.0.0.1:<port>`。
 *
 * 为什么需要它（2026-10-22 定位）：手机侧已有隧道**服务端**（`acceptTunnel`：WS 服务端帧层
 * + v2 AEAD 握手），但把会话接到"任意本地端口"这一步做不了——**WebView 里的 JS 开不了
 * TCP socket**。所以由原生壳拨号，读侧线程把字节经 `TunnelJs` 回调给 JS。
 *
 * 安全：端口白名单与 JS 侧 `TUNNEL_DEFAULT_PORTS` 对齐（22/3389/5555/9000/9100/13911），
 * 只连 127.0.0.1（不出本机）；准入（设备签名/账号归属）由 JS 侧 `acceptTunnel` 闸门负责。
 *
 * 线程：桥方法在 JavaBridge 线程调；`Reader` 是顶层类（本仓 d8 8.2.2-dev 对匿名/内嵌类
 * 会 NPE，见 TunnelJsRun 注释），读循环用自己的线程。
 */
public class TcpDialer {
    /** 与 JS 侧 TUNNEL_DEFAULT_PORTS 一致（改一处要同步另一处）。 */
    private static final int[] ALLOWED = {22, 3389, 5555, 9000, 9100, 13911};

    private final TunnelJs js;
    private final ConcurrentHashMap<Integer, Socket> socks = new ConcurrentHashMap<Integer, Socket>();
    private final AtomicInteger seq = new AtomicInteger(1);

    public TcpDialer(TunnelJs js) { this.js = js; }

    private static boolean allowed(int port) {
        for (int p : ALLOWED) if (p == port) return true;
        return false;
    }

    /** `tcpDial(port)` → `{"ok":true,"connId":N}` / `{"ok":false,"err":"…"}`。 */
    public String dial(int port) {
        if (!allowed(port)) return "{\"ok\":false,\"err\":\"port not allowed: " + port + "\"}";
        Socket s = new Socket();
        try {
            // 2026-10-22 真机：手机 adbd 只监听 `[::]:5555`（IPv6 any），若 bindv6only=1
            // 则连 127.0.0.1 会被拒。先试 IPv4 回环，失败再试 IPv6 回环（::1）。
            try {
                s.connect(new InetSocketAddress("127.0.0.1", port), 3000);
            } catch (Exception v4fail) {
                try { s.close(); } catch (Exception ignored) { }
                s = new Socket();
                s.connect(new InetSocketAddress("::1", port), 3000);
            }
            s.setTcpNoDelay(true);
            int id = seq.getAndIncrement();
            socks.put(id, s);
            new Thread(new Reader(this, js, id, s)).start();
            GwLog.note(TunnelProxyService.appContext(), "tcp-dial 127.0.0.1:" + port + " connId=" + id);
            return "{\"ok\":true,\"connId\":" + id + "}";
        } catch (Exception e) {
            try { s.close(); } catch (Exception ignored) { }
            return "{\"ok\":false,\"err\":" + TunnelJs.jsStr(String.valueOf(e.getMessage())) + "}";
        }
    }

    /** 隧道明文 → 本地 socket。 */
    public void send(int id, String b64) {
        Socket s = socks.get(id);
        if (s == null) return;
        try {
            OutputStream out = s.getOutputStream();
            out.write(android.util.Base64.decode(b64, android.util.Base64.NO_WRAP));
            out.flush();
        } catch (Exception e) {
            close(id);
        }
    }

    /** 关本地 socket（隧道断/对端关）。 */
    public void close(int id) {
        Socket s = socks.remove(id);
        if (s != null) {
            try { s.close(); } catch (Exception ignored) { }
        }
    }

    /** 读侧：本地 socket → `window.__mycoTcpData(id, b64)`。 */
    static class Reader implements Runnable {
        private final TcpDialer owner;
        private final TunnelJs js;
        private final int id;
        private final Socket s;

        Reader(TcpDialer o, TunnelJs j, int i, Socket so) { owner = o; js = j; id = i; s = so; }

        public void run() {
            byte[] buf = new byte[16384];
            try {
                InputStream in = s.getInputStream();
                int n;
                while ((n = in.read(buf)) > 0) {
                    byte[] chunk = new byte[n];
                    System.arraycopy(buf, 0, chunk, 0, n);
                    js.onTcpData(id, chunk);
                }
            } catch (Exception ignored) {
                // 对端关/本地关都走这里
            }
            owner.close(id);
            js.onTcpClosed(id);
        }
    }
}
