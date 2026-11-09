# The Horizons Agent Bridge

**No AI API keys. No free-tier limits. The app itself becomes the AI's hands.**

The Agent Bridge turns the Horizons editor into a small token-protected HTTP
server running on the device. Any external AI agent — one that already has
its own intelligence, like a chat assistant with shell access — can connect
with the access token and drive the whole editor: browse the project, write
events, objects and extensions, save, and report progress. The user keeps
the app open and watches everything land live.

## How it works (user side)

1. Open the **AI panel** in the app.
2. Press **Start Bridge** — the app:
   - binds a local HTTP server (default port `8090`, LAN reachable),
   - generates a personal access token (persisted, `hz_…` format, like a
     modern GitHub token),
   - keeps the screen on so long sessions are not interrupted.
3. Give the **URL + token** to your AI agent (the **Copy agent briefing**
   button prepares a paste-ready message). The agent fetches `GET /` on the
   bridge — that single request returns the manifest AND a complete
   self-serve guide (endpoints, event formats, recommended workflow).
4. Watch the live log in the panel: every request, write, note and error of
   the agent appears as it works. Press **Stop Bridge** to cut access.

## Two access modes

- **LAN (default, always works):** any device on the same Wi-Fi can call the
  bridge. From a PC over USB: `adb reverse tcp:8090 tcp:8090` then use
  `http://localhost:8090`.
- **Public URL (experimental):** the app speaks the open
  [localtunnel](https://github.com/localtunnel/localtunnel) client protocol
  (free, no account, no key) so a **cloud** agent can reach the device from
  anywhere. The public URL is shown in the panel. If the free service is
  busy or blocks datacenter IPs, LAN still works. A self-hosted localtunnel
  server can be configured later by changing the server URL in the plugin.

## What the agent can do (API summary)

All calls need the token: `Authorization: Bearer <token>` header (or
`?token=`). `GET /health` is the unauthenticated heartbeat.

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

Writes go through the **same pipeline as the built-in AI**
(`EditorFunctions/ApplyEventsChanges`): events are validated against the real
engine metadata (unknown instructions get "closest real instruction"
diagnostics), undeclared variables/behaviors are auto-declared, and every
write snapshots the scene for one-call rollback.

## Example session (from the agent side)

```bash
BASE=http://192.168.1.42:8090
TOKEN=hz_…

curl -H "Authorization: Bearer $TOKEN" $BASE/health
curl -H "Authorization: Bearer $TOKEN" $BASE/project/digest
curl -H "Authorization: Bearer $TOKEN" "$BASE/scenes/Scene1/events"
curl -H "Authorization: Bearer $TOKEN" "$BASE/instructions/cheatsheet?scene=Scene1"

curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"events":[{"type":"BuiltinCommonInstructions::Standard","conditions":[],"actions":[{"type":{"value":"SetX"},"parameters":["Player","=","100",""]}]}],"mode":"append"}' \
     "$BASE/scenes/Scene1/events"

curl -X POST -H "Authorization: Bearer $TOKEN" -d '{"message":"Player spawn is now fixed"}' \
     $BASE/log
curl -X POST -H "Authorization: Bearer $TOKEN" $BASE/save
```

## Architecture

```
┌────────────────────── Android app ──────────────────────┐
│  WebView (Horizons editor, React)                       │
│   └─ AgentBridge/*  — REST router (BridgeApi.js)        │
│        │  ▲ bridgeRequest event / respond()             │
│  ──────┼──────────────────────────────────────────      │
│  Native│ (Capacitor plugin: BridgeServerPlugin.java)    │
│   └─ NanoHTTPD server 0.0.0.0:8090 + token auth         │
│        │  + optional localtunnel client (public URL)    │
└────────┼────────────────────────────────────────────────┘
         ▼
   AI agent (curl / any HTTP client, anywhere)
```

- Native plugin: `android-app/bridge-src/com/kesurage/horizons/bridge/BridgeServerPlugin.java`
  (injected into the CI-generated Capacitor project by
  `.github/workflows/build-horizons-apk.yml`; also present in the committed
  `android-app/` project).
- Web side: `newIDE/app/src/AgentBridge/` (panel, server, API, guide, logs).
- The router runs **inside the editor**, so it reuses the editor's own
  serialization, validation, refresh and save routines — the agent writes
  through the exact same code paths as the built-in AI.

## Security notes

- The token is required on every endpoint (constant-time comparison) and is
  generated on-device, persisted in the app's private storage.
- The server binds on the LAN only while the bridge is running; press Stop
  to cut all access immediately.
- `POST /eval` runs JavaScript with editor access — powerful by design
  (that is the point: "the agent can have all the influence"), protected by
  the same token. Do not share the token with anyone you do not trust.
