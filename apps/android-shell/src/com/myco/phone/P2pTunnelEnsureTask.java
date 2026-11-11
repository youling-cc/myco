package com.myco.phone;

/**
 * p2pTunnelEnsureAsync 的后台任务体（2026-11-11，顶层类——d8 8.2.2-dev 对
 * 匿名/内嵌类 NPE，与 ProxyPostTask 同款纪律）。
 *
 * 为什么必须异步：libvnet 的 Connection 构造（with_secret_and_port）在**调用
 * 线程**同步做 relay 注册退避重试（5 次 × 3s ACK + 1/2/4/8s 退避 ≈ 30s）与
 * STUN 查询——放在 JS bridge 线程会冻住整个 WebView（真机事故：eval 全部
 * timeout 十几分钟）。ffi.rs 注释自己声明"本调用立刻返回（JNI 调用线程不能
 * 被阻塞）"，vnet 侧修好前宿主必须自带线程。
 */
public class P2pTunnelEnsureTask implements Runnable {
    private final MainActivity act;
    private final String callbackJs;
    private final String json;

    public P2pTunnelEnsureTask(MainActivity act, String callbackJs, String json) {
        this.act = act;
        this.callbackJs = callbackJs;
        this.json = json;
    }

    @Override public void run() {
        final String result = P2pSyncTunnel.ensure(json);
        try {
            act.web.post(new ProxyPostCallback(act, callbackJs, result));
        } catch (Throwable t) {
            android.util.Log.e("P2pTunnelEnsure", "callback failed", t);
        }
    }
}
