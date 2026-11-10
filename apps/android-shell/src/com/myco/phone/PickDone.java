package com.myco.phone;

/** 后台选图处理完成回 UI 线程(顶层类——匿名 Runnable 会让 R8 NPE)。 */
public class PickDone implements Runnable {
    private final SnapCam cam;
    private final String dataUrl;
    public PickDone(SnapCam cam, String dataUrl) { this.cam = cam; this.dataUrl = dataUrl; }
    @Override public void run() { cam.onPickDataUrl(dataUrl); }
}
