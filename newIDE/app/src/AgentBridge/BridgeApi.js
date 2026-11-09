// @flow
/**
 * The Agent Bridge REST API, executed inside the editor WebView.
 *
 * The native plugin (android-app/bridge-src) receives HTTP requests on the
 * device and forwards them here. This router has the whole editor at its
 * disposal: the opened project (gd.Project), the save routine, the editor
 * refresh callbacks… An external AI agent authenticates with the bridge
 * token and can then browse the project and write events, objects,
 * scenes or extensions — using the exact same validated pipelines as the
 * built-in AI (EditorFunctions/ApplyEventsChanges & co).
 */
import { serializeToJSObject, unserializeFromJSObject, serializeToJSON } from '../Utils/Serializer';
import {
  applyEventsChanges,
  addUndeclaredVariables,
  addObjectUndeclaredVariables,
  addMissingObjectBehaviors,
  normalizeGeneratedEventsContent,
} from '../EditorFunctions/ApplyEventsChanges';
import { renderNonTranslatedEventsAsText } from '../EventsSheet/EventsTree/TextRenderer';
import { makeSimplifiedProjectBuilder } from '../EditorFunctions/SimplifiedProject/SimplifiedProject';
import { buildProjectDigest } from '../AiGeneration/UniversalAiAgent';
import {
  buildInstructionCheatsheet,
  validateEventsAgainstMetadata,
} from '../AiGeneration/InstructionCheatsheet';
import { pushBridgeLog, getBridgeLogs } from './BridgeLogs';
import { buildAgentGuide, buildManifest } from './AgentGuide';

const gd: libGDevelop = global.gd;

// ---------------------------------------------------------------------------
// Context: set by the editor (see AgentBridgeContextSync) — gives the API
// live access to the project and to the app's own save/refresh routines.
// ---------------------------------------------------------------------------

export type AgentBridgeContext = {
  project: any | null, // gdProject (untyped to stay tolerant across builds)
  onSave: (() => Promise<any>) | null,
  openLayout: ((name: string, options?: any) => void) | null,
  onSceneEventsModifiedOutsideEditor: ((changes: any) => void) | null,
  onObjectsModifiedOutsideEditor: ((changes: any) => void) | null,
  onObjectGroupsModifiedOutsideEditor: ((changes: any) => void) | null,
  onInstancesModifiedOutsideEditor: ((changes: any) => void) | null,
  onExtensionInstalled: ((extensionNames: Array<string>) => void) | null,
};

let context: AgentBridgeContext = {
  project: null,
  onSave: null,
  openLayout: null,
  onSceneEventsModifiedOutsideEditor: null,
  onObjectsModifiedOutsideEditor: null,
  onObjectGroupsModifiedOutsideEditor: null,
  onInstancesModifiedOutsideEditor: null,
  onExtensionInstalled: null,
};

export const setAgentBridgeContext = (newContext: AgentBridgeContext) => {
  context = newContext;
};

// ---------------------------------------------------------------------------
// Event backups: every write snapshots the touched scene's events so an
// agent mistake can be rolled back with POST /revert.
// ---------------------------------------------------------------------------

type EventsBackup = {
  index: number,
  ts: number,
  sceneName: string,
  eventsJson: string,
  reason: string,
};

const backups: Array<EventsBackup> = [];
let nextBackupIndex = 1;
const MAX_BACKUPS = 10;

