package com.myco.phone;

/**
 * TunnelJs — 原生 → JS 的**回调通道**：在 UI 线程上 eval 一段调用
 * `window.__mycoTunnel.*` 的 JS（形状见 `apps/phone/src/native-proxy.ts`）。
 *
 * 两条纪律（本仓踩过的坑）：
 *   · `evaluateJavascript` **必须带非 null 的 callback**——本机 WebView 上
 *     `evaluateJavascript(js, null)` 会**静默不执行**（EnvServer 的 kind1/kind4
 *     注释里有实证）；
 *   · 匿名/内嵌类会让 d8 8.2.2-dev NPE → 一律走顶层 Runnable（`TunnelJsRun`）。
 *
 * 线程：`post()` 可从任意线程调（内部转 UI 线程）；`web.post` 也不需要 UI 线程。
 */
public class TunnelJs {
    private final MainActivity act;

    public TunnelJs(MainActivity a) { this.act = a; }

    /** 异步投递（reader/bridge 线程安全）。 */
    public void post(String js) {
        if (act == null || act.web == null) return;
        // WebView.post 自身线程安全（内部转 UI 线程），比 runOnUiThread 少一层包装
        act.web.post(new TunnelJsRun(act.web, js));
    }

    // ── 具体回调（形状与 native-proxy.ts 的表一一对应）──

    public void onStart(int port) {
        post("window.__mycoTunnel&&window.__mycoTunnel.onStart(" + jsStr("{\"ok\":true,\"port\":" + port + "}") + ")");
    }

    public void onConn(int connId) {
        post("window.__mycoTunnel&&window.__mycoTunnel.onConn(" + connId + ")");
    }

    public void onData(int connId, byte[] data) {
        post("window.__mycoTunnel&&window.__mycoTunnel.onData(" + connId + "," + jsStr(b64(data)) + ")");
    }

    public void onClose(int connId, String why) {
        post("window.__mycoTunnel&&window.__mycoTunnel.onClose(" + connId + "," + jsStr(nz(why)) + ")");
    }

    public void wsOpened(String wsId, String err) {
        post("window.__mycoTunnel&&window.__mycoTunnel.wsOpened(" + jsStr(wsId) + "," + jsStr(nz(err)) + ")");
    }

    public void wsData(String wsId, byte[] data) {
        post("window.__mycoTunnel&&window.__mycoTunnel.wsData(" + jsStr(wsId) + "," + jsStr(b64(data)) + ")");
    }

    public void wsClosed(String wsId, int code, String reason) {
        post("window.__mycoTunnel&&window.__mycoTunnel.wsClosed(" + jsStr(wsId) + "," + code + "," + jsStr(nz(reason)) + ")");
    }

    // 2026-10-22 手机入向 vnet 隧道：TcpDialer 读侧 → JS 泵进隧道会话
    public void onTcpData(int connId, byte[] data) {
        post("window.__mycoTcpData&&window.__mycoTcpData(" + connId + "," + jsStr(b64(data)) + ")");
    }

    public void onTcpClosed(int connId) {
        post("window.__mycoTcpClosed&&window.__mycoTcpClosed(" + connId + ")");
    }

    // ── 工具 ──

    public static String b64(byte[] b) {
        return android.util.Base64.encodeToString(b, android.util.Base64.NO_WRAP);
    }

    private static String nz(String s) { return s == null ? "" : s; }

    /** JS 字符串字面量（单引号包，转义 \\ 与 ' 与换行）。 */
    public static String jsStr(String s) {
        if (s == null) return "''";
        StringBuilder sb = new StringBuilder(s.length() + 8);
        sb.append('\'');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\\' || c == '\'') sb.append('\\').append(c);
            else if (c == '\n') sb.append("\\n");
            else if (c == '\r') sb.append("\\r");
            else if (c == '\u2028' || c == '\u2029') sb.append(' ');
            else if (c < 0x20) sb.append(' ');
            else sb.append(c);
        }
        sb.append('\'');
        return sb.toString();
    }
}
