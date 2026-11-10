package com.myco.phone;

import java.io.IOException;
import java.io.OutputStream;
import java.net.Socket;

/** 本地代理的一条连接（顶层类）。字段简单，读写各一把锁。 */
public class TunnelProxyConn {
    public final int id;
    public final Socket sock;
    private final OutputStream out;
    private final Object wlock = new Object();
    private volatile boolean closed = false;
    /** 2026-10-18 晚：JS 桥是否回过字节（= 桥活着且在处理这条连接）。 */
    private volatile boolean jsWrote = false;
    /** 2026-10-18 晚：本条是否已识别为隧道握手连接、首个隧道字节到来的时刻。 */
    private volatile long tunnelAt = 0L;

    public TunnelProxyConn(int id, Socket s) throws IOException {
        this.id = id;
        this.sock = s;
        s.setTcpNoDelay(true);
        this.out = s.getOutputStream();
    }

    /** 把对端解出来的明文写回浏览器（JS bridge 线程调用）。 */
    public void write(byte[] data) {
        if (closed || data == null || data.length == 0) return;
        synchronized (wlock) {
            if (closed) return;
            try {
                out.write(data);
                out.flush();
                jsWrote = true; // 桥回字节了：看门狗据此判定 JS 未冻结
            } catch (IOException e) {
                // 浏览器侧已关：交给读线程收尾（这里只标记）
                closed = true;
            }
        }
    }

    /** 标记"这条连接第一个隧道字节已到"（看门狗起算点；幂等）。 */
    public void armTunnel(long nowMs) {
        if (tunnelAt == 0L) tunnelAt = nowMs;
    }

    public boolean tunnelArmed() { return tunnelAt != 0L; }
    public long tunnelAt() { return tunnelAt; }
    public boolean jsWrote() { return jsWrote; }

    public boolean isClosed() { return closed; }

    public void close() {
        if (closed) return;
        closed = true;
        try { sock.close(); } catch (Exception ignored) { }
    }
}
