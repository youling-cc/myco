package com.myco.phone;

/**
 * 网络变化 → 页面重载的 **UI 线程投递**（2026-10-18）。
 *
 * 为什么必须单独一跳：`ConnectivityManager.NetworkCallback` 跑在 binder 线程，
 * 直接调 WebView 的 `evaluateJavascript` 会抛 "All WebView methods must be called
 * on the same thread"（被 catch 吞掉 → 页面永远收不到通知，真机实测踩到）。
 *
 * 顶层类而非匿名类：d8 8.2.2-dev 匿名类 NPE 旧疾，承既有纪律。
 */
public class ShareNetNotify implements Runnable {
    private final ShareWebActivity act;

    public ShareNetNotify(ShareWebActivity a) { this.act = a; }

    @Override
    public void run() {
        act.applyNetReload();
    }
}
