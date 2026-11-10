package com.myco.phone;

/** UI 线程写的状态槽(顶层类——EnvServer 里不能再有内嵌)。 */
public class UiState {
    public volatile String url = "";
    public volatile String title = "";
}