const makeBackup = (scene: any, reason: string): EventsBackup => {
  const backup: EventsBackup = {
    index: nextBackupIndex++,
    ts: Date.now(),
    sceneName: scene.getName(),
    eventsJson: serializeToJSON(scene.getEvents()),
    reason,
  };
  backups.push(backup);
  while (backups.length > MAX_BACKUPS) {
    backups.shift();
  }
  return backup;
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ok = (json: any) => ({ status: 200, json: { ok: true, ...json } });
const fail = (status: number, error: string, extra?: any) => ({
  status,
  json: { ok: false, error, ...(extra || {}) },
});

const getProject = () => {
  if (!context.project) {
    throw new ApiError(400, 'No project is opened in the editor.');
  }
  return context.project;
};

class ApiError extends Error {
  status: number;
  extra: any;
  constructor(status: number, message: string, extra?: any) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const findScene = (project: any, sceneName: string): any => {
  if (!project.hasLayoutNamed(sceneName)) {
    throw new ApiError(404, `Scene not found: "${sceneName}". Use GET /scenes.`);
  }
  return project.getLayout(sceneName);
};

let simplifiedProjectCache: { project: any, json: string } | null = null;
const getSimplifiedProjectJson = (project: any): string => {
  if (
    simplifiedProjectCache &&
    simplifiedProjectCache.project === project
  ) {
    return simplifiedProjectCache.json;
  }
  const simplifiedProjectBuilder = makeSimplifiedProjectBuilder(gd);
  const simplifiedProject = simplifiedProjectBuilder.getSimplifiedProject(
    project,
    {}
  );
  const json = JSON.stringify(simplifiedProject);
  simplifiedProjectCache = { project, json };
  return json;
};

const notifySceneEventsChanged = (scene: any, eventIds: Set<string>) => {
  if (context.onSceneEventsModifiedOutsideEditor) {
    try {
      context.onSceneEventsModifiedOutsideEditor({
        scene,
        newOrChangedAiGeneratedEventIds: eventIds,
      });
    } catch (error) {
      pushBridgeLog('error', 'Could not refresh the events sheet', String(error));
    }
  }
};

const notifyObjectsChanged = (scene: any, isNewObjectTypeUsed: boolean) => {
  if (context.onObjectsModifiedOutsideEditor) {
    try {
      context.onObjectsModifiedOutsideEditor({ scene, isNewObjectTypeUsed });
    } catch (error) {
      pushBridgeLog('error', 'Could not refresh the object lists', String(error));
    }
  }
};

const anyScene = (project: any): any => {
  // Notifications need a scene — use the first one as anchor.
  if (project.getLayoutsCount() > 0) {
    return project.getLayoutAt(0);
  }
  return null;
};

const countEventsDeeply = (eventsList: any): number => {
  let count = eventsList.getEventsCount();
  for (let i = 0; i < eventsList.getEventsCount(); i++) {
    const event = eventsList.getEventAt(i);
    if (event.canHaveSubEvents()) {
      count += countEventsDeeply(event.getSubEvents());
    }
  }
  return count;
};

/** Objects container for a scope: "global" or a scene name. */
const getObjectsContainer = (project: any, scope: string): any => {
  if (scope === 'global' || scope === '') {
    return project.getObjects();
  }
  return findScene(project, scope).getObjects();
};

const listObjectsIn = (container: any, scope: string): Array<any> => {
  const objects = [];
  for (let i = 0; i < container.getObjectsCount(); i++) {
    const object = container.getObjectAt(i);
    const serialized = serializeToJSObject(object);
    objects.push({
      name: object.getName(),
      type: object.getType(),
      scope,
      behaviors: (serialized && serialized.behaviors) || [],
    });
  }
  return objects;
};

// ---------------------------------------------------------------------------
// Events write pipeline — the same one the built-in AI uses.
// ---------------------------------------------------------------------------

const normalizeOperationsFromRequestBody = (
  body: any,
  sceneEventsCount: number
): Array<any> => {
  if (!body || typeof body !== 'object') {
    throw new ApiError(400, 'Missing JSON body.');
  }

  // Shape 1 (recommended): { operations: [ { operationName, ... } ] }
  if (Array.isArray(body.operations)) {
    return body.operations.map((operation: any, index: number) => {
      if (!operation || typeof operation !== 'object') {
        throw new ApiError(400, `operations[${index}] must be an object.`);
      }
      if (!operation.operationName) {
        throw new ApiError(
          400,
          `operations[${index}].operationName is required (insert_at_end, insert_before_event, insert_after_event, insert_as_sub_event, insert_and_replace_event, replace_entire_event_and_sub_events, replace_event_but_keep_existing_sub_events, insert_actions_conditions_at_end, insert_actions_conditions_at_start, replace_all_actions, replace_all_conditions, delete_event).`
        );
      }
      return operation;
    });
  }

  // Shape 2 (shortcut): { events: [...], mode: "append" | "replace" }
  if (body.events !== undefined) {
    const events = body.events;
    const mode = body.mode === 'replace' ? 'replace' : 'append';
    if (mode === 'append') {
      return [
        {
          operationName: 'insert_at_end',
          operationTargetEvent: null,
          generatedEvents: events,
        },
      ];
    }
    // Replace the whole list: delete every top-level event, then insert.
    const operations = [];
    if (sceneEventsCount > 0) {
      const allIndices = Array.from(
        { length: sceneEventsCount },
        (_, i) => `event-${i}`
      ).join(',');
      operations.push({
        operationName: 'delete_event',
        operationTargetEvent: allIndices,
        generatedEvents: null,
      });
    }
    operations.push({
      operationName: 'insert_at_end',
      operationTargetEvent: null,
      generatedEvents: events,
    });
    return operations;
  }

  throw new ApiError(
    400,
    'Body must contain either "operations" (recommended) or "events" + "mode".'
  );
};

const stringifyGeneratedEvents = (generatedEvents: any): string | null => {
  if (generatedEvents === null || generatedEvents === undefined) return null;
  if (typeof generatedEvents === 'string') return generatedEvents;
  return JSON.stringify(generatedEvents);
};

const applyEventsOperations = (
  project: any,
  scene: any,
  body: any
): any => {
  const operations = normalizeOperationsFromRequestBody(
    body,
    scene.getEvents().getEventsCount()
  );

  const changes = operations.map((operation: any) => ({
    operationName: operation.operationName,
    operationTargetEvent: operation.operationTargetEvent || null,
    generatedEvents: stringifyGeneratedEvents(operation.generatedEvents),
    undeclaredVariables: operation.undeclaredVariables || [],
    undeclaredObjectVariables: operation.undeclaredObjectVariables || {},
    missingObjectBehaviors: operation.missingObjectBehaviors || {},
    extensionNames: operation.extensionNames || [],
    missingResources: operation.missingResources || [],
    diagnosticLines: [],
  }));

  // Optional pre-flight validation against the real engine metadata.
  const shouldValidate = body.validate !== false;
  const diagnostics: Array<string> = [];
  if (shouldValidate) {
    for (const change of changes) {
      if (!change.generatedEvents) continue;
      try {
        const events = normalizeGeneratedEventsContent(
          JSON.parse(change.generatedEvents)
        );
        if (Array.isArray(events)) {
          const eventsDiagnostics = validateEventsAgainstMetadata(events);
          diagnostics.push(...eventsDiagnostics);
        }
      } catch (parseError) {
        diagnostics.push(
          `generatedEvents is not valid JSON: ${String(parseError)}`
        );
      }
    }
    if (diagnostics.length > 0 && body.strict !== false) {
      throw new ApiError(
        400,
        'Events did not pass validation against the engine metadata. Fix the diagnostics and retry, or set "strict": false to apply anyway.',
        { diagnostics }
      );
    }
  }

  // Snapshot before writing so the change can be reverted.
  const backup = makeBackup(
    scene,
    `${changes.length} operation(s) via bridge`
  );

  // Declare variables / behaviors the events rely on (same as built-in AI).
  for (const change of changes) {
    if (change.undeclaredVariables && change.undeclaredVariables.length) {
      addUndeclaredVariables({
        project,
        scene,
        undeclaredVariables: change.undeclaredVariables,
      });
    }
    const objectNamesWithVariables = Object.keys(change.undeclaredObjectVariables);
    for (const objectName of objectNamesWithVariables) {
      addObjectUndeclaredVariables({
        project,
        scene,
        objectName,
        undeclaredVariables: change.undeclaredObjectVariables[objectName],
      });
    }
    const objectNamesWithBehaviors = Object.keys(change.missingObjectBehaviors);
    for (const objectName of objectNamesWithBehaviors) {
      addMissingObjectBehaviors({
        project,
        scene,
        objectName,
        missingBehaviors: change.missingObjectBehaviors[objectName],
      });
    }
  }

  const aiGeneratedEventId = `bridge-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const { applied, errors } = applyEventsChanges(
    project,
    scene.getEvents(),
    changes,
    aiGeneratedEventId
  );

  notifySceneEventsChanged(scene, new Set([aiGeneratedEventId]));

  pushBridgeLog(
    'write',
    `Events written to scene "${scene.getName()}": ${applied} applied, ${
      errors.length
    } error(s)`,
    errors.length ? errors.join('\n') : undefined
  );

  return {
    applied,
    errors,
    aiGeneratedEventId,
    backupIndex: backup.index,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
};

// ---------------------------------------------------------------------------
// /eval — the escape hatch: run a snippet with editor access.
// ---------------------------------------------------------------------------

const runEval = async (code: string): Promise<any> => {
  const project = getProject();
  const helpers = {
    serializeToJSObject,
    unserializeFromJSObject,
    renderEventsAsText: (eventsList: any) =>
      renderNonTranslatedEventsAsText({ eventsList }),
    notifyEventsChanged: (scene: any) => {
      notifySceneEventsChanged(scene, new Set());
    },
    notifyObjectsChanged: (scene: any) => {
      notifyObjectsChanged(scene, false);
    },
    saveProject: () => (context.onSave ? context.onSave() : null),
    log: (message: string) => pushBridgeLog('agent', String(message)),
  };
  const ctx = { gd, project, helpers, window };
  const fn = new Function(
    'ctx',
    'return (async () => {' + code + '})();'
  );
  const result = await fn(ctx);
  return result;
};

const stringifyEvalResult = (result: any): any => {
  if (result === undefined) return null;
  if (result === null) return null;
  try {
    return JSON.parse(JSON.stringify(result));
  } catch (ignored) {
    return String(result);
  }
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const parseQuery = (queryString: string): URLSearchParams =>
  new URLSearchParams(queryString || '');

const splitPath = (path: string): Array<string> =>
  (path || '/')
    .split('/')
    .filter(segment => segment.length > 0)
    .map(segment => {
      try {
        return decodeURIComponent(segment);
      } catch (ignored) {
        return segment;
      }
    });

const parseBodyJson = (body: string): any => {
  if (!body || !body.trim()) {
    throw new ApiError(400, 'Missing JSON body.');
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new ApiError(400, `Body is not valid JSON: ${String(error)}`);
  }
};

const route = async (
  method: string,
  segments: Array<string>,
  query: URLSearchParams,
  bodyString: string
): Promise<{ status: number, json: any }> => {
  const [first, second, third] = segments;

  // ----- Manifest & guide (GET / and GET /manifest) ---------------------
  if ((first === undefined || first === '') && method === 'GET') {
    return ok(buildManifest(getProjectOrNull(), query));
  }
  if (first === 'manifest' && method === 'GET') {
    return ok(buildManifest(getProjectOrNull(), query));
  }

  if (first === 'status' && method === 'GET') {
    const project = getProjectOrNull();
    return ok({
      bridge: '1',
      contextReady: !!project,
      project: project
        ? {
            name: project.getName(),
            scenes: project.getLayoutsCount(),
            eventsFunctionsExtensions: project.getEventsFunctionsExtensionsCount(),
          }
        : null,
      backups: backups.map(backup => ({
        index: backup.index,
        ts: backup.ts,
        sceneName: backup.sceneName,
        reason: backup.reason,
      })),
    });
  }

  // ----- Project reads ----------------------------------------------------
  if (first === 'project' && method === 'GET') {
    if (second === 'simplified') {
      const project = getProject();
      return ok({ simplifiedProject: JSON.parse(getSimplifiedProjectJson(project)) });
    }
    if (second === 'digest') {
      const project = getProject();
      return ok({ digest: buildProjectDigest(getSimplifiedProjectJson(project), null) });
    }
    if (second === 'full' || second === undefined) {
      const project = getProject();
      return ok({ project: serializeToJSObject(project) });
    }
  }

  // ----- Scenes -----------------------------------------------------------
  if (first === 'scenes') {
    if (second === undefined && method === 'GET') {
      const project = getProject();
      const scenes = [];
      for (let i = 0; i < project.getLayoutsCount(); i++) {
        const layout = project.getLayoutAt(i);
        scenes.push({
          name: layout.getName(),
          eventsCount: countEventsDeeply(layout.getEvents()),
          objectsCount: layout.getObjects().getObjectsCount(),
        });
      }
      return ok({ scenes });
    }
    if (second !== undefined && third === undefined && method === 'POST') {
      // Create a scene.
      const project = getProject();
      const body = parseBodyJson(bodyString);
      const sceneName = body.name || second;
      if (!sceneName) {
        return fail(400, 'Scene name missing ({"name": "MyScene"}).');
      }
      if (project.hasLayoutNamed(sceneName)) {
        return fail(409, `Scene already exists: "${sceneName}".`);
      }
      project.insertNewLayout(sceneName, project.getLayoutsCount());
      pushBridgeLog('write', `Scene created: "${sceneName}"`);
      if (body.open && context.openLayout) {
        context.openLayout(sceneName, {
          openEventsEditor: true,
          openSceneEditor: true,
          focusWhenOpened: 'events',
        });
      }
      return ok({ scene: sceneName });
    }
    if (second !== undefined && third === 'events') {
      const project = getProject();
      const scene = findScene(project, second);
      if (method === 'GET') {
        const format = query.get('format') || 'text';
        if (format === 'json') {
          return ok({ events: serializeToJSObject(scene.getEvents()) });
        }
        return ok({
          eventsAsText: renderNonTranslatedEventsAsText({
            eventsList: scene.getEvents(),
          }),
        });
      }
      if (method === 'POST' || method === 'PUT') {
        const body = parseBodyJson(bodyString);
        const result = applyEventsOperations(project, scene, body);
        return ok(result);
      }
    }
  }

  if (first === 'open-scene' && method === 'POST') {
    const body = parseBodyJson(bodyString);
    const project = getProject();
    findScene(project, body.name);
    if (!context.openLayout) {
      return fail(500, 'The editor did not register its scene-opening routine.');
    }
    context.openLayout(body.name, {
      openEventsEditor: true,
      openSceneEditor: true,
      focusWhenOpened: 'events',
    });
    return ok({ opened: body.name });
  }

  // ----- Validation dry-run ------------------------------------------------
  if (first === 'validate-events' && method === 'POST') {
    const body = parseBodyJson(bodyString);
    let events = body.events !== undefined ? body.events : body;
    if (typeof events === 'string') {
      try {
        events = JSON.parse(events);
      } catch (error) {
        return fail(400, `events is not valid JSON: ${String(error)}`);
      }
    }
    events = normalizeGeneratedEventsContent(events);
    if (!Array.isArray(events)) {
      return fail(400, 'events must be a JSON array (after normalization).');
    }
    const diagnostics = validateEventsAgainstMetadata(events);
    return ok({
      valid: diagnostics.length === 0,
      ...(diagnostics.length ? { diagnostics } : {}),
    });
  }

  // ----- Objects -----------------------------------------------------------
  if (first === 'objects') {
    const project = getProject();
    if (second === undefined && method === 'GET') {
      const objects = [
        ...listObjectsIn(project.getObjects(), 'global'),
      ];
      for (let i = 0; i < project.getLayoutsCount(); i++) {
        const layout = project.getLayoutAt(i);
        objects.push(
          ...listObjectsIn(layout.getObjects(), layout.getName())
        );
      }
      return ok({ objects });
    }
    if (second !== undefined && method === 'GET') {
      const scope = query.get('scope');
      const searchContainers = scope
        ? [getObjectsContainer(project, scope)]
        : [project.getObjects()].concat(
            ...Array.from(
              { length: project.getLayoutsCount() },
              (_, i) => project.getLayoutAt(i).getObjects()
            )
          );
      for (const container of searchContainers) {
        if (container.hasObjectNamed(second)) {
          return ok({ object: serializeToJSObject(container.getObject(second)) });
        }
      }
      return fail(404, `Object not found: "${second}".`);
    }
    if (second !== undefined && (method === 'PUT' || method === 'POST')) {
      const body = parseBodyJson(bodyString);
      const objectJson = body.object || body;
      const scope = body.scope || 'global';
      if (!objectJson || !objectJson.type) {
        return fail(400, 'Body must contain an object definition with a "type".');
      }
      if (typeof objectJson.name === 'object' && objectJson.name.value) {
        objectJson.name = objectJson.name.value;
      }
      const container = getObjectsContainer(project, scope);
      const type = objectJson.type;
      const isNewObjectTypeUsed = !isTypeAlreadyUsed(project, type);

      let created = false;
      if (container.hasObjectNamed(second)) {
        const existing = container.getObject(second);
        if (existing.getType() !== type) {
          return fail(
            400,
            `Object "${second}" exists with type "${existing.getType()}" — object types cannot be changed in place.`
          );
        }
        unserializeFromJSObject(existing, objectJson, 'unserializeFrom', project);
        existing.setName(second);
      } else {
        const createdObject = container.insertNewObject(
          project,
          type,
          second,
          container.getObjectsCount()
        );
        unserializeFromJSObject(
          createdObject,
          objectJson,
          'unserializeFrom',
          project
        );
        createdObject.setName(second);
        created = true;
      }
      const sceneForNotification =
        scope === 'global' || scope === '' ? anyScene(project) : project.getLayout(scope);
      if (sceneForNotification) {
        notifyObjectsChanged(sceneForNotification, isNewObjectTypeUsed);
      }
      pushBridgeLog(
        'write',
        `${created ? 'Object created' : 'Object updated'}: "${second}" (${type}, scope: ${scope})`
      );
      return ok({ object: second, type, scope, created });
    }
  }

  // ----- Resources ----------------------------------------------------------
  if (first === 'resources' && method === 'GET') {
    const project = getProject();
    const resourcesManager = project.getResourcesManager();
    const names = resourcesManager.getAllResourceNames().toJSArray();
    const resources = names.map((name: string) => {
      const resource = resourcesManager.getResource(name);
      return {
        name,
        kind: resource.getKind(),
        file: resource.getFile(),
      };
    });
    return ok({ resources });
  }

  // ----- Events functions extensions ---------------------------------------
  if (first === 'extensions') {
    const project = getProject();
    if (second === undefined && method === 'GET') {
      const extensions = [];
      for (let i = 0; i < project.getEventsFunctionsExtensionsCount(); i++) {
        const extension = project.getEventsFunctionsExtensionAt(i);
        extensions.push({
          name: extension.getName(),
          fullName: extension.getFullName(),
          version: extension.getVersion(),
          description: extension.getDescription(),
        });
      }
      return ok({ extensions });
    }
    if (second !== undefined && (method === 'PUT' || method === 'POST')) {
      const body = parseBodyJson(bodyString);
      const extensionJson = body.extension || body;
      if (!extensionJson || !extensionJson.name) {
        return fail(400, 'Body must contain an extension definition with a "name".');
      }
      if (typeof extensionJson.name === 'object' && extensionJson.name.value) {
        extensionJson.name = extensionJson.name.value;
      }
      const isNew = !project.hasEventsFunctionsExtensionNamed(second);
      let extension;
      if (isNew) {
        extension = project.insertNewEventsFunctionsExtension(second, 0);
      } else {
        extension = project.getEventsFunctionsExtension(second);
      }
      unserializeFromJSObject(extension, extensionJson);
      extension.setName(second);
      if (context.onExtensionInstalled) {
        try {
          context.onExtensionInstalled([second]);
        } catch (error) {
          pushBridgeLog('error', 'Extension refresh failed', String(error));
        }
      }
      pushBridgeLog(
        'write',
        `${isNew ? 'Extension installed' : 'Extension updated'}: "${second}"`
      );
      return ok({ extension: second, created: isNew });
    }
  }

  // ----- Instruction cheatsheet ---------------------------------------------
  if (first === 'instructions' && second === 'cheatsheet' && method === 'GET') {
    const project = getProject();
    const sceneName = query.get('scene');
    const searchQuery = query.get('query') || query.get('q') || '';
    let eventsDescription = searchQuery;
    if (sceneName) {
      const scene = findScene(project, sceneName);
      eventsDescription =
        eventsDescription +
        ' ' +
        renderNonTranslatedEventsAsText({ eventsList: scene.getEvents() });
    }
    const cheatsheet = buildInstructionCheatsheet({
      simplifiedProjectJson: getSimplifiedProjectJson(project),
      eventsDescription,
      extensionNamesList: query.get('extensions') || '',
    });
    return ok({ cheatsheet });
  }

  // ----- Save -----------------------------------------------------------------
  if (first === 'save' && method === 'POST') {
    const project = getProject();
    if (!context.onSave) {
      return fail(500, 'The editor did not register its save routine.');
    }
    pushBridgeLog('info', 'Saving project (asked by agent)…');
    try {
      const fileMetadata = await context.onSave();
      return ok({
        saved: !!fileMetadata,
        ...(fileMetadata ? { file: fileMetadata } : {}),
        note: fileMetadata
          ? undefined
          : 'The save dialog may be waiting for the user (first save needs a location).',
      });
    } catch (error) {
      pushBridgeLog('error', 'Save failed', String(error));
      return fail(500, `Save failed: ${String(error)}`);
    }
  }

  // ----- Logs ------------------------------------------------------------------
  if (first === 'logs' && method === 'GET') {
    const limitParameter = query.get('limit');
    const limit = limitParameter ? parseInt(limitParameter, 10) : 100;
    const logs = getBridgeLogs().slice(-limit);
    return ok({ logs });
  }
  if (first === 'log' && method === 'POST') {
    const body = parseBodyJson(bodyString);
    const level = ['info', 'agent', 'write', 'error'].includes(body.level)
      ? body.level
      : 'agent';
    pushBridgeLog(level, String(body.message || '(empty message)'));
    return ok({});
  }

  // ----- Backups & revert --------------------------------------------------------
  if (first === 'backups' && method === 'GET') {
    return ok({
      backups: backups.map(backup => ({
        index: backup.index,
        ts: backup.ts,
        sceneName: backup.sceneName,
        reason: backup.reason,
      })),
    });
  }
  if (first === 'backup' && method === 'POST') {
    const project = getProject();
    const body = bodyString ? parseBodyJson(bodyString) : {};
    const scenesToSnapshot = body.scene
      ? [findScene(project, body.scene)]
      : Array.from(
          { length: project.getLayoutsCount() },
          (_, i) => project.getLayoutAt(i)
        );
    const created = scenesToSnapshot.map(scene =>
      makeBackup(scene, 'manual snapshot via bridge')
    );
    return ok({
      backups: created.map(backup => ({
        index: backup.index,
        sceneName: backup.sceneName,
      })),
    });
  }
  if (first === 'revert' && method === 'POST') {
    const project = getProject();
    const body = parseBodyJson(bodyString);
    const backup = backups.find(candidate => candidate.index === body.index);
    if (!backup) {
      return fail(404, `Backup not found: ${body.index}. Use GET /backups.`);
    }
    const scene = findScene(project, backup.sceneName);
    unserializeFromJSObject(
      scene.getEvents(),
      JSON.parse(backup.eventsJson)
    );
    notifySceneEventsChanged(scene, new Set());
    pushBridgeLog('write', `Reverted scene "${scene.getName()}" to backup #${backup.index}`);
    return ok({ reverted: backup.index, scene: scene.getName() });
  }

  // ----- eval ---------------------------------------------------------------------
  if (first === 'eval' && method === 'POST') {
    const body = parseBodyJson(bodyString);
    if (!body.code || typeof body.code !== 'string') {
      return fail(400, 'Body must contain {"code": "…javascript…"}.');
    }
    pushBridgeLog('info', 'Running eval snippet…');
    try {
      const result = await runEval(body.code);
      pushBridgeLog('info', 'Eval finished.');
      return ok({ result: stringifyEvalResult(result) });
    } catch (error) {
      pushBridgeLog('error', 'Eval failed', String(error));
      return fail(500, `Eval error: ${String(error && error.message ? error.message : error)}`);
    }
  }

  return fail(
    404,
    `Unknown route: ${method} /${segments.join('/')}. GET / lists everything.`
  );
};

const getProjectOrNull = (): any | null => {
  try {
    return context.project || null;
  } catch (ignored) {
    return null;
  }
};

const isTypeAlreadyUsed = (project: any, type: string): boolean => {
  const containers = [project.getObjects()].concat(
    Array.from(
      { length: project.getLayoutsCount() },
      (_, i) => project.getLayoutAt(i).getObjects()
    )
  );
  return containers.some(container => {
    for (let i = 0; i < container.getObjectsCount(); i++) {
      if (container.getObjectAt(i).getType() === type) return true;
    }
    return false;
  });
};

// ---------------------------------------------------------------------------
// Entry point, called by the AgentBridgeServer when the native plugin
// forwards an HTTP request.
// ---------------------------------------------------------------------------

export const handleBridgeRequest = async (payload: {
  method: string,
  path: string,
  query: string,
  body: string,
}): Promise<{ status: number, body: string }> => {
  const { method, path, query, body } = payload;
  const methodUpper = (method || 'GET').toUpperCase();
  pushBridgeLog(
    'request',
    `${methodUpper} ${path}${query ? '?' + query : ''}`
  );
  try {
    const segments = splitPath(path);
    const parsedQuery = parseQuery(query);
    // Never let the token leak into logs.
    if (parsedQuery.has('token')) {
      parsedQuery.delete('token');
    }
    const { status, json } = await route(methodUpper, segments, parsedQuery, body || '');
    if (status >= 400) {
      pushBridgeLog('error', `→ ${status} ${json.error || ''}`);
    }
    return { status, body: JSON.stringify(json) };
  } catch (error) {
    if (error instanceof ApiError) {
      pushBridgeLog('error', `→ ${error.status} ${error.message}`);
      return {
        status: error.status,
        body: JSON.stringify({
          ok: false,
          error: error.message,
          ...(error.extra || {}),
        }),
      };
    }
    pushBridgeLog('error', `→ 500 ${String(error)}`);
    return {
      status: 500,
      body: JSON.stringify({
        ok: false,
        error: String(error && error.message ? error.message : error),
      }),
    };
  }
};
