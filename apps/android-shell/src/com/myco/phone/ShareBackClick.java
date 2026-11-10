package com.myco.phone;

/** 分享页标题栏的"返回"（顶层类——d8 8.2.2-dev 对匿名/内嵌类 NPE）。 */
public class ShareBackClick implements android.view.View.OnClickListener {
    private final ShareWebActivity act;
    public ShareBackClick(ShareWebActivity act) { this.act = act; }
    @Override public void onClick(android.view.View v) { act.goBack(); }
}
