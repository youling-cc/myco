package com.myco.phone;

import android.webkit.WebView;
import android.webkit.WebViewClient;

/** WebViewClient 带页载完成自截屏(顶层类——MainActivity 里任何内嵌类都让 R8 NPE,
 *  这套只能平铺成顶层)。 */
public class SnapClient extends WebViewClient {
    private final MainActivity act;
    public SnapClient(MainActivity a) { act = a; }
    @Override public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);
        SelfSnap.snap(act, view);
    }
}
