package com.myco.phone;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;

import java.util.concurrent.CountDownLatch;

/**
 * FileOpen 的 UI 线程部分：ACTION_VIEW + 授权读；异常（无关联 app 等）写结果槽
 * 由 FileOpen 经 latch 同步回传 JS。顶层具名类（R8/d8 对匿名/内嵌类炸）。
 */
public class FileOpenLaunch implements Runnable {
    private final Activity act;
    private final Uri uri;
    private final String mime;
    private final String[] out;
    private final CountDownLatch done;

    FileOpenLaunch(Activity a, Uri u, String m, String[] o, CountDownLatch d) {
        act = a; uri = u; mime = m; out = o; done = d;
    }

    @Override public void run() {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, mime);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            act.startActivity(i);
            out[0] = "OK";
        } catch (android.content.ActivityNotFoundException e) {
            out[0] = "ERR:未找到可打开「该类型」的应用";
        } catch (Exception e) {
            out[0] = "ERR:" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        } finally {
            done.countDown();
        }
    }
}
