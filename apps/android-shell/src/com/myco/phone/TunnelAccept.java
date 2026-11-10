package com.myco.phone;

/** TunnelProxyServer 的 accept 循环（顶层类——d8 8.2.2-dev 对匿名/内嵌类 NPE）。 */
public class TunnelAccept implements Runnable {
    private final TunnelProxyServer srv;
    public TunnelAccept(TunnelProxyServer srv) { this.srv = srv; }
    @Override public void run() { srv.acceptLoop(); }
}
