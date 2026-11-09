// @flow
/**
 * The manifest and self-serve guide served at `GET /` on the bridge.
 * An external AI agent that just received "URL + token" from the user
 * fetches this once and knows everything: what the app is, what the
 * project contains, which endpoints exist and the recommended workflow.
 */

const APP_VERSION = '0.3.0';

export const buildManifest = (project: any | null, query: URLSearchParams) => {
  const scenes: Array<string> = [];
  if (project) {
    for (let i = 0; i < project.getLayoutsCount(); i++) {
      scenes.push(project.getLayoutAt(i).getName());
    }
  }
  return {
    app: {
      name: 'Horizons',
      version: APP_VERSION,
      engine: 'GDevelop fork (fully offline, Capacitor Android)',
      bridge: '1',
    },
    project: project
      ? {
          open: true,
          name: project.getName(),
          scenes,
          eventsFunctionsExtensions: project.getEventsFunctionsExtensionsCount(),
        }
      : { open: false },
    endpoints: {
      'GET /': 'this manifest + the full agent guide',
      'GET /status': 'bridge + project status, backups list',
      'GET /project/simplified': 'compact project JSON (recommended first read)',
      'GET /project/digest': 'project digest as readable text',
      'GET /project/full': 'full serialized project JSON (big)',
      'GET /scenes': 'scene list with event/object counts',
      'GET /scenes/:name/events?format=text|json':
        'read a scene events as readable text (default) or raw JSON',
      'POST /scenes/:name/events':
        'WRITE events (operations or events+mode) — validated & applied live',
      'POST /scenes': 'create a scene {"name":"...", "open":true}',
      'POST /open-scene': 'open a scene in the editor {"name":"..."}',
      'POST /validate-events': 'dry-run validation of an events array',
      'GET /objects': 'all objects (global + per scene)',
      'GET /objects/:name': 'object definition JSON',
      'PUT /objects/:name': 'create/replace object {"object":{...}, "scope":"global"}',
      'GET /resources': 'project resources',
      'GET /extensions': 'events functions extensions',
      'PUT /extensions/:name': 'create/replace an extension {"extension":{...}}',
      'GET /instructions/cheatsheet?scene=&query=':
        'REAL condition/action names available for this project',
      'POST /save': 'save the project on the device',
      'POST /eval': 'run a JS snippet with editor access (escape hatch)',
      'GET /logs': 'everything done so far',
      'POST /log': 'add your own progress note {"message":"..."}',
      'GET /backups | POST /backup | POST /revert':
        'events snapshots before each write, and rollback',
    },
    guide: buildAgentGuide(project),
    hint:
      'Start with GET /project/digest, then GET /scenes/<name>/events, then GET /instructions/cheatsheet before writing events.',
  };
};

export const buildAgentGuide = (project: any | null): string => {
  const projectName = project ? project.getName() : '(no project open)';
  return `# Horizons Agent Bridge

You are connected to **Horizons** (a GDevelop fork running on the user's Android
device). You have full, authenticated access to the game editor via this REST
API. Every request needs the bridge token (the user gave it to you — it is
already validated since you can read this).

Current project: **${projectName}**

## How to call

    curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/<endpoint>"
    curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
         -d '{"events":[...]}' "$BASE_URL/scenes/<Scene>/events"

(\`$BASE_URL\` is the URL you were given; \`$TOKEN\` the token. The \`?token=\`
query parameter also works.)

## Recommended workflow

1. \`GET /project/digest\` — understand the game (scenes, objects, variables).
2. \`GET /scenes/<name>/events\` — see existing events as readable text
   (\`?format=json\` for the raw serialized JSON).
3. \`GET /instructions/cheatsheet?scene=<name>\` — the REAL conditions/actions
   usable with this project's objects, with exact parameter counts.
   **Only use instruction names from this list.**
4. \`POST /validate-events\` — optional dry-run of your events array.
5. \`POST /scenes/<name>/events\` — write (see format below).
6. \`POST /save\` — persist on the device. \`POST /log\` — leave progress notes
   for the user (they appear live in the app).

## Writing events

Body (recommended):

    {
      "operations": [
        {
          "operationName": "insert_at_end",
          "generatedEvents": "<JSON string or array of events>",
          "undeclaredVariables": [],
          "missingObjectBehaviors": {}
        }
      ]
    }

Shortcut:

    { "events": [ ... ], "mode": "append" }   // or "replace" for the whole scene

operationName is one of: insert_at_end, insert_before_event, insert_after_event,
insert_as_sub_event, insert_and_replace_event, replace_entire_event_and_sub_events,
replace_event_but_keep_existing_sub_events, insert_actions_conditions_at_end,
insert_actions_conditions_at_start, replace_all_actions, replace_all_conditions,
delete_event.

operationTargetEvent is a path like "event-0.2" (see the text rendering of a
scene) or an aiGeneratedEventId returned by a previous write.

An event looks like:

    {
      "type": "BuiltinCommonInstructions::Standard",
      "conditions": [ { "type": { "value": "PosX" },
                        "parameters": ["Player", "<", "100", ""] } ],
      "actions":   [ { "type": { "value": "SetX" },
                        "parameters": ["Player", "=", "100", ""] } ]
    }

Common types: Standard, BuiltinCommonInstructions::Standard,
BuiltinCommonInstructions::ForEach ("object" param), ::Repeat ("repeatNumber" is
a numeric expression), ::While, ::Comment ("comment"), ::Group ("comment"),
::Link, ::JsCode (the project supports JS code events: "codeEvents" text +
"frozen" false). Events may nest with "events": [...].

Validation: every write is checked against the engine metadata first. If a
condition/action does not exist, you get a diagnostic naming the closest real
instruction — fix and retry. Only set "strict": false to bypass.

## Safety net

Every write snapshots the scene first: \`GET /backups\`, \`POST /revert
{"index":N}\`. Prefer many small writes over one giant one.

## Full power: /eval

    POST /eval  { "code": "return ctx.project.getName();" }

The snippet is async JS running inside the editor, with \`ctx = { gd, project,
helpers, window }\`. helpers: serializeToJSObject, unserializeFromJSObject,
renderEventsAsText(eventsList), notifyEventsChanged(scene),
notifyObjectsChanged(scene), saveProject(), log(message). Use it for anything
not covered by an endpoint (variables, layers, resources, instances…), then
call the notify helpers so the UI refreshes.

## Rules of conduct

- The user keeps the app open and watches your changes land live. Leave notes
  with POST /log about what you are doing.
- Save with POST /save when a unit of work is done (the first save may need
  the user to pick a location — a dialog appears on their screen).
- Long requests cap at ~180s; keep /eval snippets short.
- Public-URL mode (a *.loca.lt address) may show a one-time password page for
  datacenter visitors: if a request answers 40x with an HTML form, fetch your
  own public IP (e.g. https://api.ipify.org), submit it as the form's
  tunnel_password field with the same cookie jar, then retry.
`;
};
