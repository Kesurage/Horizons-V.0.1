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

import org.eclipse.paho.client.mqttv3.IMqttDeliveryToken;
import org.eclipse.paho.client.mqttv3.MqttAsyncClient;
import org.eclipse.paho.client.mqttv3.MqttCallbackExtended;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;

import java.io.IOException;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeoutException;

import javax.net.ssl.SSLSocketFactory;

/**
 * Horizons "Agent Bridge" plugin.
 *
 * Lets an external AI agent drive the app with an access token — WITHOUT any
 * inbound network access to the phone (the old localtunnel approach is dead:
 * the service now refuses registrations with 403, and inbound tunnels are
 * blocked on most mobile networks anyway).
 *
 * The new "relay" design is outbound-only:
 *
 *   1. The user presses Start in the Agent Bridge panel.
 *   2. The plugin connects OUT to a public MQTT-over-WebSocket broker
 *      (broker.emqx.io, fallback broker.hivemq.com — no account, no key,
 *      plain TLS ports that every mobile network allows).
 *   3. Commands from the agent arrive on  hz/<id>/cmd   as JSON:
 *          {"id":"...","token":"hz_...","method":"GET","path":"/",
 *           "query":"","body":""}
 *      The token is checked in constant time; the request is then forwarded
 *      to the WebView (event "bridgeRequest") exactly like the HTTP server
 *      does, and the JS answer comes back through the "respond" plugin
 *      method. The answer is published on  hz/<id>/evt  as JSON:
 *          {"id":"...","status":200,"body":"{...}"}
 *   4. Presence is advertised on  hz/<id>/status  (retained, refreshed every
 *      20s, with a Last-Will that flips it offline when the app dies).
 *   5. A local NanoHTTPD server on 0.0.0.0:<port> is ALSO started, best
 *      effort, so a device on the same Wi-Fi can use plain HTTP with the
 *      same token. If binding fails, that is NOT fatal — the relay still
 *      works on any network.
 */
@CapacitorPlugin(name = "BridgeServer")
public class BridgeServerPlugin extends Plugin {

    public static final String EVENT_REQUEST = "bridgeRequest";
    public static final String EVENT_RELAY = "relayEvent";

    private static final String PREFS_NAME = "HorizonsAgentBridge";
    private static final String PREF_TOKEN = "bridgeToken";
    private static final String PREF_RELAY_ID = "relayId";
    private static final int REQUEST_TIMEOUT_SECONDS = 180;
    private static final int DEFAULT_PORT = 8090;
    private static final String APP_VERSION = "0.3.1";

    /** Public relay brokers, tried in order (no account, no key).
     * MQTT over WebSocket + TLS: outbound-only, works on mobile data. */
    private static final String[] RELAY_BROKERS = {
        "wss://broker.emqx.io:8084/mqtt",
        "wss://broker.hivemq.com:8884/mqtt",
    };

    private BridgeHttpServer server;
    private MqttRelay relay;
    private String token;
    private String relayId;
    private int boundPort = 0;
    private String localServerError = "";
    private boolean keepScreenOn = false;
    private long startedAt = 0;
    private long requestsServed = 0;

