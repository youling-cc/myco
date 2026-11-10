package com.myco.phone;

/** ProxyPostTask 完成后的 JS 回调体（顶层类——d8 8.2.2-dev 对匿名/内嵌类 NPE）。 */
public class ProxyPostCallback implements Runnable {
    private final MainActivity act;
    private final String callbackJs;
    private final String resultJson;

    public ProxyPostCallback(MainActivity act, String callbackJs, String resultJson) {
        this.act = act;
        this.callbackJs = callbackJs;
        this.resultJson = resultJson;
    }

    @Override public void run() {
        try {
            act.web.evaluateJavascript(callbackJs + "(" + resultJson + ")", new JsCallback(new String[1]));
        } catch (Exception e) {
            android.util.Log.e("ProxyPostCb", "callback failed: " + callbackJs, e);
        }
    }
}
