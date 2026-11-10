package com.myco.phone;

/** 相机结果 JS 桥(顶层类——SnapCam 里匿名 Runnable 也炸 R8)。 */
public class SnapCamBridge implements Runnable {
    private final android.app.Activity act;
    private final String js;
    public SnapCamBridge(android.app.Activity act, String js) { this.act = act; this.js = js; }
    @Override public void run() {
        ((MainActivity) act).web.evaluateJavascript(js, null);
    }
}
