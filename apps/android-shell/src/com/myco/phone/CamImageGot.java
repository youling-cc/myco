package com.myco.phone;

import android.media.Image;
import android.media.ImageReader;

/** 拍照 JPEG 就绪回调(顶层类)。 */
public class CamImageGot implements ImageReader.OnImageAvailableListener {
    private final ScanCamActivity a;
    public CamImageGot(ScanCamActivity a) { this.a = a; }
    @Override public void onImageAvailable(ImageReader r) {
        android.media.Image img = null;
        try { img = r.acquireLatestImage(); } catch (Exception ignored) { }
        if (img != null) a.onImage(img);
    }
}
