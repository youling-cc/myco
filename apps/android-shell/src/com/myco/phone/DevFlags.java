package com.myco.phone;

/**
 * 编译期开发开关（**发布版必须全部 false**）。
 *
 * 2026-10-20：设备侧 R 指标（R7 手机 cell / R4 remote 真机样本）需要从 PC 用 CDP 量
 * 分享页 WebView 的 DOM 口径。Android 只有打开 `WebView.setWebContentsDebuggingEnabled(true)`
 * 才会暴露 `webview_devtools_remote` socket；这里做成**显式常量**（而不是 BuildConfig.DEBUG），
 * 让"发布前必须检查"变成一行可 grep 的开关。
 */
final class DevFlags {
    private DevFlags() { }
    /** 打开 WebView DevTools（仅本地 adb 可达；发布版必须 false）。 */
    static final boolean WEBVIEW_DEBUG = false;
}
