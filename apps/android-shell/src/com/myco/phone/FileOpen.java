package com.myco.phone;

import android.app.Activity;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 第94轮：聊天文件卡点击 → 用系统默认程序打开（ACTION_VIEW，不做站内预览）。
 *
 * 路径（无 androidx 依赖，纯 framework API）：
 *   base64 → MediaStore.Downloads 写入（API 29+，自有 insert 无需存储权限，
 *   content URI 自带可授权语义——绕开 FileProvider 依赖）→ UI 线程
 *   ACTION_VIEW + FLAG_GRANT_READ_URI_PERMISSION。
 *
 * 线程模型：IO（解码+写入）在 JS bridge 线程；startActivity 必须 UI 线程
 * （JS 桥线程直接启动不前台——相机链路的教训）；结果（OK/ERR:xxx）经
 * 结果槽 + CountDownLatch 同步回传给 JS（前端 toast err）。
 *
 * 顶层类（R8/d8 对 JBR javac 内嵌类炸——同 UiRun/PageSeen 风格）。
 */
public class FileOpen {

    /** 文件名消毒：剥路径成分（防目录穿越/非法位置写入），限长保扩展名。 */
    static String safeName(String name) {
        if (name == null) return "file";
        String base = name;
        int cut = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
        if (cut >= 0) base = base.substring(cut + 1);
        base = base.trim();
        if (base.isEmpty()) return "file";
        return base.length() > 80 ? base.substring(base.length() - 80) : base;
    }

    /** JS 桥入口：返回 "OK" 或 "ERR:人话"。 */
    public static String open(Activity act, String b64, String name, String mime) {
        try {
            if (Build.VERSION.SDK_INT < 29) {
                return "ERR:系统版本过低（需 Android 10+），暂不支持直接打开";
            }
            byte[] bytes;
            try {
                bytes = android.util.Base64.decode(b64 == null ? "" : b64, android.util.Base64.DEFAULT);
            } catch (Exception e) {
                return "ERR:文件数据解码失败";
            }
            if (bytes == null || bytes.length == 0) return "ERR:文件数据为空";
            String nm = safeName(name);
            String mt = (mime == null || mime.isEmpty()) ? "application/octet-stream" : mime;
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.Downloads.DISPLAY_NAME, nm);
            cv.put(MediaStore.Downloads.MIME_TYPE, mt);
            Uri uri = act.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
            if (uri == null) return "ERR:写入系统下载区失败";
            java.io.OutputStream os = act.getContentResolver().openOutputStream(uri);
            if (os == null) return "ERR:写入系统下载区失败";
            try {
                os.write(bytes);
                os.flush();
            } finally {
                try { os.close(); } catch (Exception ignored) { }
            }
            final String[] out = { "OK" };
            final CountDownLatch done = new CountDownLatch(1);
            act.runOnUiThread(new FileOpenLaunch(act, uri, mt, out, done));
            done.await(5, TimeUnit.SECONDS);
            return out[0];
        } catch (Exception e) {
            return "ERR:" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        }
    }
}
