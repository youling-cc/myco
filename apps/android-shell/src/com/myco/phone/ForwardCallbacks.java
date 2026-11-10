package com.myco.phone;

import android.webkit.WebView;
import java.io.ByteArrayOutputStream;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * ForwardCallbacks — 把 {@link ForwardListener} 的原生事件转成 WebView 里的 JS 调用。
 *
 * 顶层类（d8/R8 对内嵌/匿名类会 NPE——本项目历史坑）。
 * JS 侧命名空间：`window.__mycoFwd.onConn/onData/onClosed/onError`。
 *
 * 2026-10-25 RDP 图形流修复：原生侧按连接做 20ms/64KB 合包。
 * 旧实现每个 16KB 包都转 base64 后 evaluateJavascript 一次，DSH 的 HTTP 尚能扛，
 * RDP 图形流会把 UI 线程的 JS 队列打爆，出现"先进桌面，几秒后 E_ABORT"。
 * 合包不改变 TCP 字节序，只减少 JS 投递次数；onClosed 前先 flush，避免截尾。
 */
public class ForwardCallbacks implements ForwardListener.Sink {
    private static final int FLUSH_BYTES = 64 * 1024;
    private static final long FLUSH_DELAY_MS = 20L;
    private static final long LOG_INTERVAL_MS = 2000L;

    private final WebView web;
    private final Map<String, ByteArrayOutputStream> pending = new HashMap<>();
    private final Set<String> scheduled = new HashSet<>();
    private long dataCalls;
    private long batchCalls;
    private long flushedBytes;
    private long lastLogMs;

    public ForwardCallbacks(WebView w) {
        this.web = w;
    }

    private void js(String code) {
        WebView w = web;
        if (w == null) return;
        w.post(new JsEval(w, code));
    }

    @Override
    public void onConn(int localPort, int connId) {
        js("window.__mycoFwd&&window.__mycoFwd.onConn(" + localPort + "," + connId + ")");
    }

    @Override
    public void onData(int localPort, int connId, byte[] data) {
        if (data == null || data.length == 0) return;
        final String key = localPort + ":" + connId;
        byte[] emit = null;
        synchronized (this) {
            dataCalls++;
            ByteArrayOutputStream q = pending.get(key);
            if (q == null) {
                q = new ByteArrayOutputStream();
                pending.put(key, q);
            }
            q.write(data, 0, data.length);
            if (q.size() >= FLUSH_BYTES) {
                emit = drain(key);
            } else if (web != null && scheduled.add(key)) {
                web.postDelayed(new ForwardFlush(this, key), FLUSH_DELAY_MS);
            }
        }
        if (emit != null) emitData(localPort, connId, emit);
    }

    /** 到期/闭包前冲刷（包级顶层 ForwardFlush 调）。 */
    void flush(String key) {
        final byte[] emit;
        synchronized (this) {
            emit = drain(key);
        }
        if (emit == null || emit.length == 0) return;
        int split = key.indexOf(':');
        int localPort = Integer.parseInt(key.substring(0, split));
        int connId = Integer.parseInt(key.substring(split + 1));
        emitData(localPort, connId, emit);
    }

    private byte[] drain(String key) {
        scheduled.remove(key);
        ByteArrayOutputStream q = pending.remove(key);
        return q == null ? null : q.toByteArray();
    }

    private void emitData(int localPort, int connId, byte[] data) {
        batchCalls++;
        flushedBytes += data.length;
        String b64 = android.util.Base64.encodeToString(data, android.util.Base64.NO_WRAP);
        js("window.__mycoFwd&&window.__mycoFwd.onData(" + localPort + "," + connId + ",'" + b64 + "')");
        long now = System.currentTimeMillis();
        if (now - lastLogMs >= LOG_INTERVAL_MS) {
            lastLogMs = now;
            GwLog.note(null, "vnet-forward-jsq onData=" + dataCalls + " batches=" + batchCalls
                    + " flushedKB=" + (flushedBytes / 1024));
        }
    }

    @Override
    public void onClosed(int localPort, int connId, String why) {
        // 先冲刷该连接的尾包，再发 close；否则图形帧会被截尾。
        flush(localPort + ":" + connId);
        js("window.__mycoFwd&&window.__mycoFwd.onClosed(" + localPort + "," + connId + ",'"
                + (why == null ? "" : why.replace("'", "")) + "')");
    }

    @Override
    public void onError(int localPort, String msg) {
        js("window.__mycoFwd&&window.__mycoFwd.onError(" + localPort + ",'"
                + (msg == null ? "" : msg.replace("'", "").replace("\\", "/")) + "')");
    }
}
