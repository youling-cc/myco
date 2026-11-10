package com.myco.phone;

/** 网络切换防抖后的原生 kick（顶层类，规避 D8 对嵌套匿名类的问题）。 */
public class NetWatchTask implements Runnable {
    @Override public void run() {
        try {
            RelayProvider.forceReconnect("connectivity-changed");
        } catch (Throwable ignored) { }
        try {
            android.webkit.WebView w = MainActivity.sWeb;
            if (w != null) w.post(new NetWatchJsTask(w));
        } catch (Throwable ignored) { }
    }
}
