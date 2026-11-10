package com.myco.phone;

import android.webkit.WebView;

/** 首帧后截屏任务(顶层类——R8 8.2.2-dev 对 JBR javac 内嵌类字节码 NPE,MainActivity 内任何
 *  内嵌/匿名/命名内部类都不行;顶层类+构造传参是唯一干净解法)。 */
public class SnapTask implements Runnable {
    private final MainActivity act;
    private final WebView web;
    public SnapTask(MainActivity a, WebView w) { act = a; web = w; }
    @Override public void run() {
        SelfSnap.snap(act, web);
        android.util.Log.i("myco-snap", "self-shot written");
    }
}
