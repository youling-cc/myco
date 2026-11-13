package com.myco.phone;

/**
 * vnetAdbServerStartAsync / vnetAdbServerStopAsync 的后台任务体（2026-11-11，
 * 顶层类——d8 8.2.2-dev 对匿名/内嵌类 NPE，与 ProxyPostTask 同款纪律）。
 *
 * 为什么必须异步：libvnet 的注册在调用线程同步退避重试（relay 注册 5 次
 * × 3s ACK + 1/2/4/8s 退避 ≈ 30s；server 侧主循环也在 FFI 内）——JS bridge
 * 线程直调会冻住整个 WebView（真机事故：vnetAdbServerStart 同步版 eval
 * timeout 且 state() 跟着冻）。凡触 libvnet 的桥一律后台线程 + 回调。
 */
public class AdbServerTask implements Runnable {
    private final MainActivity act;
    private final String callbackJs;
    private final String json;
    /** start（true）/ stop（false）。 */
    private final boolean start;

    public AdbServerTask(MainActivity act, String callbackJs, String json, boolean start) {
        this.act = act;
        this.callbackJs = callbackJs;
        this.json = json;
        this.start = start;
    }

    @Override public void run() {
        final String result = start
                ? AdbShareServer.start(json, act)
                : AdbShareServer.stop(act);
        try {
            act.web.post(new ProxyPostCallback(act, callbackJs, result));
        } catch (Throwable t) {
            android.util.Log.e("AdbServerTask", "callback failed", t);
        }
    }
}
