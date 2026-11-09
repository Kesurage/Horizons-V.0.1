// @flow
/**
 * Real-instruction cheatsheet for the offline AI events compiler.
 *
 * The AI used to GUESS instruction names ("ParticleSystem might have bullet
 * functionality...") and parameter counts, then fail validation over and
 * over — burning free-tier requests. This module enumerates the ACTUAL
 * conditions/actions from the engine metadata (the very same data the
 * editor's instruction picker uses), so the model is told exactly:
 *   - which instruction types exist (and their exact serialized name),
 *   - how many parameters each takes, and what to put in each slot.
 *
 * It also validates a model-produced events JSON against the metadata,
 * returning precise "unknown instruction, did you mean X?" diagnostics.
 */

const gd: libGDevelop = global.gd;

/** Extensions whose instructions are always documented (core game logic). */
const CORE_EXTENSION_NAMES = [
  'BuiltinObject',
  'BuiltinCommonInstructions',
  'BuiltinKeyboard',
  'BuiltinMouse',
  'BuiltinVariables',
  'BuiltinScene',
  'BuiltinCamera',
  'BuiltinAudio',
  'BuiltinTime',
  'BuiltinStringInstructions',
  'BuiltinMathematicalTools',
];

/** Event types natively supported by the events sheet. */
export const KNOWN_EVENT_TYPES = [
  'BuiltinCommonInstructions::Standard',
  'BuiltinCommonInstructions::Comment',
  'BuiltinCommonInstructions::ForEach',
  'BuiltinCommonInstructions::ForEachChildVariable',
  'BuiltinCommonInstructions::Repeat',
  'BuiltinCommonInstructions::While',
  'BuiltinCommonInstructions::Link',
  'BuiltinCommonInstructions::Group',
  'BuiltinCommonInstructions::Else',
  'BuiltinCommonInstructions::JsCode',
  'BuiltinCommonInstructions::Async',
  'Builtin::Include',
  'BuiltinCommonInstructions::Or',
  'BuiltinCommonInstructions::Once',
];

const MAX_CHEATSHEET_CHARS = 15000;
const MAX_KEYWORD_MATCHES = 40;

type InstructionSummary = {|
  type: string,
  isCondition: boolean,
  extensionName: string,
  fullName: string,
  parametersLine: string,
|};

/** Human placeholder for a parameter, derived from its metadata. */
const parameterPlaceholder = (parameter: gdParameterMetadata): string => {
  const type = parameter.getType();
  const name = parameter.getName();
  if (parameter.isCodeOnly()) {
    // Code-only parameters are still serialized — almost always "".
    return `"" (${name || 'automatic'})`;
  }
  try {
    if (gd.ParameterMetadata.isObject(type)) return `"${'<object name>'}"`;
    if (gd.ParameterMetadata.isBehavior(type)) return `"${'<behavior name>'}"`;
  } catch (ignored) {
    // Metadata API unavailable — fall through to the generic placeholder.
  }
  if (type === 'string' || type === 'textarea') return `"${'<text>'}"`;
  if (type === 'expression' || type === 'expressionWithVariable') {
    return `"${'<expression>'}"`;
  }
  if (type === 'sceneName') return `""`;
  if (type === 'layer') return `"${'<layer or empty for base>'}"`;
  if (type === 'key') return `"${'<key e.g. Space>'}"`;
  if (type === 'color') return `"${'<R;G;B e.g. 255;0;0>'}"`;
  // Generic case: the parameter NAME is the best hint of what to fill in.
  return `"${'<' + (name || type || 'value') + '>'}"`;
};

/** Render one instruction as a compact, model-friendly line. */
const renderInstructionLine = (
  summary: InstructionSummary
): string => {
  const kind = summary.isCondition ? 'condition' : 'action';
  return `- ${summary.isCondition ? 'IF' : 'DO'} "${
    summary.type
  }" (${kind}, ${summary.extensionName})${
    summary.fullName ? ` — ${summary.fullName}` : ''
  } — parameters: [${summary.parametersLine}]`;
};

const summarizeInstruction = (
  type: string,
  metadata: gdInstructionMetadata,
  isCondition: boolean,
  extensionName: string
): InstructionSummary => {
  const parameters: Array<string> = [];
  const count = metadata.getParametersCount();
  for (let i = 0; i < count; i++) {
    // $FlowFixMe[incompatible-call]
    parameters.push(parameterPlaceholder(metadata.getParameter(i)));
  }
  return {
    type,
    isCondition,
    extensionName,
    fullName: metadata.getFullName(),
    parametersLine: parameters.join(', '),
  };
};

