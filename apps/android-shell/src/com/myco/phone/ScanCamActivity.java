package com.myco.phone;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.media.ImageReader;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.Toast;
import java.util.Arrays;

/**
 * 扫码拍照页(2026-09-04 终稿):全屏相机预览 + 系统相机风格控件——
 * 左下角相册缩略图(MediaStore 最新一张)/中央白色快门环/右上关闭。
 * 拍照或从相册选图都经后台线程压码(ScanProcess),setResult(base64 dataURL)
 * 回 MainActivity → SnapCam → PWA 识别。Camera2 手写,回调全顶层类(R8)。
 */
public class ScanCamActivity extends Activity implements View.OnClickListener {
    public static final String EXTRA_DATAURL = "dataURL";
    private static final int REQ_GALLERY = 0xCA03;
    private TextureView tv;
    private CameraDevice cam;
    private CameraCaptureSession sess;
    private ImageReader reader;
    private Handler main = new Handler(Looper.getMainLooper());
    private boolean taking = false;
    private boolean done = false; // 只回传一次

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, 7);
            return;
        }
        init();
    }

    @Override public void onRequestPermissionsResult(int rq, String[] p, int[] res) {
        if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) init();
        else { Toast.makeText(this, "需要相机权限", Toast.LENGTH_SHORT).show(); finish(); }
    }

    private void init() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF000000);

        tv = new TextureView(this);
        root.addView(tv, new FrameLayout.LayoutParams(-1, -1));

        root.addView(new ScanFrame(this), new FrameLayout.LayoutParams(-1, -1));

        // 右上关闭(系统图标+半透明圆底)
        ImageView close = iconBtn(android.R.drawable.ic_menu_close_clear_cancel);

        // 左下相册缩略图(最新一张照片;取不到用系统相册图标占位)
        ImageView gal = iconBtn(android.R.drawable.ic_menu_gallery);
        loadLatestThumb(gal);

        // 中央快门(自绘白环,无文字)
        ShutterView shutter = new ShutterView(this);

        LinearLayout bottom = new LinearLayout(this);
        bottom.setOrientation(LinearLayout.HORIZONTAL);
        bottom.setGravity(17);
        LinearLayout.LayoutParams gp = new LinearLayout.LayoutParams(dp(46), dp(46));
        gp.setMargins(0, 0, dp(70), 0);
        gal.setLayoutParams(gp);
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(dp(78), dp(78));
        sp.setMargins(dp(14), 0, dp(14), 0);
        shutter.setLayoutParams(sp);
        View spacer = new View(this);
        spacer.setLayoutParams(new LinearLayout.LayoutParams(dp(46), dp(46)));
        bottom.addView(gal);
        bottom.addView(shutter);
        bottom.addView(spacer);

        FrameLayout.LayoutParams bp = new FrameLayout.LayoutParams(-1, -2, 80);
        bp.bottomMargin = dp(26);
        root.addView(bottom, bp);
        FrameLayout.LayoutParams cp = new FrameLayout.LayoutParams(dp(46), dp(46), 53);
        cp.setMargins(0, dp(16), dp(14), 0);
        root.addView(close, cp);

        close.setId(1); gal.setId(2); shutter.setId(3);
        close.setOnClickListener(this); gal.setOnClickListener(this); shutter.setOnClickListener(this);
        setContentView(root);
        tv.setSurfaceTextureListener(new CamTex(this));
    }

    private int dp(int v) {
        float d = getResources().getDisplayMetrics().density;
        return Math.round(v * d);
    }

    private ImageView iconBtn(int iconRes) {
        ImageView v = new ImageView(this);
        v.setImageResource(iconRes);
        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        bg.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        bg.setColor(0x59000000);
        v.setBackground(bg);
        v.setScaleType(ImageView.ScaleType.FIT_CENTER);
        v.setPadding(dp(10), dp(10), dp(10), dp(10));
        return v;
    }

    /** 相册缩略图:取 MediaStore 最新一张(API 29+ loadThumbnail;老版本留占位图标)。 */
    private void loadLatestThumb(final ImageView v) {
        if (Build.VERSION.SDK_INT < 29) return;
        try {
            android.database.Cursor c = getContentResolver().query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                new String[]{MediaStore.Images.Media._ID}, null, null,
                MediaStore.Images.Media.DATE_ADDED + " DESC");
            if (c != null && c.moveToFirst()) {
                long id = c.getLong(0);
                c.close();
                Uri u = Uri.withAppendedPath(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, String.valueOf(id));
                android.graphics.Bitmap t = getContentResolver().loadThumbnail(u, new android.util.Size(dp(46), dp(46)), null);
                v.setImageBitmap(t);
                v.setBackgroundResource(0);
                v.setPadding(0, 0, 0, 0);
                v.setScaleType(ImageView.ScaleType.CENTER_CROP);
            } else if (c != null) c.close();
        } catch (Exception e) {
            CamLog.note(this, "thumb FAIL: " + e);
        }
    }

    @Override public void onClick(View v) {
        if (v.getId() == 1) { setResult(RESULT_CANCELED); finish(); }
        else if (v.getId() == 2) {
            try {
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("image/*");
                startActivityForResult(i, REQ_GALLERY);
            } catch (Exception e) { CamLog.note(this, "gallery launch FAIL: " + e); }
        }
        else if (v.getId() == 3) takeShot();
    }

    // ── Camera2 ──────────────────────────────────────────────
    void openCam() {
        try {
            CameraManager cm = (CameraManager) getSystemService(CAMERA_SERVICE);
            String id = null;
            for (String s : cm.getCameraIdList()) {
                CameraCharacteristics cc = cm.getCameraCharacteristics(s);
                Integer facing = cc.get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) { id = s; break; }
            }
            if (id == null && cm.getCameraIdList().length > 0) id = cm.getCameraIdList()[0];
            if (id == null) { finishErr("no camera"); return; }
            reader = ImageReader.newInstance(1920, 1088, android.graphics.ImageFormat.JPEG, 2);
            reader.setOnImageAvailableListener(new CamImageGot(this), main);
            if (Build.VERSION.SDK_INT >= 23) cm.openCamera(id, new CamState(this), null);
        } catch (Exception e) { CamLog.note(this, "openCam FAIL: " + e); finishErr("open " + e); }
    }

    void onOpened(CameraDevice d) {
        cam = d;
        try {
            Surface s = new Surface(tv.getSurfaceTexture());
            tv.getSurfaceTexture().setDefaultBufferSize(1440, 1080);
            cam.createCaptureSession(Arrays.asList(s, reader.getSurface()), new CamSession(this), null);
        } catch (Exception e) { CamLog.note(this, "session FAIL: " + e); }
    }

    void onSession(CameraCaptureSession s) {
        sess = s;
        try {
            CaptureRequest.Builder b = cam.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            b.addTarget(new Surface(tv.getSurfaceTexture()));
            b.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            sess.setRepeatingRequest(b.build(), null, main);
        } catch (Exception e) { CamLog.note(this, "repeat FAIL: " + e); }
    }

    private void takeShot() {
        if (taking || sess == null || cam == null) return;
        taking = true;
        try {
            CaptureRequest.Builder b = cam.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
            b.addTarget(reader.getSurface());
            b.set(CaptureRequest.JPEG_ORIENTATION, 90);
            sess.capture(b.build(), null, main);
        } catch (Exception e) { taking = false; CamLog.note(this, "shot FAIL: " + e); }
    }

    void onImage(android.media.Image img) {
        try {
            java.nio.ByteBuffer buf = img.getPlanes()[0].getBuffer();
            byte[] bytes = new byte[buf.remaining()];
            buf.get(bytes);
            img.close();
            processBytes(bytes);
        } catch (Exception e) {
            try { img.close(); } catch (Exception ignored) { }
            finishErr("img " + e);
        }
    }

    @Override protected void onActivityResult(int rq, int code, Intent data) {
        super.onActivityResult(rq, code, data);
        if (rq != REQ_GALLERY) return;
        if (code == RESULT_OK && data != null && data.getData() != null) {
            processUri(data.getData());
        } else {
            CamLog.note(this, "gallery canceled, stay in viewfinder");
        }
    }

    /** 拍照字节 → 后台压码 → 直投桥 → 关界面。 */
    private void processBytes(byte[] bytes) {
        busy("识别中…");
        Thread t = new Thread(new ScanProcess(this, MainActivity.snapRef(), null, bytes));
        t.setDaemon(true);
        t.start();
    }

    /** 相册 URI → 后台读流+压码 → 直投桥 → 关界面。 */
    private void processUri(Uri uri) {
        busy("识别中…");
        Thread t = new Thread(new ScanProcess(this, MainActivity.snapRef(), uri, null));
        t.setDaemon(true);
        t.start();
    }

    /** 处理中反馈(黑底取景页无提示=用户以为卡死)。 */
    private void busy(String msg) {
        try { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show(); } catch (Exception ignored) { }
    }

    /** 后台处理完成回 UI 线程:setResult + finish(只做一次)。 */
    void deliverDataUrl(String dataUrl) {
        // 兼容保留:结果主路径已由 ScanProcess 直投桥(不走 setResult——
        // activity finish 后 setResult 无效,结果丢失=「上传图没反应」根因)
        if (done) return;
        done = true;
        CamLog.note(this, "deliver urlLen=" + (dataUrl == null ? 0 : dataUrl.length()));
        Intent out = new Intent();
        if (dataUrl != null) { out.putExtra(EXTRA_DATAURL, dataUrl); setResult(RESULT_OK, out); }
        else setResult(RESULT_CANCELED, out);
        finish();
    }

    /** ScanDone 收尾:结果已直投,这里只关界面。 */
    void closeWith(boolean ok) {
        if (done) return;
        done = true;
        setResult(ok ? RESULT_OK : RESULT_CANCELED);
        finish();
    }

    void finishErr(String err) {
        CamLog.note(this, "finishErr: " + err);
        closeWith(false);
    }

    @Override protected void onDestroy() {
        try { if (sess != null) sess.close(); } catch (Exception ignored) { }
        try { if (cam != null) cam.close(); } catch (Exception ignored) { }
        try { if (reader != null) reader.close(); } catch (Exception ignored) { }
        super.onDestroy();
    }

    void postUi(Runnable r) { main.post(r); }
}
