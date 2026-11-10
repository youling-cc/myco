package com.myco.phone;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/** 单连接处理器(顶层类)。 */
public class EnvHandler implements Runnable {
    private final EnvServer srv;
    private final Socket c;
    public EnvHandler(EnvServer srv, Socket c) { this.srv = srv; this.c = c; }
    @Override public void run() {
        try {
            InputStream in = c.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] tmp = new byte[4096];
            int n; int total = 0; int contentLen = 0; int headEnd = -1;
            while ((n = in.read(tmp)) > 0) {
                buf.write(tmp, 0, n);
                total += n;
                String s = buf.toString("UTF-8");
                if (headEnd < 0) {
                    int i = s.indexOf("\r\n\r\n");
                    if (i >= 0) {
                        headEnd = i + 4;
                        java.util.regex.Matcher m = java.util.regex.Pattern.compile("Content-Length: (\\d+)", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(s.substring(0, i));
                        if (m.find()) contentLen = Integer.parseInt(m.group(1));
                    }
                }
                if (headEnd > 0 && total >= headEnd + contentLen) break;
                if (total > 65536) break;
            }
            String raw = buf.toString("UTF-8");
            int sp = raw.indexOf(' ');
            String method = sp > 0 ? raw.substring(0, sp) : "GET";
            int sp2 = raw.indexOf(' ', sp + 1);
            String path = sp2 > 0 ? raw.substring(sp + 1, sp2) : "/";
            String body = headEnd > 0 ? raw.substring(headEnd, Math.min(raw.length(), headEnd + contentLen)) : "";
            String out;
            int status = 200;
            try {
                if ("GET".equals(method) && path.startsWith("/api/state")) {
                    out = srv.stateJson();
                } else if ("POST".equals(method) && path.startsWith("/api/intent")) {
                    out = srv.intent(body);
                } else if ("POST".equals(method) && path.startsWith("/api/cli")) {
                    // CLI 通道(2026-09-23):body {cmd:"identity did"}——词表同 myco-ubuntu cli.rs
                    out = srv.cli(body);
                } else {
                    out = "{\"ok\":false,\"err\":\"not found\"}";
                    status = 404;
                }
            } catch (Exception e) {
                out = "{\"ok\":false,\"err\":\"" + srv.esc(e.getMessage()) + "\"}";
                status = 500;
            }
            String http = "HTTP/1.1 " + status + " OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: " + out.getBytes(StandardCharsets.UTF_8).length + "\r\nConnection: close\r\n\r\n" + out;
            OutputStream os = c.getOutputStream();
            os.write(http.getBytes(StandardCharsets.UTF_8));
            os.flush();
        } catch (Exception ignored) {
        } finally { try { c.close(); } catch (IOException ignored) { } }
    }
}