/** Iterate the (type → metadata) map of an extension. */
const collectFromInstructionMap = (
  instructions: gdMapStringInstructionMetadata,
  isCondition: boolean,
  extensionName: string,
  output: Map<string, InstructionSummary>
): void => {
  try {
    const keys = instructions.keys();
    for (let i = 0; i < keys.size(); i++) {
      const type = keys.at(i);
      const metadata = instructions.get(type);
      if (!metadata || metadata.isHidden()) continue;
      if (!metadata.isRelevantForLayoutEvents()) continue;
      if (output.has(type)) continue;
      output.set(
        type,
        summarizeInstruction(type, metadata, isCondition, extensionName)
      );
    }
  } catch (ignored) {
    // Malformed extension metadata: skip it silently.
  }
};

const tokenize = (text: string): Array<string> =>
  (text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 3);

/**
 * Build the cheatsheet of REAL instructions relevant to the current
 * compilation: core builtins + everything usable with the project's
 * object/behavior types + hinted extensions + keyword matches from the
 * request itself.
 */
export const buildInstructionCheatsheet = ({
  simplifiedProjectJson,
  eventsDescription,
  extensionNamesList,
}: {|
  simplifiedProjectJson: ?string,
  eventsDescription: string,
  extensionNamesList?: string,
|}): string => {
  if (typeof gd === 'undefined' || !gd.JsPlatform) {
    return ''; // Engine not loaded (e.g. in tests): no cheatsheet.
  }

  // 1) Gather the object types / behavior types actually used by the project.
  const objectTypes = new Set<string>();
  const behaviorTypes = new Set<string>();
  if (simplifiedProjectJson) {
    try {
      const simplified = JSON.parse(simplifiedProjectJson);
      const collectFromObjects = objects => {
        if (!Array.isArray(objects)) return;
        objects.forEach(obj => {
          if (obj && obj.objectType) objectTypes.add(obj.objectType);
          if (obj && obj.type && typeof obj.type === 'string') {
            objectTypes.add(obj.type);
          }
          if (obj && Array.isArray(obj.behaviors)) {
            obj.behaviors.forEach(behavior => {
              if (behavior && behavior.behaviorType) {
                behaviorTypes.add(behavior.behaviorType);
              } else if (behavior && behavior.type) {
                behaviorTypes.add(behavior.type);
              }
            });
          }
        });
      };
      collectFromObjects(
        simplified &&
          (simplified.globalObjects ||
            (simplified.objects && simplified.objects.objects) ||
            simplified.objects)
      );
      if (simplified && Array.isArray(simplified.sceneNames)) {
        // Not used directly — scenes carry their own objects below.
      }
      if (simplified && Array.isArray(simplified.scenes)) {
        simplified.scenes.forEach(scene =>
          collectFromObjects(scene && scene.objects)
        );
      }
      if (simplified && simplified.scenes) {
        // Older shape: { layouts: [...] } — support both.
      }
      if (simplified && Array.isArray(simplified.layouts)) {
        simplified.layouts.forEach(layout =>
          collectFromObjects(layout && layout.objects)
        );
      }
    } catch (ignored) {
      // Best-effort: continue with what was collected.
    }
  }

  // 2) Extensions explicitly hinted by the agent.
  const hintedExtensionNames = new Set<string>();
  (extensionNamesList || '')
    .split(/[,[\]"']/)
    .map(name => name.trim())
    .filter(name => name.length > 1)
    .forEach(name => hintedExtensionNames.add(name));

  // 3) Enumerate the platform.
  const included = new Map<string, InstructionSummary>();
  // Everything indexed for keyword search + "did you mean" suggestions.
  const searchable: Array<InstructionSummary> = [];
  const extensionObjectTypesCache = new Map<string, Array<string>>();
  const extensionBehaviorTypesCache = new Map<string, Array<string>>();

  let allExtensions;
  try {
    allExtensions = gd.asPlatform(gd.JsPlatform.get()).getAllPlatformExtensions();
  } catch (ignored) {
    return '';
  }

  for (let i = 0; i < allExtensions.size(); i++) {
    const extension = allExtensions.at(i);
    const extensionName = extension.getName();

    const objectTypesOfExtension =
      extensionObjectTypesCache.get(extensionName) ||
      extension.getExtensionObjectsTypes().toJSArray();
    extensionObjectTypesCache.set(extensionName, objectTypesOfExtension);

    const behaviorTypesOfExtension =
      extensionBehaviorTypesCache.get(extensionName) ||
      extension.getBehaviorsTypes().toJSArray();
    extensionBehaviorTypesCache.set(extensionName, behaviorTypesOfExtension);

    const relevantObjectTypes = objectTypesOfExtension.filter(type =>
      objectTypes.has(type)
    );
    const relevantBehaviorTypes = behaviorTypesOfExtension.filter(type =>
      behaviorTypes.has(type)
    );

    const isCore = CORE_EXTENSION_NAMES.indexOf(extensionName) !== -1;
    const isHinted = hintedExtensionNames.has(extensionName);
    const hasRelevantObjects = relevantObjectTypes.length > 0;
    const hasRelevantBehaviors = relevantBehaviorTypes.length > 0;

    // Index everything for keyword search (cheap, no string building yet).
    const indexMap = (
      instructions: gdMapStringInstructionMetadata,
      isCondition: boolean
    ) => {
      try {
        const keys = instructions.keys();
        for (let j = 0; j < keys.size(); j++) {
          const type = keys.at(j);
          const metadata = instructions.get(type);
          if (!metadata || metadata.isHidden()) continue;
          if (!metadata.isRelevantForLayoutEvents()) continue;
          const summary = summarizeInstruction(
            type,
            metadata,
            isCondition,
            extensionName
          );
          searchable.push(summary);
        }
      } catch (ignored) {
        // Ignore malformed maps.
      }
    };
    indexMap(extension.getAllConditions(), true);
    indexMap(extension.getAllActions(), false);

    // Include the ones relevant to THIS compilation right away.
    if (isCore || isHinted) {
      collectFromInstructionMap(
        extension.getAllConditions(),
        true,
        extensionName,
        included
      );
      collectFromInstructionMap(
        extension.getAllActions(),
        false,
        extensionName,
        included
      );
    }
    relevantObjectTypes.forEach(objectType => {
      collectFromInstructionMap(
        extension.getAllConditionsForObject(objectType),
        true,
        extensionName,
        included
      );
      collectFromInstructionMap(
        extension.getAllActionsForObject(objectType),
        false,
        extensionName,
        included
      );
    });
    relevantBehaviorTypes.forEach(behaviorType => {
      collectFromInstructionMap(
        extension.getAllConditionsForBehavior(behaviorType),
        true,
        extensionName,
        included
      );
      collectFromInstructionMap(
        extension.getAllActionsForBehavior(behaviorType),
        false,
        extensionName,
        included
      );
    });
  }

  // 4) Keyword matches from the requested logic (e.g. "shoot", "bullet").
  const keywords = tokenize(
    `${eventsDescription || ''} ${extensionNamesList || ''}`
  );
  const keywordMatched = new Set<string>();
  if (keywords.length > 0) {
    searchable.forEach(summary => {
      if (included.has(summary.type)) return;
      const haystack = `${summary.type} ${summary.fullName}`.toLowerCase();
      if (keywords.some(keyword => haystack.indexOf(keyword) !== -1)) {
        keywordMatched.add(summary.type);
      }
    });
    // Materialize the matched ones (bounded).
    let added = 0;
    for (const summary of searchable) {
      if (added >= MAX_KEYWORD_MATCHES) break;
      if (keywordMatched.has(summary.type) && !included.has(summary.type)) {
        included.set(summary.type, summary);
        added++;
      }
    }
  }

  // 5) Render, conditions first, then actions; then truncate to budget.
  const lines: Array<string> = [
    '# REAL INSTRUCTIONS AVAILABLE IN THIS PROJECT (exact serialized names)',
    'Use ONLY these "type" values. Each line shows the exact parameter count',
    'and what to put in each slot of the "parameters" array (in order).',
    '',
  ];
  const summaries = Array.from(included.values());
  const conditions = summaries.filter(s => s.isCondition);
  const actions = summaries.filter(s => !s.isCondition);
  lines.push('## Conditions');
  conditions.forEach(summary => lines.push(renderInstructionLine(summary)));
  lines.push('', '## Actions');
  actions.forEach(summary => lines.push(renderInstructionLine(summary)));

  let cheatsheet = lines.join('\n');
  if (cheatsheet.length > MAX_CHEATSHEET_CHARS) {
    cheatsheet = cheatsheet.slice(0, MAX_CHEATSHEET_CHARS) + '\n… (truncated)';
  }
  return cheatsheet;
};

// ---------------------------------------------------------------------------
// Validation of model-produced events JSON against the real metadata
// ---------------------------------------------------------------------------

const getInstructionTypeFromSerialized = (instruction: any): ?string => {
  if (!instruction || typeof instruction !== 'object') return null;
  const rawType = instruction.type;
  if (typeof rawType === 'string') return rawType;
  if (rawType && typeof rawType === 'object' && typeof rawType.value === 'string') {
    return rawType.value;
  }
  return null;
};

const getInstructionsArray = (event: any, key: string): Array<any> => {
  const raw = event ? event[key] : null;
  return Array.isArray(raw) ? raw : [];
};

const closestInstructionType = (
  unknownType: string
): ?string => {
  if (typeof gd === 'undefined' || !gd.JsPlatform) return null;
  const normalized = unknownType.toLowerCase();
  const candidates: Array<string> = [];
  try {
    const allExtensions = gd
      .asPlatform(gd.JsPlatform.get())
      .getAllPlatformExtensions();
    for (let i = 0; i < allExtensions.size(); i++) {
      const extension = allExtensions.at(i);
      const collect = instructions => {
        try {
          const keys = instructions.keys();
          for (let j = 0; j < keys.size(); j++) {
            candidates.push(keys.at(j));
          }
        } catch (ignored) {}
      };
      collect(extension.getAllConditions());
      collect(extension.getAllActions());
    }
  } catch (ignored) {
    return null;
  }
  // Exact case-insensitive match first, then prefix/substring.
  const exact = candidates.find(
    candidate => candidate.toLowerCase() === normalized
  );
  if (exact) return exact;
  const partial = candidates.find(
    candidate =>
      candidate.toLowerCase().indexOf(normalized) !== -1 ||
      normalized.indexOf(candidate.toLowerCase()) !== -1
  );
  return partial || null;
};

const isKnownInstructionType = (
  type: string,
  isCondition: boolean
): boolean => {
  if (typeof gd === 'undefined' || !gd.MetadataProvider) return true;
  try {
    const metadata = isCondition
      ? gd.MetadataProvider.getConditionMetadata(gd.JsPlatform.get(), type)
      : gd.MetadataProvider.getActionMetadata(gd.JsPlatform.get(), type);
    return !gd.MetadataProvider.isBadInstructionMetadata(metadata);
  } catch (ignored) {
    // Metadata lookup can throw for unknown types on some builds.
    return false;
  }
};

/**
 * Validate an events JSON array (already normalized to a plain array)
 * against the real engine metadata. Returns a list of precise,
 * actionable diagnostics — empty when everything checks out.
 */
export const validateEventsAgainstMetadata = (
  events: Array<any>
): Array<string> => {
  const diagnostics: Array<string> = [];

  const checkInstructions = (
    instructions: Array<any>,
    isCondition: boolean,
    path: string
  ) => {
    instructions.forEach((instruction, index) => {
      const type = getInstructionTypeFromSerialized(instruction);
      if (!type) {
        diagnostics.push(
          `${path}: ${isCondition ? 'condition' : 'action'} #${index +
            1} has no valid "type". Use {"type": {"value": "<name>"}}.`
        );
        return;
      }
      if (!isKnownInstructionType(type, isCondition)) {
        const suggestion = closestInstructionType(type);
        diagnostics.push(
          `${path}: ${isCondition ? 'condition' : 'action'} "${type}" does NOT exist.` +
            (suggestion
              ? ` Closest real instruction: "${suggestion}".`
              : ' Use only the instructions from the provided list.')
        );
      }
    });
  };

  const checkEvent = (event: any, path: string) => {
    if (!event || typeof event !== 'object') {
      diagnostics.push(`${path}: not a valid event object.`);
      return;
    }
    const type = getInstructionTypeFromSerialized(event);
    if (typeof type === 'string' && type.length > 0) {
      if (KNOWN_EVENT_TYPES.indexOf(type) === -1) {
        // Not a builtin event type: extension events exist but are rare —
        // only warn (the engine will fall back to an empty event).
        diagnostics.push(
          `${path}: unknown event type "${type}". Use "BuiltinCommonInstructions::Standard", "::ForEach", "::Repeat", "::While", "::Comment", "::Group", "::JsCode"…`
        );
      }
    } else {
      diagnostics.push(
        `${path}: missing "type" (e.g. "BuiltinCommonInstructions::Standard").`
      );
    }
    checkInstructions(
      getInstructionsArray(event, 'conditions'),
      true,
      `${path} conditions`
    );
    checkInstructions(
      getInstructionsArray(event, 'actions'),
      false,
      `${path} actions`
    );
    const subEvents = getInstructionsArray(event, 'events');
    subEvents.forEach((subEvent, index) =>
      checkEvent(subEvent, `${path}.events[${index}]`)
    );
  };

  events.forEach((event, index) => checkEvent(event, `event[${index}]`));
  return diagnostics;
};
