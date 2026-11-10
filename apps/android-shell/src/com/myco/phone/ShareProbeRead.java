package com.myco.phone;

/**
 * 探针延时读回（2026-10-12 切会话断连修复）：探针是异步 fetch，结果落在
 * window.__mycoProbe——延时 1.5s 后读回并交给 Activity 决策（"0" → reload）。
 *
 * 顶层类而非匿名类：d8 8.2.2-dev 匿名类 NPE 旧疾，承既有纪律。
 */
public class ShareProbeRead implements Runnable {
    private final ShareWebActivity act;

    public ShareProbeRead(ShareWebActivity a) { this.act = a; }

    @Override
    public void run() {
        act.readProbe();
    }
}
