package com.myco.phone;

import android.hardware.camera2.CameraDevice;

/** CameraDevice 状态回调(顶层类)。 */
public class CamState extends CameraDevice.StateCallback {
    private final ScanCamActivity a;
    public CamState(ScanCamActivity a) { this.a = a; }
    @Override public void onOpened(CameraDevice d) { a.onOpened(d); }
    @Override public void onDisconnected(CameraDevice d) { try { d.close(); } catch (Exception ignored) { } }
    @Override public void onError(CameraDevice d, int err) { CamLog.note(a, "camera err " + err); a.finishErr("cam err " + err); }
}
