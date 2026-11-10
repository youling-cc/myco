package com.myco.phone;

/** 取景页收尾(finish;结果已由 ScanProcess 直投桥,不走 setResult)。顶层类。 */
public class ScanDone implements Runnable {
    private final ScanCamActivity act;
    private final boolean ok;
    public ScanDone(ScanCamActivity act, boolean ok) { this.act = act; this.ok = ok; }
    @Override public void run() { act.closeWith(ok); }
}
