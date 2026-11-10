package com.myco.phone;

/** TunnelWs 的读线程体（顶层类——d8 8.2.2-dev 对内嵌/匿名类 NPE，全仓同规）。 */
public class TunnelWsReader implements Runnable {
    private final TunnelWs ws;
    public TunnelWsReader(TunnelWs ws) { this.ws = ws; }
    @Override public void run() { ws.runReader(); }
}
