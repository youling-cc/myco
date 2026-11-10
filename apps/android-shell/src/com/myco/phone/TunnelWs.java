package com.myco.phone;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.security.SecureRandom;

/**
 * TunnelWs — 一个**极小的 RFC6455 客户端**（只为隧道用，不追求通用）。
 *
 * 为什么不用现成的：
 *   · WebView 的 JS `WebSocket` **不能设自定义请求头**，而隧道握手信封 + 设备签名
 *     必须在 `x-myco-tunnel` / `x-myco-auth` 上（PC 端只读 header）——所以升级握手
 *     只能由原生代做；
 *   · Android 上没有 `java.net.http`（SDK 34/35/36 的 android.jar 里都没有
 *     `java.net.http.WebSocket`，实测 `jar tf` 为空）；引 OkHttp 又要动构建链。
 *   · 本仓 APK 是无 gradle 的手工链（aapt2+javac+d8），**零外部依赖**是硬约束。
 *
 * 职责边界（与 JS 侧 `native-proxy.ts` 的分工）：
 *   **原生只搬字节**（握手 + 掩码 + 分帧 + ping/pong/close），
 *   **协议层（X25519 握手、AEAD 帧、序号）全在 JS**——二进制 payload 原样过桥。
 *
 * 线程模型：一个读线程（reader），发送由任意线程加锁调用（JS bridge 线程）。
 */
public class TunnelWs {
    /** 回调（由 TunnelProxyServer 实现，全部在 reader 线程上被调）。 */
    public interface Sink {
        void onOpen(TunnelWs ws);
        void onBinary(TunnelWs ws, byte[] payload);
        void onClosed(TunnelWs ws, int code, String reason);
    }

    private static final SecureRandom RND = new SecureRandom();
    private static final int MAX_FRAME = 4 * 1024 * 1024;

    public final String id;
    private final Socket sock;
    private final InputStream in;
    private final OutputStream out;
    private final Sink sink;
    private final Object writeLock = new Object();
    private volatile boolean closed = false;
    /** 最近一次写出时刻（keepalive 线程用；写锁内更新）。 */
    private volatile long lastWriteAt = System.currentTimeMillis();

    private TunnelWs(String id, Socket sock, InputStream in, OutputStream out, Sink sink) {
        this.id = id;
        this.sock = sock;
        this.in = in;
        this.out = out;
        this.sink = sink;
    }

