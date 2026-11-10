package com.myco.phone;

import java.io.IOException;
import java.net.ServerSocket;
import java.net.Socket;

/** 服务循环(顶层类——R8 对内嵌类 NPE,EnvServer 里不能套)。 */
public class EnvLoop implements Runnable {
    private final EnvServer srv;
    private final ServerSocket ss;
    public EnvLoop(EnvServer srv, ServerSocket ss) { this.srv = srv; this.ss = ss; }
    @Override public void run() {
        while (true) {
            try {
                Socket c = ss.accept();
                new Thread(new EnvHandler(srv, c)).start();
            } catch (IOException ignored) { break; }
        }
    }
}
