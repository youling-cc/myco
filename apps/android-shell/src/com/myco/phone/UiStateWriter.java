package com.myco.phone;

/** 把 WebView url/title 填进 UiState(主线程跑;EnvServer 的 stateJson 在工作线程读槽)。 */
public class UiStateWriter implements Runnable {
    private final MainActivity act;
    private final UiState slot;
    public UiStateWriter(MainActivity act, UiState slot) { this.act = act; this.slot = slot; }
    @Override public void run() {
        slot.url = act.web != null ? act.web.getUrl() : "";
        slot.title = act.web != null ? act.web.getTitle() : "";
    }
}
