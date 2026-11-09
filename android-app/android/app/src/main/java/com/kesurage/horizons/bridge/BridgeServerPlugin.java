package com.kesurage.horizons.bridge;

import android.content.Context;
import android.content.SharedPreferences;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import fi.iki.elonen.NanoHTTPD;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Horizons "Agent Bridge" plugin.
 *
 * Turns the app into a small HTTP server (on the device) that an external
 * AI agent can drive with an access token — the "remote BYOK agent" design:
 *
 *   1. The user presses Start in the AI panel.
 *   2. This plugin binds a NanoHTTPD server on 0.0.0.0:<port> (LAN reachable)
 *      and serves a token-protected REST API.
 *   3. Every request is forwarded to the WebView (event "bridgeRequest"),
 *      where the editor's JavaScript handles it with full access to the
 *      opened project — reading events, writing events/objects, saving, ...
 *      The JS answer comes back through the "respond" plugin method.
 *   4. Optionally, a public tunnel (localtunnel protocol, no account, no
 *      keys) exposes the same API on a public HTTPS URL so a cloud agent
 *      can reach the device.
 *
 * No AI API keys are needed anywhere: the agent on the other side brings
 * its own intelligence, the app just exposes its workflow.
 */
@CapacitorPlugin(name = "BridgeServer")
public class BridgeServerPlugin extends Plugin {

    public static final String EVENT_REQUEST = "bridgeRequest";
    public static final String EVENT_TUNNEL = "tunnelEvent";

    private static final String PREFS_NAME = "HorizonsAgentBridge";
    private static final String PREF_TOKEN = "bridgeToken";
    private static final int REQUEST_TIMEOUT_SECONDS = 180;
    private static final int DEFAULT_PORT = 8090;

    private BridgeHttpServer server;
    private LocalTunnelTunnel tunnel;
    private String token;
    private int boundPort = 0;
    private boolean keepScreenOn = false;
    private long startedAt = 0;
    private long requestsServed = 0;

    private final Map<String, CompletableFuture<JSObject>> pendingRequests =
            new ConcurrentHashMap<>();
    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    @Override
    public void load() {
        super.load();
        try {
            SharedPreferences prefs = getContext()
                    .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            token = prefs.getString(PREF_TOKEN, null);
        } catch (Exception ignored) {
            token = null;
        }
    }

    private String ensureToken() {
        if (token == null || token.length() < 10) {
            SecureRandom random = new SecureRandom();
            byte[] bytes = new byte[24];
            random.nextBytes(bytes);
            StringBuilder hex = new StringBuilder("hz_");
            for (byte b : bytes) {
                hex.append(String.format("%02x", b));
            }
            token = hex.toString();
            try {
                SharedPreferences prefs = getContext()
                        .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                prefs.edit().putString(PREF_TOKEN, token).apply();
            } catch (Exception ignored) {
                // Best effort persistence: the token stays valid for the session.
            }
        }
        return token;
    }

    // ------------------------------------------------------------------
    // Plugin methods (called from the WebView)
    // ------------------------------------------------------------------

