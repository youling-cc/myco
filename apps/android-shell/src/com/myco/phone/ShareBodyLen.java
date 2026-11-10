package com.myco.phone;

/**
 * 页面正文长度回执（2026-10-12）：onPageFinished 时向页面问一句
 * "body 可见文本去空白后多长"，回值落 GwLog。
 *
 * 这就是白屏的铁证签名：**壳到了、SPA 没渲染** = 页面加载完成但 body≈0。
 * 之前那轮（01:15~01:19 白屏数分钟）只能靠截图事后猜；现在每次加载（含看门狗
 * 触发的重载）都会留一行 body=N，序列一眼可读：load body=0 → watchdog reload →
 * load body=5xxx（自愈成功）。
 *
 * 顶层类 + **raw type**（d8 8.2.2-dev 两大坑：内嵌类 NPE、泛型超接口的
 * Signature 属性 NPE——见 JsCallback 同款注释，去 &lt;String&gt; 即过）。
 * 回值是 JSON 编码的数字字符串（"0"/"5231"），原样记。
 */
@SuppressWarnings({"rawtypes", "deprecation"})
public class ShareBodyLen implements android.webkit.ValueCallback {
    private final android.app.Activity act;
    private final String url;

    public ShareBodyLen(android.app.Activity a, String u) { act = a; url = u; }

    @Override public void onReceiveValue(Object v) {
        try {
            GwLog.note(act, "gw body=" + (v == null ? "?" : String.valueOf(v)) + " " + GwLog.shortUrl(url));
        } catch (Exception ignored) { }
    }
}
