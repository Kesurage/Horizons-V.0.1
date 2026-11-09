# The Horizons Agent Bridge

**No AI API keys. No free-tier limits. The app itself becomes the AI's hands.**

The Agent Bridge lets any external AI agent — one that already has its own
intelligence, like a chat assistant — drive the Horizons editor on the user's
Android device: browse the project, write events, objects and extensions,
save, and report progress. The user keeps the app open and watches everything
land live.

**V0.3.1: the transport is now a relay (MQTT over WebSocket).** The old
approach (a local server + the free localtunnel public-URL service) is dead —
localtunnel now refuses new tunnels with 403, and inbound access does not work
on mobile networks. The relay is **outbound-only** on the phone side, so it
works on any mobile data or Wi-Fi connection, like the app's own web requests.

## How it works (user side)

1. Open the **Agent Bridge panel** (menu: Help → Agent Bridge).
2. Press **Start Bridge** — the app:
   - connects OUT to a public MQTT-over-WebSocket broker
     (`wss://broker.emqx.io:8084/mqtt`, fallback
     `wss://broker.hivemq.com:8884/mqtt` — no account, no key),
   - advertises its presence on a retained `hz/<id>/status` topic (with a
     Last-Will that flips it offline if the app dies), and keeps reconnecting
     automatically,
   - generates a personal access token (persisted, `hz_…` format),
   - also starts a local HTTP server on the same Wi-Fi (best effort — if it
     cannot bind, nothing breaks, the relay still works),
   - keeps the screen on so long sessions are not interrupted.
3. Press **Copy agent briefing** and paste it into a chat with any AI. The
   briefing contains the broker, topic, token and the exact protocol.
4. Watch the live log in the panel: every request, write, note and error of
   the agent appears as it works. Press **Stop Bridge** to cut access.

## The relay protocol (agent side)

Subscribe BEFORE publishing. QoS 1, TLS. Message cap ~500KB per request.

```
topic: hz/<id>/cmd     you → app     one command (like one HTTP request):
  {"id":"r1","token":"hz_…","method":"GET","path":"/","query":"","body":""}

topic: hz/<id>/evt     app → you     the answer:
  {"id":"r1","status":200,"body":"{…json…}"}

topic: hz/<id>/status  app → anyone  retained presence:
  {"online":true,"app":"Horizons","version":"0.3.1","topic":"hz/…",
   "port":8090,"lanUrls":["http://192.168.x.x:8090"],"requestsServed":N}
```

- `method`/`path`/`query`/`body` behave like HTTP; `body` carries the request
  body as a string (JSON for writes).
- `id` correlates commands with answers — use a fresh id per request (the app
  de-duplicates redelivered ids, QoS 1).
- No answer within ~60s: the app may be backgrounded — ask the user to reopen
  it, then retry with a NEW id.
- Bad token → `{"id":"…","status":401,…}` on `/evt`.

Quick start with Python (`pip install paho-mqtt`):

```python
import json, uuid, paho.mqtt.client as mqtt

TOPIC = "hz/…"           # from the briefing
TOKEN = "hz_…"

c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="agent",
                transport="websockets")
c.ws_set_options(path="/mqtt")
c.tls_set()
c.on_message = lambda cl, u, m: print(m.payload.decode())  # watch /evt
c.connect("broker.emqx.io", 8084)
c.loop_start()
c.subscribe(f"{TOPIC}/evt")
rid = uuid.uuid4().hex[:8]
c.publish(f"{TOPIC}/cmd", json.dumps({
    "id": rid, "token": TOKEN,
    "method": "GET", "path": "/", "query": "", "body": "",
}), qos=1)
# …the answer with the same id arrives on /evt. GET / returns the full
# manifest + self-serve guide (endpoints, event formats, workflow).
```

## What the agent can do (API summary)

`GET /` on the bridge returns the manifest AND a complete self-serve guide —
start there. Summary of the endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /` | manifest + full agent guide (start here) |
| `GET /status` | bridge & project status, backups |
| `GET /project/simplified` | compact project JSON |
| `GET /project/digest` | project digest as readable text |
| `GET /project/full` | full serialized project |
| `GET /scenes` / `GET /scenes/:name/events?format=text\|json` | browse scenes & events |
| `POST /scenes/:name/events` | **write events** (validated pipeline) |
| `POST /scenes` / `POST /open-scene` | create / open a scene |
| `POST /validate-events` | dry-run validation |
| `GET /objects` / `GET /objects/:name` / `PUT /objects/:name` | read/create/replace objects |
| `GET /resources` / `GET /extensions` / `PUT /extensions/:name` | resources & extensions |
| `GET /instructions/cheatsheet` | the REAL conditions/actions for this project |
| `POST /save` | save the project on the device |
| `POST /eval` | run a JS snippet with editor access (escape hatch) |
| `GET /logs` / `POST /log` | read/add progress notes |
| `GET /backups` / `POST /backup` / `POST /revert` | snapshots & rollback |

Writes go through the editor's own pipeline
(`EditorFunctions/ApplyEventsChanges`): events are validated against the real
engine metadata (unknown instructions get "closest real instruction"
diagnostics), undeclared variables/behaviors are auto-declared, and every
write snapshots the scene for one-call rollback.

## LAN access (bonus, same Wi-Fi only)

While the bridge runs, the local HTTP server also accepts plain HTTP with the
same token: `Authorization: Bearer <token>` header (or `?token=`) —
`GET /health` is the unauthenticated heartbeat. Over USB from a PC:
`adb reverse tcp:8090 tcp:8090` then use `http://localhost:8090`.

## Architecture

```
┌────────────────────── Android app ──────────────────────┐
│  WebView (Horizons editor, React)                       │
│   └─ AgentBridge/*  — REST router (BridgeApi.js)        │
│        │  ▲ bridgeRequest event / respond()             │
│  ──────┼──────────────────────────────────────────      │
│  Native│ (Capacitor plugin: BridgeServerPlugin.java)    │
│   ├─ MqttRelay: OUTBOUND wss://broker.emqx.io (Paho)    │
│   │    cmd → WebView → evt    + retained status + LWT   │
│   └─ NanoHTTPD 0.0.0.0:8090 (LAN bonus, best effort)   │
└────────┼────────────────────────────────────────────────┘
         ▼
   public MQTT broker ──── AI agent (MQTT/WSS client, anywhere)
```

- Native plugin: `android-app/bridge-src/com/kesurage/horizons/bridge/BridgeServerPlugin.java`
  (injected into the CI-generated Capacitor project by
  `.github/workflows/build-horizons-apk.yml`; also present in the committed
  `android-app/` project). Relay dependency:
  `org.eclipse.paho:org.eclipse.paho.client.mqttv3:1.2.5` (Maven Central).
- Web side: `newIDE/app/src/AgentBridge/` (panel, server, API, guide, logs).
- The router runs **inside the editor**, so it reuses the editor's own
  serialization, validation, refresh and save routines — the agent writes
  through the exact same code paths as the editor itself.

## Security notes

- The token is required on EVERY relay command and on every LAN request
  (constant-time comparison) and is generated on-device, persisted in the
  app's private storage.
- The relay topic (`hz/<id>`) is random and unguessable, but public brokers
  are public: anyone who knows the topic AND the token could send commands.
  Share the briefing only with an AI you trust; press Stop when done (the
  agent then gets nothing). `POST /eval` runs JavaScript with editor access —
  powerful by design, protected by the same token.
- The LAN server binds only while the bridge is running.
