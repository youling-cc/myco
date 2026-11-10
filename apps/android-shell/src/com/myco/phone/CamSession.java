package com.myco.phone;

import android.hardware.camera2.CameraCaptureSession;

/** 会话配置回调(顶层类)。 */
public class CamSession extends CameraCaptureSession.StateCallback {
    private final ScanCamActivity a;
    public CamSession(ScanCamActivity a) { this.a = a; }
    @Override public void onConfigured(CameraCaptureSession s) { a.onSession(s); }
    @Override public void onConfigureFailed(CameraCaptureSession s) { CamLog.note(a, "session configure failed"); a.finishErr("cfg failed"); }
}
