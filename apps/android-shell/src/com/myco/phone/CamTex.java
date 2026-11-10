package com.myco.phone;

import android.graphics.SurfaceTexture;
import android.view.TextureView;

/** TextureView 就绪回调(顶层类——R8 对内嵌类 NPE)。 */
public class CamTex implements TextureView.SurfaceTextureListener {
    private final ScanCamActivity a;
    public CamTex(ScanCamActivity a) { this.a = a; }
    @Override public void onSurfaceTextureAvailable(SurfaceTexture s, int w, int h) { a.openCam(); }
    @Override public void onSurfaceTextureSizeChanged(SurfaceTexture s, int w, int h) { }
    @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture s) { return true; }
    @Override public void onSurfaceTextureUpdated(SurfaceTexture s) { }
}
