package com.myco.phone;

/**
 * DeepLinkBridge — 2026-10-29 深链接登录（DL-Auth）的 Java→JS 桥。
 *
 * 根因：evaluateJavascript/loadUrl(javascript:) 在 Honor 冻结恢复后静默丢，
 * PUSH 模型（Java 推 JS）不可靠。改 PULL 模型——JS 侧定时轮询本桥拉取。
 *
 * 用法（JS 侧）：
 *   const dl = MycoShell.getPendingDeepLink()   // 返回 myco://auth?... 或 null
 *   MycoShell.clearPendingDeepLink()             // 处理完清掉
 */
public class DeepLinkBridge {
    /** 读待处理的深链接 URL（null=无）。JS 轮询调。 */
    @android.webkit.JavascriptInterface
    public String getPendingDeepLink() {
        return MainActivity.sPendingDeepLinkPublic;
    }

    /** 清除待处理深链接（JS 处理完后调）。 */
    @android.webkit.JavascriptInterface
    public void clearPendingDeepLink() {
        MainActivity.sPendingDeepLinkPublic = null;
    }
}