    /**
     * 连接并完成 WS 升级。
     *
     * @param url     形如 `ws://192.168.1.82:9100/p2p/tunnel?v=2`；或中继腿伪形态
     *                `relay://<targetDeviceDid>@<host>:<port>/p2p/tunnel?v=2`
     *                （先 TCP→CONNECT 中继→OK，再在同一条 TCP 上升级——见 RelayTunnel）
     * @param headers 额外请求头（`x-myco-tunnel` / `x-myco-auth`）
     * @param sink    回调
     * @return 已升级的连接；失败抛 IOException（消息给人看）
     */
    public static TunnelWs connect(String id, String url, java.util.Map<String, String> headers, Sink sink)
            throws IOException {
        String rest = url;
        boolean tls = false;
        String relayDid = null;
        if (rest.startsWith("relay://")) {
            // 中继腿：relay://<did>@<host>:<port><path>。DID（did:myco:z…）不含 '@'，
            // 取最后一个 '@' 分隔（与 JS 侧 relayWsUrl 的构造口径一致）。
            rest = rest.substring(8);
            int at = rest.lastIndexOf('@');
            if (at <= 0) throw new IOException("中继地址不对");
            relayDid = rest.substring(0, at).trim();
            rest = rest.substring(at + 1);
            if (relayDid.isEmpty()) throw new IOException("中继地址不对");
        } else if (rest.startsWith("ws://")) {
            rest = rest.substring(5);
        } else if (rest.startsWith("wss://")) {
            tls = true;
            rest = rest.substring(6);
        } else {
            throw new IOException("连接地址不对");
        }
        int slash = rest.indexOf('/');
        String hostPort = slash >= 0 ? rest.substring(0, slash) : rest;
        String path = slash >= 0 ? rest.substring(slash) : "/";
        String host;
        int port;
        if (hostPort.startsWith("[")) { // IPv6 字面量
            int close = hostPort.indexOf(']');
            if (close < 0) throw new IOException("连接地址不对");
            host = hostPort.substring(1, close);
            int colon = hostPort.indexOf(':', close);
            port = colon > 0 ? Integer.parseInt(hostPort.substring(colon + 1)) : (tls ? 443 : 80);
        } else {
            int colon = hostPort.lastIndexOf(':');
            if (colon > 0) {
                host = hostPort.substring(0, colon);
                port = Integer.parseInt(hostPort.substring(colon + 1));
            } else {
                host = hostPort;
                port = tls ? 443 : 80;
            }
        }
        if (tls) throw new IOException("暂不支持加密连接（wss）");

        Socket s;
        if (relayDid != null) {
            // 中继腿：TCP（优先预连池）→ CONNECT did → OK ——之后这条 TCP 已与
            // provider（目标设备）纯字节对接，照常在它上面做 WS 升级。
            s = RelayTunnel.connect(host, port, relayDid);
        } else {
            s = new Socket();
            s.setTcpNoDelay(true);
            s.connect(new InetSocketAddress(host, port), 5000);
            s.setSoTimeout(0);
        }
        OutputStream os = s.getOutputStream();
        InputStream is = s.getInputStream();

        byte[] keyBytes = new byte[16];
        RND.nextBytes(keyBytes);
        String key = android.util.Base64.encodeToString(keyBytes, android.util.Base64.NO_WRAP);

        StringBuilder req = new StringBuilder();
        req.append("GET ").append(path).append(" HTTP/1.1\r\n");
        req.append("Host: ").append(hostPort).append("\r\n");
        req.append("Upgrade: websocket\r\n");
        req.append("Connection: Upgrade\r\n");
        req.append("Sec-WebSocket-Key: ").append(key).append("\r\n");
        req.append("Sec-WebSocket-Version: 13\r\n");
        req.append("Origin: http://").append(hostPort).append("\r\n");
        if (headers != null) {
            for (java.util.Map.Entry<String, String> e : headers.entrySet()) {
                if (e.getKey() == null || e.getValue() == null) continue;
                // 头值不能带 CR/LF（注入防线）
                req.append(e.getKey()).append(": ")
                        .append(e.getValue().replace("\r", " ").replace("\n", " ")).append("\r\n");
            }
        }
        req.append("\r\n");
        os.write(req.toString().getBytes("UTF-8"));
        os.flush();

        // 读响应头（到 \r\n\r\n 为止）
        java.io.ByteArrayOutputStream head = new java.io.ByteArrayOutputStream();
        int state = 0;
        long deadline = System.currentTimeMillis() + 8000;
        while (state < 4) {
            if (System.currentTimeMillis() > deadline) {
                closeQuietly(s);
                throw new IOException("连接超时");
            }
            int b = is.read();
            if (b < 0) {
                closeQuietly(s);
                throw new IOException("连接被对方关闭");
            }
            head.write(b);
            if ((state == 0 || state == 2) && b == '\r') state++;
            else if ((state == 1 || state == 3) && b == '\n') state++;
            else state = (b == '\r') ? 1 : 0;
            if (head.size() > 32768) {
                closeQuietly(s);
                throw new IOException("对方响应异常");
            }
        }
        String headStr = head.toString("UTF-8");
        int sp = headStr.indexOf(' ');
        int status = 0;
        if (sp > 0) {
            int sp2 = headStr.indexOf(' ', sp + 1);
            String codeStr = sp2 > 0 ? headStr.substring(sp + 1, sp2) : headStr.substring(sp + 1, sp + 4);
            try { status = Integer.parseInt(codeStr.trim()); } catch (Exception ignored) { }
        }
        if (status != 101) {
            closeQuietly(s);
            // 服务端的拒绝理由是 JSON（{"error":"…"}）——抠出来给人话
            String why = "";
            int i = headStr.indexOf("\"error\"");
            if (i > 0) {
                int a = headStr.indexOf('"', headStr.indexOf(':', i) + 1);
                int b = a > 0 ? headStr.indexOf('"', a + 1) : -1;
                if (a > 0 && b > a) why = headStr.substring(a + 1, b);
            }
            if (status == 400) throw new IOException("协议版本不符（对方版本更新）：" + why);
            if (status == 403) throw new IOException("对方拒绝了这次连接：" + why);
            throw new IOException("连接被拒绝（HTTP " + status + "）" + why);
        }
        return new TunnelWs(id, s, is, os, sink);
    }

    /** 起读线程（升级成功后调）。 */
    public void start() {
        Thread t = new Thread(new TunnelWsReader(this), "myco-tunnel-ws-" + id);
        t.setDaemon(true);
        t.start();
        startKeepalive();
    }

    /**
     * 2026-10-26：空闲 1.5s 发 WS ping。
     * 真机现象：RDP 登录后约 5s 被 NAT/中继掐（PC 侧 Connection reset without closing handshake）。
     * 数据帧会刷新 lastWriteAt；只有静默窗才补 ping，不放大流量。
     */
    private void startKeepalive() {
        Thread t = new Thread(() -> {
            while (!closed) {
                try { Thread.sleep(500); } catch (InterruptedException e) { break; }
                if (closed) break;
                long idle = System.currentTimeMillis() - lastWriteAt;
                if (idle < 1500) continue;
                try {
                    sendFrame((byte) 0x9, new byte[0]);
                } catch (IOException e) {
                    if (!closed) hardClose(1006, "keepalive-fail");
                    break;
                }
            }
        }, "myco-tunnel-ws-keepalive-" + id);
        t.setDaemon(true);
        t.start();
    }

    // ── 发送（二进制）──

    public void sendBinary(byte[] payload) throws IOException {
        sendFrame((byte) 0x2, payload);
    }

