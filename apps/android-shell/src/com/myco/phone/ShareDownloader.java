package com.myco.phone;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.webkit.DownloadListener;

/**
 * 2026-10-22 myco 自更新通道：分享 WebView 的下载监听。
 * 原本 ShareWebActivity 没有 DownloadListener → 更新页「下载更新」点了完全没反应。
 * 这里用系统 DownloadManager 下载，.apk 完成后直接弹安装意图
 * （REQUEST_INSTALL_PACKAGES 已在 Manifest 声明）。
 *
 * 独立顶级类（不写匿名内部类）：本机 d8 8.2.2-dev 对匿名/嵌套类报 NPE（实测）。
 */
class ShareDownloader implements DownloadListener {
    private final Activity act;

    ShareDownloader(Activity a) { act = a; }

    @Override
    public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                String mimeType, long contentLength) {
        try {
            DownloadManager dm = (DownloadManager) act.getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) return;
            String name = guessFileName(url, contentDisposition);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            if (mimeType != null && mimeType.length() > 0) req.setMimeType(mimeType);
            long id = dm.enqueue(req);
            if (name.endsWith(".apk")) {
                InstallAfterDownload recv = new InstallAfterDownload(act, dm, id);
                IntentFilter f = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
                if (Build.VERSION.SDK_INT >= 33) {
                    act.registerReceiver(recv, f, Context.RECEIVER_EXPORTED);
                } else {
                    act.registerReceiver(recv, f);
                }
            }
            GwLog.note(null, "分享页下载: " + name + " (" + contentLength + "B)");
        } catch (Exception e) {
            GwLog.note(null, "分享页下载失败: " + e);
        }
    }

    /** 从 URL / Content-Disposition 猜文件名（简单解析，避免正则转义坑）。 */
    static String guessFileName(String url, String cd) {
        String name = "";
        try {
            if (cd != null) {
                int i = cd.toLowerCase().indexOf("filename=");
                if (i >= 0) {
                    String rest = cd.substring(i + 9).trim();
                    if (rest.startsWith("\"")) {
                        int j = rest.indexOf('"', 1);
                        if (j > 1) name = rest.substring(1, j);
                    } else {
                        int j = rest.indexOf(';');
                        name = (j >= 0 ? rest.substring(0, j) : rest).trim();
                    }
                }
            }
            if (name.length() == 0 && url != null) {
                String p = url;
                int q = p.indexOf('?');
                if (q >= 0) p = p.substring(0, q);
                int i = p.lastIndexOf('/');
                if (i >= 0 && i + 1 < p.length()) name = p.substring(i + 1);
            }
        } catch (Exception ignored) { }
        if (name.length() == 0) name = "download.bin";
        return name;
    }
}

/** 下载完成后弹安装意图。 */
class InstallAfterDownload extends BroadcastReceiver {
    private final Activity act;
    private final DownloadManager dm;
    private final long id;

    InstallAfterDownload(Activity a, DownloadManager d, long i) { act = a; dm = d; id = i; }

    @Override
    public void onReceive(Context c, Intent i) {
        if (i.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1) != id) return;
        try {
            Uri uri = dm.getUriForDownloadedFile(id);
            Intent inst = new Intent(Intent.ACTION_VIEW);
            inst.setDataAndType(uri, "application/vnd.android.package-archive");
            inst.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            act.startActivity(inst);
        } catch (Exception e) {
            GwLog.note(null, "安装意图失败: " + e);
        }
        try { act.unregisterReceiver(this); } catch (Exception ignored) { }
    }
}
