package com.myco.phone;

/** 单条本地连接的读循环（顶层类——d8 8.2.2-dev 对匿名/内嵌类 NPE）。 */
public class TunnelConnRead implements Runnable {
    private final TunnelProxyServer srv;
    private final TunnelProxyConn conn;
    public TunnelConnRead(TunnelProxyServer srv, TunnelProxyConn conn) { this.srv = srv; this.conn = conn; }
    @Override public void run() { srv.readLoop(conn); }
}