    @PluginMethod
    public void start(PluginCall call) {
        int wantedPort = DEFAULT_PORT;
        try {
            Double portOption = call.getDouble("port");
            if (portOption != null) {
                wantedPort = portOption.intValue();
            }
        } catch (Exception ignored) {
            // Keep the default port.
        }

        if (server != null) {
            call.resolve(getStateObject());
            return;
        }

        ensureToken();

        // Try the wanted port, then the next few ones in case one is taken.
        BridgeHttpServer started = null;
        int usedPort = 0;
        IOException lastError = null;
        for (int attempt = 0; attempt < 6; attempt++) {
            int candidatePort = wantedPort + attempt;
            BridgeHttpServer candidate = new BridgeHttpServer(candidatePort);
            try {
                candidate.start(NanoHTTPD.SOCKET_READ_TIMEOUT, true);
                started = candidate;
                usedPort = candidatePort;
                break;
            } catch (IOException e) {
                lastError = e;
            }
        }
        if (started == null) {
            String message = lastError == null
                    ? "Could not bind the bridge server"
                    : "Could not bind the bridge server: " + lastError.getMessage();
            JSObject result = new JSObject();
            result.put("ok", false);
            result.put("error", message);
            call.resolve(result);
            return;
        }

        server = started;
        boundPort = usedPort;
        startedAt = System.currentTimeMillis();
        requestsServed = 0;
        setKeepScreenOn(true);

        JSObject result = getStateObject();
        result.put("ok", true);
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopTunnelInternal();
        if (server != null) {
            server.closeAllConnections();
            server.stop();
            server = null;
        }
        boundPort = 0;
        startedAt = 0;
        setKeepScreenOn(false);
        // Fail anything still pending so clients get an answer.
        for (Map.Entry<String, CompletableFuture<JSObject>> entry
                : pendingRequests.entrySet()) {
            JSObject timeout = new JSObject();
            timeout.put("status", 503);
            timeout.put("body", "{\"ok\":false,\"error\":\"bridge stopped\"}");
            entry.getValue().complete(timeout);
        }
        pendingRequests.clear();
        call.resolve(getStateObject());
    }

