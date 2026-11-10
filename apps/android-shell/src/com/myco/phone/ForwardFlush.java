package com.myco.phone;

/** 顶层定时合包任务（D8/R8 不用匿名内嵌类）。 */
public class ForwardFlush implements Runnable {
    private final ForwardCallbacks owner;
    private final String key;

    public ForwardFlush(ForwardCallbacks owner, String key) {
        this.owner = owner;
        this.key = key;
    }

    @Override
    public void run() {
        owner.flush(key);
    }
}