    private void sendFrame(byte opcode, byte[] payload) throws IOException {
        synchronized (writeLock) {
            if (closed) throw new IOException("连接已关闭");
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream(payload.length + 14);
            buf.write(0x80 | opcode); // FIN + opcode
            int len = payload.length;
            if (len < 126) {
                buf.write(0x80 | len); // 客户端必须掩码
            } else if (len < 65536) {
                buf.write(0x80 | 126);
                buf.write((len >>> 8) & 0xff);
                buf.write(len & 0xff);
            } else {
                buf.write(0x80 | 127);
                long l = len;
                for (int i = 7; i >= 0; i--) buf.write((int) ((l >>> (8 * i)) & 0xff));
            }
            byte[] mask = new byte[4];
            RND.nextBytes(mask);
            buf.write(mask, 0, 4);
            byte[] masked = new byte[len];
            for (int i = 0; i < len; i++) masked[i] = (byte) (payload[i] ^ mask[i & 3]);
            buf.write(masked, 0, len);
            out.write(buf.toByteArray());
            out.flush();
            lastWriteAt = System.currentTimeMillis();
        }
    }

    /** 正常关闭（发 close 帧再断 TCP）。 */
    public void close(int code, String reason) {
        if (closed) return;
        try {
            byte[] r = reason == null ? new byte[0] : reason.getBytes("UTF-8");
            byte[] p = new byte[2 + r.length];
            p[0] = (byte) ((code >>> 8) & 0xff);
            p[1] = (byte) (code & 0xff);
            System.arraycopy(r, 0, p, 2, r.length);
            sendFrame((byte) 0x8, p);
        } catch (Exception ignored) { }
        hardClose(1000, "closed");
    }

    /** 2026-10-26 RDP 原生路径用：直接硬关，不等待 close 帧写出。 */
    public void abort() {
        hardClose(1000, "aborted");
    }

    void hardClose(int code, String reason) {
        if (closed) return;
        closed = true;
        closeQuietly(sock);
        sink.onClosed(this, code, reason);
    }

    boolean isClosed() { return closed; }

    // ── 读线程体（顶层辅助类里调）──

    void readLoop() throws IOException {
        java.io.ByteArrayOutputStream frag = null;
        int fragOp = 0;
        while (!closed) {
            int b0 = in.read();
            if (b0 < 0) break;
            int b1 = in.read();
            if (b1 < 0) break;
            boolean fin = (b0 & 0x80) != 0;
            int opcode = b0 & 0x0f;
            boolean masked = (b1 & 0x80) != 0;
            long len = b1 & 0x7f;
            if (len == 126) {
                len = ((long) readByte() << 8) | readByte();
            } else if (len == 127) {
                len = 0;
                for (int i = 0; i < 8; i++) len = (len << 8) | readByte();
            }
            if (len < 0 || len > MAX_FRAME) throw new IOException("帧过大");
            byte[] mask = null;
            if (masked) {
                mask = new byte[4];
                readFully(mask, 4);
            }
            byte[] payload = new byte[(int) len];
            readFully(payload, (int) len);
            if (masked) for (int i = 0; i < payload.length; i++) payload[i] = (byte) (payload[i] ^ mask[i & 3]);

            if (opcode == 0x8) { // close
                int code = payload.length >= 2 ? (((payload[0] & 0xff) << 8) | (payload[1] & 0xff)) : 1005;
                String reason = payload.length > 2 ? new String(payload, 2, payload.length - 2, "UTF-8") : "";
                hardClose(code, reason);
                return;
            }
            if (opcode == 0x9) { // ping → pong（同载荷）
                try { sendFrame((byte) 0xA, payload); } catch (IOException ignored) { }
                continue;
            }
            if (opcode == 0xA) continue; // pong：忽略
            if (opcode == 0x0) { // continuation
                if (frag == null) continue;
                frag.write(payload, 0, payload.length);
                if (fin) {
                    sink.onBinary(this, frag.toByteArray());
                    frag = null;
                }
                continue;
            }
            if (opcode == 0x1 || opcode == 0x2) {
                if (fin) {
                    sink.onBinary(this, payload);
                } else {
                    frag = new java.io.ByteArrayOutputStream(payload.length * 2);
                    frag.write(payload, 0, payload.length);
                    fragOp = opcode;
                }
                continue;
            }
            // 未知 opcode：忽略（不炸整条连接）
            if (fragOp == 0) continue;
        }
        hardClose(1006, "连接结束");
    }

    private int readByte() throws IOException {
        int b = in.read();
        if (b < 0) throw new IOException("连接结束");
        return b;
    }

    private void readFully(byte[] buf, int n) throws IOException {
        int off = 0;
        while (off < n) {
            int r = in.read(buf, off, n - off);
            if (r < 0) throw new IOException("连接结束");
            off += r;
        }
    }

    private static void closeQuietly(Socket s) {
        try { s.close(); } catch (Exception ignored) { }
    }

    /** 对外暴露给 TunnelWsReader 的入口（同包可见）。 */
    void runReader() {
        try {
            readLoop();
        } catch (IOException e) {
            hardClose(1006, e.getMessage() == null ? "连接错误" : e.getMessage());
        } catch (Exception e) {
            hardClose(1006, "连接错误");
        }
    }
}