    @PluginMethod
    public void respond(PluginCall call) {
        String id = call.getString("id");
        Integer status = call.getInt("status");
        String body = call.getString("body");
        if (id == null) {
            call.reject("Missing id");
            return;
        }
        CompletableFuture<JSObject> future = pendingRequests.remove(id);
        if (future != null) {
            JSObject result = new JSObject();
            result.put("status", status == null ? 200 : status);
            result.put("body", body == null ? "{}" : body);
            future.complete(result);
        }
        call.resolve();
    }

    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(getStateObject());
    }

    @PluginMethod
    public void startTunnel(PluginCall call) {
        String serverBase = call.getString("server");
        String wantedSubdomain = call.getString("subdomain");
        if (serverBase == null || serverBase.trim().isEmpty()) {
            serverBase = "https://localtunnel.me";
        }
        if (wantedSubdomain == null || wantedSubdomain.trim().isEmpty()) {
            wantedSubdomain = "horizons-" + randomHex(6);
        }
        if (server == null) {
            call.reject("Start the bridge first");
            return;
        }
        if (tunnel != null && tunnel.isActive()) {
            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("url", tunnel.getPublicUrl());
            result.put("subdomain", tunnel.getSubdomain());
            call.resolve(result);
            return;
        }

        final String base = serverBase;
        final String subdomain = wantedSubdomain;
        final int localPort = boundPort;

        tunnel = new LocalTunnelTunnel(base, subdomain, localPort);
        networkExecutor.submit(() -> tunnel.start());

        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("subdomain", subdomain);
        result.put("pending", true);
        call.resolve(result);
    }

    @PluginMethod
    public void stopTunnel(PluginCall call) {
        stopTunnelInternal();
        call.resolve(getStateObject());
    }

    private void stopTunnelInternal() {
        if (tunnel != null) {
            tunnel.stop();
            tunnel = null;
        }
    }

    // ------------------------------------------------------------------
    // State helpers
    // ------------------------------------------------------------------

    private JSObject getStateObject() {
        JSObject state = new JSObject();
        state.put("running", server != null);
        state.put("port", boundPort);
        state.put("token", token == null ? "" : token);
        List<String> urls = new ArrayList<>();
        if (server != null) {
            urls.addAll(getLanUrls());
        }
        state.put("urls", urls);
        state.put("startedAt", startedAt);
        state.put("requestsServed", requestsServed);
        JSObject tunnelState = new JSObject();
        if (tunnel != null) {
            tunnelState.put("active", tunnel.isActive());
            tunnelState.put("url", tunnel.getPublicUrl());
            tunnelState.put("subdomain", tunnel.getSubdomain());
            tunnelState.put("server", tunnel.getServerBase());
        } else {
            tunnelState.put("active", false);
            tunnelState.put("url", "");
            tunnelState.put("subdomain", "");
            tunnelState.put("server", "");
        }
        state.put("tunnel", tunnelState);
        return state;
    }

    private List<String> getLanUrls() {
        List<String> urls = new ArrayList<>();
        try {
            List<NetworkInterface> interfaces = Collections.list(
                    NetworkInterface.getNetworkInterfaces());
            for (NetworkInterface networkInterface : interfaces) {
                if (!networkInterface.isUp() || networkInterface.isLoopback()) {
                    continue;
                }
                List<InetAddress> addresses = Collections.list(
                        networkInterface.getInetAddresses());
                for (InetAddress address : addresses) {
                    if (address.isLoopbackAddress() || address.isMulticastAddress()) {
                        continue;
                    }
                    String hostAddress = address.getHostAddress();
                    if (hostAddress == null || hostAddress.contains(":")) {
                        // Keep IPv4 only, the WebView and curl both like it.
                        continue;
                    }
                    urls.add("http://" + hostAddress + ":" + boundPort);
                }
            }
        } catch (Exception ignored) {
            // Best effort: fall back to the loopback address.
        }
        if (urls.isEmpty() && boundPort > 0) {
            urls.add("http://127.0.0.1:" + boundPort);
        }
        return urls;
    }

    private void setKeepScreenOn(final boolean enabled) {
        try {
            final android.app.Activity activity = getActivity();
            if (activity == null) {
                return;
            }
            keepScreenOn = enabled;
            activity.runOnUiThread(() -> {
                try {
                    if (keepScreenOn) {
                        activity.getWindow()
                                .addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    } else {
                        activity.getWindow()
                                .clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    }
                } catch (Exception ignored) {
                    // The activity may be gone.
                }
            });
        } catch (Exception ignored) {
            // No activity — nothing to do.
        }
    }

    private static String randomHex(int characterCount) {
        SecureRandom random = new SecureRandom();
        StringBuilder hex = new StringBuilder();
        while (hex.length() < characterCount) {
            hex.append(String.format("%02x", random.nextInt(256)));
        }
        return hex.substring(0, characterCount);
    }

    // ------------------------------------------------------------------
    // HTTP server
    // ------------------------------------------------------------------

    private class BridgeHttpServer extends NanoHTTPD {

        BridgeHttpServer(int port) {
            super(port);
        }

        @Override
        public Response serve(IHTTPSession session) {
            Method method = session.getMethod();
            String uri = session.getUri() == null ? "/" : session.getUri();

            // CORS: any agent (browser extension, curl, web tool) may call us.
            if (method == Method.OPTIONS) {
                Response response = newFixedLengthResponse(
                        Response.Status.NO_CONTENT, "application/json", "");
                return withCors(response);
            }

            // Unauthenticated heartbeat so anyone can check the bridge is alive.
            if (uri.equals("/health")) {
                Response response = newFixedLengthResponse(Response.Status.OK,
                        "application/json",
                        "{\"ok\":true,\"app\":\"Horizons\",\"bridge\":\"1\"}");
                return withCors(response);
            }

            if (!isAuthorized(session)) {
                return withCors(jsonResponse(401,
                        "{\"ok\":false,\"error\":\"Unauthorized. Pass the bridge token "
                                + "as 'Authorization: Bearer <token>' or '?token=<token>'.\"}"));
            }

            // Read the request body (POST/PUT) before anything else.
            String body = "";
            try {
                Map<String, String> files = new HashMap<>();
                session.parseBody(files);
                String postData = files.get("postData");
                if (postData != null) {
                    body = postData;
                }
            } catch (Exception ignored) {
                // GET requests and malformed bodies simply have no body.
            }

            requestsServed++;

            // Forward the request to the WebView and wait for its answer.
            String id = UUID.randomUUID().toString();
            CompletableFuture<JSObject> future = new CompletableFuture<>();
            pendingRequests.put(id, future);

            JSObject payload = new JSObject();
            payload.put("id", id);
            payload.put("method", method.name());
            payload.put("path", uri);
            payload.put("query", session.getQueryParameterString() == null
                    ? "" : session.getQueryParameterString());
            payload.put("body", body);
            try {
                notifyListeners(EVENT_REQUEST, payload);
            } catch (Exception ignored) {
                // If the WebView is gone, the timeout below answers the client.
            }

            try {
                JSObject result = future.get(
                        REQUEST_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                Integer status = result.getInt("status");
                String responseBody = result.getString("body");
                if (responseBody == null) {
                    responseBody = "{}";
                }
                Response.Status nanoStatus = Response.Status.lookup(
                        status == null ? 200 : status);
                if (nanoStatus == null) {
                    nanoStatus = Response.Status.OK;
                }
                return withCors(newFixedLengthResponse(
                        nanoStatus, "application/json", responseBody));
            } catch (TimeoutException e) {
                pendingRequests.remove(id);
                return withCors(jsonResponse(504,
                        "{\"ok\":false,\"error\":\"The app did not answer in time "
                                + "(it may be busy or in the background).\"}"));
            } catch (Exception e) {
                pendingRequests.remove(id);
                return withCors(jsonResponse(500,
                        "{\"ok\":false,\"error\":\"Bridge error: "
                                + jsonEscape(e.getMessage()) + "\"}"));
            }
        }

        private boolean isAuthorized(IHTTPSession session) {
            String provided = null;
            try {
                Map<String, String> headers = session.getHeaders();
                String authorization = headers.get("authorization");
                if (authorization == null) {
                    authorization = headers.get("Authorization");
                }
                if (authorization != null && authorization.toLowerCase().startsWith("bearer ")) {
                    provided = authorization.substring(7).trim();
                }
                if (provided == null) {
                    provided = headers.get("x-bridge-token");
                }
                if (provided == null) {
                    provided = headers.get("X-Bridge-Token");
                }
            } catch (Exception ignored) {
                // Fall through to the query parameter.
            }
            if (provided == null) {
                try {
                    Map<String, List<String>> parameters = session.getParameters();
                    List<String> tokenParameter = parameters.get("token");
                    if (tokenParameter != null && !tokenParameter.isEmpty()) {
                        provided = tokenParameter.get(0);
                    }
                } catch (Exception ignored) {
                    // No query token.
                }
            }
            if (provided == null || token == null) {
                return false;
            }
            return constantTimeEquals(provided, token);
        }

        private Response jsonResponse(int status, String body) {
            Response.Status nanoStatus = Response.Status.lookup(status);
            if (nanoStatus == null) {
                nanoStatus = Response.Status.OK;
            }
            return newFixedLengthResponse(nanoStatus, "application/json", body);
        }

        private Response withCors(Response response) {
            response.addHeader("Access-Control-Allow-Origin", "*");
            response.addHeader("Access-Control-Allow-Methods",
                    "GET, POST, PUT, DELETE, OPTIONS");
            response.addHeader("Access-Control-Allow-Headers",
                    "Authorization, Content-Type, X-Bridge-Token");
            return response;
        }
    }

    private static boolean constantTimeEquals(String a, String b) {
        try {
            return MessageDigest.isEqual(
                    a.getBytes(StandardCharsets.UTF_8),
                    b.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            return false;
        }
    }

    private static String jsonEscape(String value) {
        if (value == null) {
            return "unknown error";
        }
        return value.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", " ").replace("\r", " ");
    }

    // ------------------------------------------------------------------
    // Public tunnel (localtunnel protocol — no account, no key)
    // ------------------------------------------------------------------

    /**
     * A minimal localtunnel client:
     *  1. GET https://<server>/<subdomain> → { id, ip, port, url, max_conn_count }
     *  2. Keep N raw TCP sockets open to (ip, port); the server pipes HTTP
     *     request bytes into them and expects HTTP response bytes back.
     *     We just bridge each socket to 127.0.0.1:<localPort>.
     */
    private class LocalTunnelTunnel {

        private final String serverBase;
        private final String subdomain;
        private final int localPort;
        private volatile boolean active = false;
        private volatile String publicUrl = "";
        private final List<Socket> sockets = new ArrayList<>();

        LocalTunnelTunnel(String serverBase, String subdomain, int localPort) {
            this.serverBase = serverBase;
            this.subdomain = subdomain;
            this.localPort = localPort;
        }

        boolean isActive() {
            return active;
        }

        String getPublicUrl() {
            return publicUrl;
        }

        String getSubdomain() {
            return subdomain;
        }

        String getServerBase() {
            return serverBase;
        }

        void start() {
            emitTunnelEvent("registering", "",
                    "Registering " + subdomain + " on " + serverBase + "…");
            try {
                URL url = new URL(serverBase + "/" + subdomain);
                HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(20000);
                connection.setRequestProperty("Accept", "application/json");
                connection.setRequestProperty("User-Agent", "Horizons/0.3.0");
                int status = connection.getResponseCode();
                String responseBody = readStream(
                        status >= 400 ? connection.getErrorStream() : connection.getInputStream());
                if (status != 200) {
                    emitTunnelEvent("error", "",
                            "Tunnel server refused (" + status + "): "
                                    + truncate(responseBody, 200));
                    return;
                }
                String tunnelUrl = extractJsonString(responseBody, "url");
                String ip = extractJsonString(responseBody, "ip");
                String portText = extractJsonString(responseBody, "port");
                String maxConnText = extractJsonString(responseBody, "max_conn_count");
                if (tunnelUrl == null || portText == null) {
                    emitTunnelEvent("error", "",
                            "Unexpected tunnel server answer: "
                                    + truncate(responseBody, 200));
                    return;
                }
                publicUrl = tunnelUrl;
                int remotePort = Integer.parseInt(portText.trim());
                int socketCount = 1;
                try {
                    socketCount = Math.max(1, Math.min(3,
                            Integer.parseInt(maxConnText.trim())));
                } catch (Exception ignored) {
                    // Keep one socket.
                }
                String remoteHost = (ip != null && !ip.trim().isEmpty())
                        ? ip.trim() : new URL(serverBase).getHost();

                active = true;
                emitTunnelEvent("registered", publicUrl,
                        "Public URL: " + publicUrl);

                // Supervisor: keep the tunnel sockets alive while active.
                Thread supervisor = new Thread(() -> {
                    while (active) {
                        int live = 0;
                        synchronized (sockets) {
                            List<Socket> dead = new ArrayList<>();
                            for (Socket socket : sockets) {
                                if (socket.isClosed() || !socket.isConnected()) {
                                    dead.add(socket);
                                } else {
                                    live++;
                                }
                            }
                            sockets.removeAll(dead);
                        }
                        for (int i = live; i < socketCount && active; i++) {
                            openTunnelSocket(remoteHost, remotePort);
                            try {
                                Thread.sleep(500);
                            } catch (InterruptedException e) {
                                Thread.currentThread().interrupt();
                                return;
                            }
                        }
                        try {
                            Thread.sleep(3000);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                            return;
                        }
                    }
                });
                supervisor.setDaemon(true);
                supervisor.setName("bridge-tunnel-supervisor");
                supervisor.start();
            } catch (Exception e) {
                emitTunnelEvent("error", "",
                        "Tunnel error: " + e.getMessage());
            }
        }

        private void openTunnelSocket(String remoteHost, int remotePort) {
            try {
                final Socket remote = new Socket();
                remote.connect(new java.net.InetSocketAddress(remoteHost, remotePort), 15000);
                remote.setKeepAlive(true);
                remote.setTcpNoDelay(true);
                synchronized (sockets) {
                    sockets.add(remote);
                }

                Thread connector = new Thread(() -> {
                    Socket local = null;
                    try {
                        local = new Socket("127.0.0.1", localPort);
                        final Socket finalLocal = local;
                        Thread toLocal = new Thread(() -> pipe(remote, finalLocal));
                        Thread toRemote = new Thread(() -> pipe(finalLocal, remote));
                        toLocal.setDaemon(true);
                        toRemote.setDaemon(true);
                        toLocal.start();
                        toRemote.start();
                    } catch (Exception e) {
                        try {
                            remote.close();
                        } catch (Exception ignored) {
                        }
                        if (local != null) {
                            try {
                                local.close();
                            } catch (Exception ignored) {
                            }
                        }
                    }
                });
                connector.setDaemon(true);
                connector.start();
            } catch (Exception e) {
                emitTunnelEvent("warning", publicUrl,
                        "Tunnel socket error: " + e.getMessage());
            }
        }

        private void pipe(Socket from, Socket to) {
            try {
                InputStream input = from.getInputStream();
                OutputStream output = to.getOutputStream();
                byte[] buffer = new byte[16384];
                int read;
                while ((read = input.read(buffer)) >= 0) {
                    if (read > 0) {
                        output.write(buffer, 0, read);
                        output.flush();
                    }
                }
            } catch (Exception ignored) {
                // Socket closed — the supervisor re-opens it.
            } finally {
                try {
                    from.close();
                } catch (Exception ignored) {
                }
                try {
                    to.close();
                } catch (Exception ignored) {
                }
            }
        }

        void stop() {
            active = false;
            synchronized (sockets) {
                for (Socket socket : sockets) {
                    try {
                        socket.close();
                    } catch (Exception ignored) {
                    }
                }
                sockets.clear();
            }
            emitTunnelEvent("closed", "", "Public tunnel closed.");
        }

        private String readStream(InputStream stream) throws IOException {
            if (stream == null) {
                return "";
            }
            BufferedReader reader = new BufferedReader(
                    new InputStreamReader(stream, StandardCharsets.UTF_8));
            StringBuilder builder = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                builder.append(line);
            }
            return builder.toString();
        }

        private String truncate(String text, int maxLength) {
            if (text == null) {
                return "";
            }
            return text.length() <= maxLength ? text : text.substring(0, maxLength) + "…";
        }
    }

    private void emitTunnelEvent(String phase, String url, String message) {
        try {
            JSObject event = new JSObject();
            event.put("phase", phase);
            event.put("url", url == null ? "" : url);
            event.put("message", message == null ? "" : message);
            notifyListeners(EVENT_TUNNEL, event);
        } catch (Exception ignored) {
            // The WebView may not be ready — events are best effort.
        }
    }

    /** Extracts a top-level string field from a flat JSON object. */
    private static String extractJsonString(String json, String field) {
        if (json == null) {
            return null;
        }
        String needle = "\"" + field + "\"";
        int fieldIndex = json.indexOf(needle);
        if (fieldIndex < 0) {
            return null;
        }
        int colonIndex = json.indexOf(':', fieldIndex + needle.length());
        if (colonIndex < 0) {
            return null;
        }
        int quoteIndex = json.indexOf('"', colonIndex + 1);
        if (quoteIndex < 0) {
            // Number or boolean — return the raw token.
            int end = colonIndex + 1;
            while (end < json.length()) {
                char c = json.charAt(end);
                if (c == ',' || c == '}' || c == ']') {
                    break;
                }
                end++;
            }
            return json.substring(colonIndex + 1, end).trim();
        }
        int endIndex = json.indexOf('"', quoteIndex + 1);
        if (endIndex < 0) {
            return null;
        }
        return json.substring(quoteIndex + 1, endIndex);
    }
}
