package com.myco.phone;

/** WS 连接线程体（顶层类——d8 8.2.2-dev 对匿名/内嵌类 NPE）。 */
public class TunnelWsOpen implements Runnable {
    private final TunnelProxyService svc;
    private final String wsId;
    private final String url;
    private final String headersJson;
    public TunnelWsOpen(TunnelProxyService svc, String wsId, String url, String headersJson) {
        this.svc = svc; this.wsId = wsId; this.url = url; this.headersJson = headersJson;
    }
    @Override public void run() { svc.openWsBlocking(wsId, url, headersJson); }
}