    private final Map<String, CompletableFuture<JSObject>> pendingRequests =
            new ConcurrentHashMap<>();
    /** Internal request id -> agent correlation id (relay commands only). */
    private final Map<String, String> relayCorrelations = new ConcurrentHashMap<>();
    /** Internal request id -> deadline (ms) for the watchdog (relay only). */
    private final Map<String, Long> relayDeadlines = new ConcurrentHashMap<>();
    /** Recently seen agent command ids (MQTT QoS 1 may redeliver). */
    private final Set<String> recentCommandIds =
            Collections.synchronizedSet(new LinkedHashSet<String>());

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
            relayId = prefs.getString(PREF_RELAY_ID, null);
        } catch (Exception ignored) {
            token = null;
            relayId = null;
        }
    }

    private String ensureToken() {
        if (token == null || token.length() < 10) {
            token = "hz_" + randomHex(24);
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

    private String ensureRelayId() {
        if (relayId == null || relayId.length() < 8) {
            relayId = randomHex(16);
            try {
                SharedPreferences prefs = getContext()
                        .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                prefs.edit().putString(PREF_RELAY_ID, relayId).apply();
            } catch (Exception ignored) {
                // Best effort persistence.
            }
        }
        return relayId;
    }

    // ------------------------------------------------------------------
    // Plugin methods (called from the WebView)
    // ------------------------------------------------------------------

    /**
     * Starts the bridge session: the relay connection (primary, works
     * everywhere) and the local HTTP server (best effort, LAN only).
     * A local bind failure is NOT fatal — it is reported in the state.
     */
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

        if (server != null || relay != null) {
            call.resolve(getStateObject());
            return;
        }

        ensureToken();
        ensureRelayId();
        startedAt = System.currentTimeMillis();
        requestsServed = 0;
        localServerError = "";
        setKeepScreenOn(true);

        // --- Local HTTP server: best effort (LAN access on the same Wi-Fi).
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
        if (started != null) {
            server = started;
            boundPort = usedPort;
        } else {
            localServerError = lastError == null
                    ? "Could not bind the local server"
                    : "Could not bind the local server: " + lastError.getMessage();
        }

        // --- Relay: the primary connection (outbound, no account).
        startRelayInternal();

        JSObject result = getStateObject();
        result.put("ok", true);
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopRelayInternal();
        if (server != null) {
            server.closeAllConnections();
            server.stop();
            server = null;
        }
        boundPort = 0;
        startedAt = 0;
        localServerError = "";
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
        relayCorrelations.clear();
        relayDeadlines.clear();
        call.resolve(getStateObject());
    }

    /** The WebView's answer to a forwarded request (HTTP or relay). */
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

    /** Manually (re)connect the relay — also automatic on start(). */
    @PluginMethod
    public void startRelay(PluginCall call) {
        if (relay != null && relay.isWanted()) {
            call.resolve(getStateObject());
            return;
        }
        ensureToken();
        ensureRelayId();
        startedAt = startedAt == 0 ? System.currentTimeMillis() : startedAt;
        startRelayInternal();
        JSObject result = getStateObject();
        result.put("ok", true);
        call.resolve(result);
    }

    @PluginMethod
    public void stopRelay(PluginCall call) {
        stopRelayInternal();
        call.resolve(getStateObject());
    }

    private void startRelayInternal() {
        if (relay != null && relay.isWanted()) {
            return;
        }
        final MqttRelay newRelay = new MqttRelay();
        relay = newRelay;
        networkExecutor.submit(new Runnable() {
            @Override
            public void run() {
                newRelay.start();
            }
        });
    }

    private void stopRelayInternal() {
        final MqttRelay current = relay;
        relay = null;
        if (current != null) {
            networkExecutor.submit(new Runnable() {
                @Override
                public void run() {
                    current.stop();
                }
            });
        }
    }

    // ------------------------------------------------------------------
    // State helpers
    // ------------------------------------------------------------------

    private JSObject getStateObject() {
        JSObject state = new JSObject();
        state.put("running", server != null || relay != null);
        state.put("port", boundPort);
        state.put("token", token == null ? "" : token);
        List<String> urls = new ArrayList<>();
        if (server != null) {
            urls.addAll(getLanUrls());
        }
        state.put("urls", urls);
        state.put("localServerError", localServerError);
        state.put("startedAt", startedAt);
        state.put("requestsServed", requestsServed);
        JSObject relayState = new JSObject();
        if (relay != null) {
            relayState.put("wanted", relay.isWanted());
            relayState.put("active", relay.isOnline());
            relayState.put("connecting", relay.isWanted() && !relay.isOnline());
            relayState.put("broker", relay.getActiveBroker());
            relayState.put("topic", relay.getTopicBase());
            relayState.put("lastError", relay.getLastError());
        } else {
            relayState.put("wanted", false);
            relayState.put("active", false);
            relayState.put("connecting", false);
            relayState.put("broker", "");
            relayState.put("topic", relayId == null ? "" : "hz/" + relayId);
            relayState.put("lastError", "");
        }
        state.put("relay", relayState);
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
            activity.runOnUiThread(new Runnable() {
                @Override
                public void run() {
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

    private static boolean constantTimeEquals(String a, String b) {
        if (a == null || b == null) {
            return false;
        }
        try {
            return MessageDigest.isEqual(
                    a.getBytes(StandardCharsets.UTF_8),
                    b.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            return false;
        }
    }

    // ------------------------------------------------------------------
    // Local HTTP server (LAN access, best effort)
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
                        REQUEST_TIMEOUT_SECONDS, java.util.concurrent.TimeUnit.SECONDS);
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

    // ------------------------------------------------------------------
    // Relay: public MQTT-over-WebSocket broker (outbound only)
    // ------------------------------------------------------------------

    /**
     * Owns the MQTT connection to a public broker. The protocol on the wire:
     *
     *   hz/<id>/cmd     agent -> app    {"id","token","method","path","query","body"}
     *   hz/<id>/evt     app  -> agent   {"id","status","body"}
     *   hz/<id>/status  app  -> agent   retained {"online":true/false, ...}
     *
     * Paho's automatic reconnect cycles through the broker list; on every
     * (re)connect we resubscribe and refresh the retained status.
     */
    private class MqttRelay implements MqttCallbackExtended {

        private volatile boolean wanted = false;
        private volatile boolean online = false;
        private volatile String activeBroker = "";
        private volatile String lastError = "";
        private MqttAsyncClient client;
        private Thread heartbeatThread;
        private final Object clientLock = new Object();

        String getTopicBase() {
            return "hz/" + (relayId == null ? "" : relayId);
        }

        boolean isWanted() {
            return wanted;
        }

        boolean isOnline() {
            return online;
        }

        String getActiveBroker() {
            return activeBroker;
        }

        String getLastError() {
            return lastError;
        }

        void start() {
            synchronized (clientLock) {
                if (wanted || client != null) {
                    return;
                }
                wanted = true;
                final String topicBase = getTopicBase();
                emitRelayEvent("connecting", "", topicBase,
                        "Connecting to the relay (broker.emqx.io)…");
                try {
                    MqttConnectOptions options = new MqttConnectOptions();
                    options.setServerURIs(RELAY_BROKERS);
                    options.setCleanSession(true);
                    options.setAutomaticReconnect(true);
                    options.setKeepAliveInterval(30);
                    options.setConnectionTimeout(15);
                    options.setMaxReconnectDelay(30000);
                    options.setSocketFactory(
                            (SSLSocketFactory) SSLSocketFactory.getDefault());
                    options.setWill(topicBase + "/status",
                            statusJson(false, "connection lost").getBytes(
                                    StandardCharsets.UTF_8),
                            1, true);

                    client = new MqttAsyncClient(
                            RELAY_BROKERS[0],
                            "horizons-" + (relayId == null ? randomHex(8) : relayId),
                            new MemoryPersistence());
                    client.setCallback(this);
                    client.connect(options);
                    // connectComplete(...) fires when it is up.
                } catch (Exception e) {
                    lastError = String.valueOf(e.getMessage());
                    client = null;
                    wanted = false;
                    emitRelayEvent("error", "", topicBase,
                            "Relay connection error: " + lastError);
                }
            }
        }

        void stop() {
            wanted = false;
            online = false;
            stopHeartbeat();
            final String topicBase = getTopicBase();
            synchronized (clientLock) {
                if (client != null) {
                    // Graceful offline status (retained) before disconnecting.
                    try {
                        publishRetained(client, topicBase + "/status",
                                statusJson(false, "stopped"));
                    } catch (Exception ignored) {
                        // Best effort.
                    }
                    try {
                        client.disconnect();
                    } catch (Exception ignored) {
                        // Already disconnected.
                    }
                    try {
                        client.close();
                    } catch (Exception ignored) {
                        // Best effort.
                    }
                    client = null;
                }
            }
            emitRelayEvent("closed", "", topicBase, "Relay closed.");
        }

        // ---- MqttCallbackExtended ----

        @Override
        public void connectComplete(final boolean reconnect, final String serverURI) {
            online = true;
            activeBroker = serverURI;
            lastError = "";
            emitRelayEvent("online", serverURI, getTopicBase(),
                    (reconnect ? "Relay back online via " : "Relay online via ")
                            + hostOf(serverURI));
            // Subscribe + refresh the retained status away from the paho
            // callback thread (blocking calls from callbacks can deadlock).
            final MqttAsyncClient currentClient;
            synchronized (clientLock) {
                currentClient = client;
            }
            networkExecutor.submit(new Runnable() {
                @Override
                public void run() {
                    if (currentClient == null || !wanted) {
                        return;
                    }
                    try {
                        currentClient.subscribe(getTopicBase() + "/cmd", 1);
                    } catch (Exception e) {
                        lastError = String.valueOf(e.getMessage());
                        emitRelayEvent("error", serverURI, getTopicBase(),
                                "Relay subscribe failed: " + lastError);
                        return;
                    }
                    try {
                        publishRetained(currentClient,
                                getTopicBase() + "/status",
                                statusJson(true, ""));
                    } catch (Exception ignored) {
                        // The heartbeat refreshes it anyway.
                    }
                    startHeartbeat(currentClient);
                }
            });
        }

        @Override
        public void connectionLost(Throwable cause) {
            online = false;
            emitRelayEvent("offline", "", getTopicBase(),
                    "Relay connection lost — reconnecting automatically…");
            stopHeartbeat();
        }

        @Override
        public void messageArrived(String topic, MqttMessage message) {
            if (topic == null || !topic.endsWith("/cmd")) {
                return;
            }
            final String payload;
            try {
                payload = new String(message.getPayload(), StandardCharsets.UTF_8);
            } catch (Exception ignored) {
                return;
            }
            handleRelayCommand(payload);
        }

        @Override
        public void deliveryComplete(IMqttDeliveryToken token) {
            // Nothing to do.
        }

        // ---- Command pipeline ----

        private void handleRelayCommand(String payload) {
            final Map<String, String> command = parseFlatJsonObject(payload);
            final String agentId = command.get("id");
            if (agentId == null || agentId.isEmpty()) {
                return; // Uncorrelatable command — drop it.
            }
            // QoS 1 may redeliver: never execute the same command twice.
            synchronized (recentCommandIds) {
                if (recentCommandIds.contains(agentId)) {
                    return;
                }
                recentCommandIds.add(agentId);
                if (recentCommandIds.size() > 400) {
                    java.util.Iterator<String> it = recentCommandIds.iterator();
                    if (it.hasNext()) {
                        it.next();
                        it.remove();
                    }
                }
            }

            final String providedToken = command.get("token");
            if (providedToken == null || !constantTimeEquals(providedToken, token)) {
                networkExecutor.submit(new Runnable() {
                    @Override
                    public void run() {
                        publishEvent(agentId, 401,
                                "{\"ok\":false,\"error\":\"Unauthorized: bad or missing "
                                        + "bridge token.\"}");
                    }
                });
                return;
            }

            String method = command.get("method");
            String path = command.get("path");
            String query = command.get("query");
            String body = command.get("body");
            if (method == null || method.isEmpty()) {
                method = "GET";
            }
            if (path == null || path.isEmpty()) {
                path = "/";
            }
            if (query == null) {
                query = "";
            }
            if (body == null) {
                body = "";
            }

            requestsServed++;
            final String internalId = UUID.randomUUID().toString();
            final CompletableFuture<JSObject> future = new CompletableFuture<>();
            pendingRequests.put(internalId, future);
            relayCorrelations.put(internalId, agentId);
            relayDeadlines.put(internalId,
                    System.currentTimeMillis() + REQUEST_TIMEOUT_SECONDS * 1000L);

            future.whenComplete(new java.util.function.BiConsumer<JSObject, Throwable>() {
                @Override
                public void accept(JSObject result, Throwable error) {
                    relayCorrelations.remove(internalId);
                    relayDeadlines.remove(internalId);
                    final int status;
                    final String responseBody;
                    if (error != null) {
                        status = 504;
                        responseBody = "{\"ok\":false,\"error\":\"The app did not answer "
                                + "in time (it may be busy or in the background).\"}";
                    } else if (result == null) {
                        status = 500;
                        responseBody = "{\"ok\":false,\"error\":\"Empty answer.\"}";
                    } else {
                        Integer parsedStatus = null;
                        try {
                            parsedStatus = result.getInt("status");
                        } catch (Exception ignored) {
                            // Keep null.
                        }
                        String parsedBody = null;
                        try {
                            parsedBody = result.getString("body");
                        } catch (Exception ignored) {
                            // Keep null.
                        }
                        status = parsedStatus == null ? 200 : parsedStatus;
                        responseBody = parsedBody == null ? "{}" : parsedBody;
                    }
                    final int finalStatus = status;
                    final String finalBody = responseBody;
                    networkExecutor.submit(new Runnable() {
                        @Override
                        public void run() {
                            publishEvent(agentId, finalStatus, finalBody);
                        }
                    });
                }
            });

            JSObject payloadForWeb = new JSObject();
            payloadForWeb.put("id", internalId);
            payloadForWeb.put("method", method);
            payloadForWeb.put("path", path);
            payloadForWeb.put("query", query);
            payloadForWeb.put("body", body);
            try {
                notifyListeners(EVENT_REQUEST, payloadForWeb);
            } catch (Exception ignored) {
                // The watchdog timeout answers the agent.
            }
        }

        // ---- Publishing helpers (all run on networkExecutor) ----

        private void publishEvent(String agentId, int status, String body) {
            publishToBroker(getTopicBase() + "/evt",
                    eventJson(agentId, status, body));
        }

        private void publishToBroker(String topic, String json) {
            if (json.length() > 700000) {
                // Public brokers cap packets around 1MB: refuse politely.
                json = eventJson("",
                        500,
                        "{\"ok\":false,\"error\":\"Response too large for the relay ("
                                + json.length() + " bytes). Narrow the request "
                                + "(e.g. read a single scene instead of the full project).\"}");
            }
            synchronized (clientLock) {
                if (client == null || !wanted) {
                    return;
                }
                try {
                    MqttMessage message = new MqttMessage(
                            json.getBytes(StandardCharsets.UTF_8));
                    message.setQos(1);
                    client.publish(topic, message);
                } catch (Exception e) {
                    lastError = String.valueOf(e.getMessage());
                    emitRelayEvent("warning", activeBroker, getTopicBase(),
                            "Relay publish failed: " + lastError);
                }
            }
        }

        private void publishRetained(MqttAsyncClient target, String topic, String json)
                throws Exception {
            MqttMessage message = new MqttMessage(
                    json.getBytes(StandardCharsets.UTF_8));
            message.setQos(1);
            message.setRetained(true);
            target.publish(topic, message);
        }

        private String statusJson(boolean isOnline, String reason) {
            List<String> urls = server != null ? getLanUrls() : new ArrayList<String>();
            StringBuilder json = new StringBuilder();
            json.append("{\"online\":").append(isOnline)
                    .append(",\"app\":\"Horizons\"")
                    .append(",\"version\":\"").append(APP_VERSION).append("\"")
                    .append(",\"topic\":\"").append(getTopicBase()).append("\"")
                    .append(",\"port\":").append(boundPort)
                    .append(",\"lanUrls\":[");
            for (int i = 0; i < urls.size(); i++) {
                if (i > 0) {
                    json.append(",");
                }
                json.append("\"").append(jsonEscape(urls.get(i))).append("\"");
            }
            json.append("]")
                    .append(",\"requestsServed\":").append(requestsServed);
            if (reason != null && !reason.isEmpty()) {
                json.append(",\"reason\":\"").append(jsonEscape(reason)).append("\"");
            }
            json.append("}");
            return json.toString();
        }

        private String eventJson(String agentId, int status, String body) {
            return "{\"id\":\"" + jsonEscape(agentId) + "\",\"status\":" + status
                    + ",\"body\":\"" + jsonEscape(body == null ? "{}" : body) + "\"}";
        }

        // ---- Heartbeat (retained status refresh) ----

        private void startHeartbeat(final MqttAsyncClient client) {
            stopHeartbeat();
            heartbeatThread = new Thread(new Runnable() {
                @Override
                public void run() {
                    while (wanted && online) {
                        try {
                            Thread.sleep(20000);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                            return;
                        }
                        if (!wanted || !online) {
                            return;
                        }
                        try {
                            publishRetained(client, getTopicBase() + "/status",
                                    statusJson(true, ""));
                        } catch (Exception ignored) {
                            // Reconnect refreshes it.
                        }
                    }
                }
            });
            heartbeatThread.setDaemon(true);
            heartbeatThread.setName("bridge-relay-heartbeat");
            heartbeatThread.start();
        }

        private void stopHeartbeat() {
            Thread thread = heartbeatThread;
            if (thread != null) {
                thread.interrupt();
                heartbeatThread = null;
            }
        }
    }

    /** Watchdog: completes relay requests whose WebView answer never came. */
    private final Thread relayWatchdog = new Thread(new Runnable() {
        @Override
        public void run() {
            while (true) {
                try {
                    Thread.sleep(5000);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
                long now = System.currentTimeMillis();
                for (Map.Entry<String, Long> entry : relayDeadlines.entrySet()) {
                    if (entry.getValue() < now) {
                        String internalId = entry.getKey();
                        CompletableFuture<JSObject> future =
                                pendingRequests.get(internalId);
                        if (future != null && !future.isDone()) {
                            future.completeExceptionally(new TimeoutException());
                        }
                        relayDeadlines.remove(internalId);
                        pendingRequests.remove(internalId);
                    }
                }
            }
        }
    });

    {
        relayWatchdog.setDaemon(true);
        relayWatchdog.setName("bridge-relay-watchdog");
        relayWatchdog.start();
    }

    private void emitRelayEvent(String phase, String broker, String topic, String message) {
        try {
            JSObject event = new JSObject();
            event.put("phase", phase);
            event.put("broker", broker == null ? "" : broker);
            event.put("topic", topic == null ? "" : topic);
            event.put("message", message == null ? "" : message);
            notifyListeners(EVENT_RELAY, event);
        } catch (Exception ignored) {
            // The WebView may not be ready — events are best effort.
        }
    }

    // ------------------------------------------------------------------
    // Minimal JSON helpers (no external dependency)
    // ------------------------------------------------------------------

    private static String jsonEscape(String value) {
        if (value == null) {
            return "";
        }
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"':
                    out.append("\\\"");
                    break;
                case '\\':
                    out.append("\\\\");
                    break;
                case '\n':
                    out.append("\\n");
                    break;
                case '\r':
                    out.append("\\r");
                    break;
                case '\t':
                    out.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        return out.toString();
    }

    /**
     * Parses a FLAT JSON object whose values are strings (or scalars) into a
     * Map. Handles escapes, so a command body that is itself JSON-in-a-string
     * survives intact. Malformed input yields a partially filled map — never
     * an exception.
     */
    static Map<String, String> parseFlatJsonObject(String json) {
        Map<String, String> out = new HashMap<String, String>();
        if (json == null) {
            return out;
        }
        int i = skipWs(json, 0);
        if (i >= json.length() || json.charAt(i) != '{') {
            return out;
        }
        i++;
        while (true) {
            i = skipWs(json, i);
            if (i >= json.length()) {
                return out;
            }
            char c = json.charAt(i);
            if (c == '}') {
                return out;
            }
            if (c != '"') {
                return out; // Malformed key.
            }
            StringBuilder key = new StringBuilder();
            i = readJsonString(json, i, key);
            if (i < 0) {
                return out;
            }
            i = skipWs(json, i);
            if (i >= json.length() || json.charAt(i) != ':') {
                return out;
            }
            i = skipWs(json, i + 1);
            if (i >= json.length()) {
                return out;
            }
            c = json.charAt(i);
            if (c == '"') {
                StringBuilder value = new StringBuilder();
                i = readJsonString(json, i, value);
                if (i < 0) {
                    return out;
                }
                out.put(key.toString(), value.toString());
            } else {
                // Number, boolean or null: keep the raw token as a string.
                int start = i;
                while (i < json.length()) {
                    char ch = json.charAt(i);
                    if (ch == ',' || ch == '}') {
                        break;
                    }
                    i++;
                }
                out.put(key.toString(), json.substring(start, i).trim());
            }
            i = skipWs(json, i);
            if (i < json.length() && json.charAt(i) == ',') {
                i++;
                continue;
            }
            return out; // '}' or malformed — done either way.
        }
    }

    /**
     * Reads the JSON string starting at {@code i} (which must point to the
     * opening quote), appending the DECODED characters to {@code out}.
     * Returns the index just after the closing quote, or -1 when malformed.
     */
    private static int readJsonString(String json, int i, StringBuilder out) {
        i++; // Skip the opening quote.
        while (i < json.length()) {
            char c = json.charAt(i);
            if (c == '"') {
                return i + 1;
            }
            if (c == '\\') {
                i++;
                if (i >= json.length()) {
                    return -1;
                }
                char e = json.charAt(i);
                switch (e) {
                    case '"':
                        out.append('"');
                        break;
                    case '\\':
                        out.append('\\');
                        break;
                    case '/':
                        out.append('/');
                        break;
                    case 'b':
                        out.append('\b');
                        break;
                    case 'f':
                        out.append('\f');
                        break;
                    case 'n':
                        out.append('\n');
                        break;
                    case 'r':
                        out.append('\r');
                        break;
                    case 't':
                        out.append('\t');
                        break;
                    case 'u':
                        if (i + 4 >= json.length()) {
                            return -1;
                        }
                        String hex = json.substring(i + 1, i + 5);
                        try {
                            out.append((char) Integer.parseInt(hex, 16));
                        } catch (NumberFormatException parseError) {
                            return -1;
                        }
                        i += 4;
                        break;
                    default:
                        return -1;
                }
                i++;
            } else {
                out.append(c);
                i++;
            }
        }
        return -1;
    }

    private static int skipWs(String json, int i) {
        while (i < json.length()) {
            char c = json.charAt(i);
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                i++;
            } else {
                break;
            }
        }
        return i;
    }

    static String hostOf(String serverUri) {
        if (serverUri == null) {
            return "";
        }
        String rest = serverUri;
        int schemeIndex = rest.indexOf("://");
        if (schemeIndex >= 0) {
            rest = rest.substring(schemeIndex + 3);
        }
        int portIndex = rest.indexOf(':');
        if (portIndex >= 0) {
            rest = rest.substring(0, portIndex);
        }
        int slashIndex = rest.indexOf('/');
        if (slashIndex >= 0) {
            rest = rest.substring(0, slashIndex);
        }
        return rest;
    }
}
