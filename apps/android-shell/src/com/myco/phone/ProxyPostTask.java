package com.myco.phone;

/** proxyPostAsync 的后台任务体（顶层类——d8 8.2.2-dev 对匿名/内嵌类 NPE，
 *  与 TunnelJsRun 同款纪律）。 */
public class ProxyPostTask implements Runnable {
    private final MainActivity act;
    private final String callbackJs;
    private final String urlString;
    private final String contentType;
    private final String authHeader;
    private final String body;

    public ProxyPostTask(MainActivity act, String callbackJs, String urlString, String contentType, String authHeader, String body) {
        this.act = act;
        this.callbackJs = callbackJs;
        this.urlString = urlString;
        this.contentType = contentType;
        this.authHeader = authHeader;
        this.body = body;
    }

    @Override public void run() {
        final String result = doHttpPost();
        act.web.post(new ProxyPostCallback(act, callbackJs, result));
    }

    String doHttpPost() {
        try {
            java.net.URL url = new java.net.URL(urlString);
            java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(10000);
            if (contentType != null && !contentType.isEmpty()) conn.setRequestProperty("Content-Type", contentType);
            if (authHeader != null && !authHeader.isEmpty()) conn.setRequestProperty("X-Myco-Auth", authHeader);
            byte[] out = body.getBytes("UTF-8");
            conn.setFixedLengthStreamingMode(out.length);
            java.io.OutputStream os = conn.getOutputStream();
            os.write(out);
            os.close();
            int status = conn.getResponseCode();
            java.io.BufferedReader reader;
            if (status >= 200 && status < 300) reader = new java.io.BufferedReader(new java.io.InputStreamReader(conn.getInputStream(), "UTF-8"));
            else reader = new java.io.BufferedReader(new java.io.InputStreamReader(conn.getErrorStream() != null ? conn.getErrorStream() : conn.getInputStream(), "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
            reader.close();
            conn.disconnect();
            return "{\"status\":" + status + ",\"body\":" + org.json.JSONObject.quote(sb.toString()) + "}";
        } catch (Exception e) {
            return "{\"status\":0,\"body\":" + org.json.JSONObject.quote(String.valueOf(e.getMessage())) + "}";
        }
    }
}
