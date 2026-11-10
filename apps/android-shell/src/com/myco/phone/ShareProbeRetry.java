package com.myco.phone;

/**
 * 回前台探针的"复探"（2026-10-18）：探针判定"网络层失败"（'0'）时**不立刻退出**——
 * 先给 2s 复探一次，连续两次网络层失败才认定隧道真死（真机回归：页面刚打开 1.5s
 * 就会误判，实际 2s 后就恢复了）。
 *
 * 顶层类而非匿名类：d8 8.2.2-dev 匿名类 NPE 旧疾，承既有纪律。
 */
public class ShareProbeRetry implements Runnable {
    private final ShareWebActivity act;

    public ShareProbeRetry(ShareWebActivity a) { this.act = a; }

    @Override
    public void run() {
        act.retryProbeOnce();
    }
}
