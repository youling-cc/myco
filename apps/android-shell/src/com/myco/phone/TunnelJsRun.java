package com.myco.phone;

/** TunnelJs 的 UI 线程体（顶层类——d8 8.2.2-dev 对匿名/内嵌类 NPE）。 */
public class TunnelJsRun implements Runnable {
    private final android.webkit.WebView web;
    private final String js;
    public TunnelJsRun(android.webkit.WebView web, String js) { this.web = web; this.js = js; }
    @Override public void run() {
        try {
            // ⚠️ callback 必须非 null：本机 WebView 上 evaluateJavascript(js, null)
            // 会静默不执行（EnvServer kind1/kind4 的实证注释）。
            web.evaluateJavascript(js, new JsCallback(new String[1]));
        } catch (Exception e) {
            android.util.Log.e("TunnelJs", "evaluateJavascript failed: " + js, e);
        }
    }
}
