package com.myco.phone;

/**
 * 诊断（2026-10-18）：原生通知页面重载前先探 `typeof window.__mycoNetChanged`，
 * 结果落 gw-net.log —— 用来区分"页面还是旧壳（函数不存在）"与"handler 存在但没重载"。
 *
 * 顶层类而非匿名类：d8 8.2.2-dev 匿名类 NPE 旧疾，承既有纪律。
 */
public class ShareNetProbe implements android.webkit.ValueCallback {
    private final ShareWebActivity act;

    public ShareNetProbe(ShareWebActivity a) { this.act = a; }

    @Override public void onReceiveValue(Object value) {
        try {
            GwLog.note(null, "share-page net-change probe: typeof __mycoNetChanged=" + String.valueOf(value));
        } catch (Exception ignored) { }
        act.applyNetReload2();
    }
}
