// @flow
/**
 * Multi-AI Orchestrator for Horizons.
 *
 * Manages a *team* of AI provider slots (primary / specialist / fallback),
 * each with its own endpoint, key, model and free-tier rate limits:
 *
 *  - GLM 4.7 Flash (Z.ai)      → primary workhorse for agentic tasks
 *  - Gemini Flash (Google AI)  → specialist for vision/image/video analysis,
 *                                web search (native google_search grounding)
 *                                and help when the primary is rate-limited
 *  - Groq / OpenAI / others    → optional fallbacks
 *
 * Features:
 *  - Per-provider sliding-window rate limiting (RPM) with a fair request
 *    queue (no hammering, respects Retry-After).
 *  - Automatic failover: 429 / 5xx / network errors cool the provider down
 *    and the next one in the chain takes the request.
 *  - AI-to-AI delegation: the primary agent can call `ask_specialist`
 *    and `web_search` tools implemented here.
 *  - Live status bus so the UI can show queueing/failover in real time.
 *
 * Everything is stored locally (localStorage) — no GDevelop cloud involved.
 */

import { aiFetch } from './AiHttp';
import { sanitizeBaseUrl, describeAiError } from './UniversalAiClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AiProviderRole = 'primary' | 'specialist' | 'fallback';

export type AiProviderCapability =
  | 'text'
  | 'vision'
  | 'image-generation'
  | 'video-analysis'
  | 'web-search';

export type AiProviderSlot = {
  id: string,
  label: string,
  baseUrl: string,
  apiKey: string,
  model: string,
  /** Requests per minute allowed by the provider free tier (0 = unlimited). */
  rpmLimit: number,
  enabled: boolean,
  role: AiProviderRole,
  capabilities: Array<AiProviderCapability>,
  /** True for local endpoints (no API key needed). */
  keyless: boolean,
  /**
   * Ask reasoning-capable GLM models to skip their "thinking" phase
   * (much faster and cheaper on the free tier — recommended for agent loops).
   */
  disableThinking?: boolean,
};

export type AiStatusEvent = {
  kind:
    | 'request-start'
    | 'queued'
    | 'request-retry'
    | 'provider-cooldown'
    | 'provider-success'
    | 'delegation'
    | 'web-search'
    | 'team-parallel'
    | 'team-exhausted',
  slotId: ?string,
  label: string,
  message: string,
  timestamp: number,
};

// ---------------------------------------------------------------------------
// Defaults (free-tier friendly, all editable in the UI)
// ---------------------------------------------------------------------------

export const ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4';
export const GEMINI_OPENAI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai';
export const GEMINI_NATIVE_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta';

export const DEFAULT_PROVIDER_SLOTS: Array<AiProviderSlot> = [
  {
    id: 'glm-primary',
    label: 'GLM 4.7 Flash (Z.ai)',
    baseUrl: ZAI_BASE_URL,
    apiKey: '',
    model: 'glm-4.7-flash',
    // Z.ai free tier: ~5-12 req/min depending on load, bursts allowed.
    // The scheduler is ADAPTIVE: it starts at this value, halves it on
    // provider-side 1302 rate limits and recovers after successes — so the
    // number here is the optimistic ceiling, not a pessimistic throttle.
    rpmLimit: 12,
    enabled: true,
    role: 'primary',
    capabilities: ['text'],
    keyless: false,
    disableThinking: true, // keep free-tier latency sane in agent loops
  },
  {
    id: 'gemini-specialist',
    label: 'Gemini Flash (Google AI)',
    baseUrl: GEMINI_OPENAI_BASE_URL,
    apiKey: '',
    model: 'gemini-flash-latest',
    rpmLimit: 15, // Google AI Studio free tier (~10-15 req/min for flash models)
    enabled: true,
    role: 'specialist',
    capabilities: [
      'text',
      'vision',
      'image-generation',
      'video-analysis',
      'web-search',
    ],
    keyless: false,
  },
  {
    id: 'groq-fallback',
    label: 'Groq (Ultra-fast)',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: '',
    model: 'llama-3.3-70b-versatile',
    rpmLimit: 30,
    enabled: false,
    role: 'fallback',
    capabilities: ['text'],
    keyless: false,
  },
  {
    id: 'openai-fallback',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o',
    rpmLimit: 0,
    enabled: false,
    role: 'fallback',
    capabilities: ['text', 'vision', 'image-generation'],
    keyless: false,
  },
  {
    id: 'openrouter-fallback',
    label: 'OpenRouter (Multi-model)',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    model: 'anthropic/claude-3.5-sonnet',
    rpmLimit: 0,
    enabled: false,
    role: 'fallback',
    capabilities: ['text', 'vision'],
    keyless: false,
  },
  {
    id: 'deepseek-fallback',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    rpmLimit: 0,
    enabled: false,
    role: 'fallback',
    capabilities: ['text'],
    keyless: false,
  },
  {
    id: 'ollama-local',
    label: 'Ollama (Local Offline)',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: '',
    model: 'llama3.2:latest',
    rpmLimit: 0,
    enabled: false,
    role: 'fallback',
    capabilities: ['text'],
    keyless: true,
  },
  {
    id: 'lmstudio-local',
    label: 'LM Studio (Local Offline)',
    baseUrl: 'http://localhost:1234/v1',
    apiKey: '',
    model: 'local-model',
    rpmLimit: 0,
    enabled: false,
    role: 'fallback',
    capabilities: ['text'],
    keyless: true,
  },
];

const MULTI_AI_STORAGE_KEY = 'gd-multi-ai-slots-v1';

// rpmLimit defaults shipped by earlier versions (either far above the real
// free tiers or over-pessimistic single-concurrent values), replaced with
// corrected values when found in stored slots so existing installs pick up
// the fix. Genuinely customised values survive.
const LEGACY_DEFAULT_RPM_LIMITS: { [string]: number } = {
  'glm-primary': 40,
  'gemini-specialist': 15,
};
const LEGACY_DEFAULT_RPM_LIMITS_V2: { [string]: number } = {
  // v0.2.3 values (over-pessimistic "5 RPM / one concurrent" assumptions —
  // GLM 4.7 Flash actually allows bursts; the scheduler is adaptive now).
  'glm-primary': 5,
  'gemini-specialist': 10,
};
const LEGACY_PREFERENCES_KEY = 'gd-preferences';

/**
 * Read the legacy single-provider preferences (the main "AI Provider"
 * preferences tab and the quick settings dialog of the AI panel both
 * write there).
 *
 * These values used to be completely ignored by the team request path,
 * which made users think the AI was broken: they pasted their key in
 * the obvious place and every request failed with
 * "No AI provider is ready". `applyLegacyPreferencesOverlay` below fixes it.
 */
const readLegacyAiPreferences = (): ?{|
  baseUrl: string,
  apiKey: string,
  model: string,
|} => {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(LEGACY_PREFERENCES_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const values = parsed && parsed.values;
    if (!values) return null;
    const apiKey = (values.aiApiKey || '').trim();
    if (!apiKey) return null; // Nothing to overlay without a key.
    return {
      baseUrl: sanitizeBaseUrl(values.aiBaseUrl || ''),
      apiKey,
      model: (values.aiModel || '').trim(),
    };
  } catch (ignored) {
    return null;
  }
};

/**
 * Apply the legacy preferences (main AI Provider tab / quick settings) on top
 * of the team slots:
 *  - when the legacy endpoint matches a slot that has no key of its own,
 *    the key (and model) are used for that slot and it gets enabled;
 *  - when the legacy endpoint matches no slot at all, a custom slot is added.
 *
 * Keys explicitly set in the Multi-AI Team dialog always win (the overlay
 * only fills slots whose key is empty).
 */
const applyLegacyPreferencesOverlay = (
  slots: Array<AiProviderSlot>
): Array<AiProviderSlot> => {
  const legacy = readLegacyAiPreferences();
  if (!legacy) return slots;

  const matchingSlot = slots.find(
    slot => sanitizeBaseUrl(slot.baseUrl) === legacy.baseUrl
  );
  if (matchingSlot) {
    if (matchingSlot.keyless) return slots; // local server, no key needed.
    if (matchingSlot.apiKey && matchingSlot.apiKey.trim().length > 0)
      return slots; // Team dialog key wins.
    matchingSlot.apiKey = legacy.apiKey;
    if (legacy.model) matchingSlot.model = legacy.model;
    matchingSlot.enabled = true;
    return slots;
  }

  // Unknown endpoint: expose it as an additional ready provider.
  slots.push({
    id: 'custom-preferences',
    label: `Custom (${legacy.model || 'own endpoint'})`,
    baseUrl: legacy.baseUrl,
    apiKey: legacy.apiKey,
    model: legacy.model || 'gpt-4o',
    rpmLimit: 0,
    enabled: true,
    role: 'fallback',
    capabilities: ['text'],
    keyless: false,
  });
  return slots;
};

const ROLE_PRIORITY: { [AiProviderRole]: number } = {
  primary: 0,
  fallback: 1,
  specialist: 2,
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const cloneSlots = (slots: Array<AiProviderSlot>): Array<AiProviderSlot> =>
  slots.map(slot => ({ ...slot, capabilities: [...slot.capabilities] }));

export const getProviderSlots = (): Array<AiProviderSlot> => {
  try {
    const raw =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(MULTI_AI_STORAGE_KEY)
        : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Merge with defaults so new preset slots appear after updates.
        const storedById: { [string]: AiProviderSlot } = {};
        parsed.forEach(slot => {
          if (slot && slot.id) storedById[slot.id] = slot;
        });
        const merged = DEFAULT_PROVIDER_SLOTS.map(defaultSlot => {
          const stored = storedById[defaultSlot.id] || {};
          const slot = { ...defaultSlot, ...stored };
          const legacyDefaultRpm =
            LEGACY_DEFAULT_RPM_LIMITS[defaultSlot.id] !== undefined &&
            slot.rpmLimit === LEGACY_DEFAULT_RPM_LIMITS[defaultSlot.id]
              ? LEGACY_DEFAULT_RPM_LIMITS[defaultSlot.id]
              : LEGACY_DEFAULT_RPM_LIMITS_V2[defaultSlot.id] !== undefined &&
                slot.rpmLimit === LEGACY_DEFAULT_RPM_LIMITS_V2[defaultSlot.id]
              ? LEGACY_DEFAULT_RPM_LIMITS_V2[defaultSlot.id]
              : undefined;
          if (legacyDefaultRpm !== undefined) {
            slot.rpmLimit = defaultSlot.rpmLimit;
          }
          return slot;
        });
        // Keep any user-created custom slots at the end.
        const defaultIds = new Set(DEFAULT_PROVIDER_SLOTS.map(s => s.id));
        parsed.forEach(slot => {
          if (slot && slot.id && !defaultIds.has(slot.id)) {
            merged.push(slot);
          }
        });
        return applyLegacyPreferencesOverlay(cloneSlots(merged));
      }
    }
  } catch (ignored) {
    // Fall through to migration/defaults.
  }
  const seeded = migrateLegacyConfig(cloneSlots(DEFAULT_PROVIDER_SLOTS));
  saveProviderSlots(seeded);
  return applyLegacyPreferencesOverlay(seeded);
};

export const saveProviderSlots = (slots: Array<AiProviderSlot>): void => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(MULTI_AI_STORAGE_KEY, JSON.stringify(slots));
  } catch (ignored) {
    // Storage quota errors are non-fatal.
  }
};

export const updateProviderSlot = (
  slotId: string,
  updates: $Shape<AiProviderSlot>
): Array<AiProviderSlot> => {
  const slots = getProviderSlots().map(slot =>
    slot.id === slotId ? { ...slot, ...updates } : slot
  );
  saveProviderSlots(slots);
  return slots;
};

/**
 * Seed a custom slot from the legacy single-provider preferences
 * (aiBaseUrl/aiApiKey/aiModel) so nothing the user configured is lost.
 */
export const migrateLegacyConfig = (
  slots: Array<AiProviderSlot>
): Array<AiProviderSlot> => {
  try {
    if (typeof localStorage === 'undefined') return slots;
    const raw = localStorage.getItem(LEGACY_PREFERENCES_KEY);
    if (!raw) return slots;
    const parsed = JSON.parse(raw);
    const values = parsed && parsed.values;
    if (!values) return slots;
    const legacyKey = values.aiApiKey || '';
    const legacyUrl = sanitizeBaseUrl(values.aiBaseUrl || '');
    const legacyModel = values.aiModel || 'gpt-4o';
    if (!legacyKey) return slots; // nothing worth carrying over

    const defaultUrls = new Set(
      DEFAULT_PROVIDER_SLOTS.map(slot => sanitizeBaseUrl(slot.baseUrl))
    );
    const matchingSlot = slots.find(
      slot => sanitizeBaseUrl(slot.baseUrl) === legacyUrl
    );
    if (matchingSlot) {
      if (!matchingSlot.apiKey) matchingSlot.apiKey = legacyKey;
      return slots;
    }
    if (defaultUrls.has(legacyUrl)) return slots;
    slots.push({
      id: 'custom-legacy',
      label: `Custom (${legacyModel})`,
      baseUrl: legacyUrl,
      apiKey: legacyKey,
      model: legacyModel,
      rpmLimit: 0,
      enabled: true,
      role: 'fallback',
      capabilities: ['text'],
      keyless: false,
    });
    return slots;
  } catch (ignored) {
    return slots;
  }
};

// ---------------------------------------------------------------------------
// Status bus
// ---------------------------------------------------------------------------

const statusListeners: Set<(event: AiStatusEvent) => void> = new Set();

export const subscribeAiStatus = (
  listener: (event: AiStatusEvent) => void
): (() => void) => {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
};

export const emitAiStatus = (event: AiStatusEvent): void => {
  statusListeners.forEach(listener => {
    try {
      listener(event);
    } catch (ignored) {
      // A broken listener must never break AI calls.
    }
  });
};

// ---------------------------------------------------------------------------
// Rate limiting (sliding window + per-provider serialized queue)
// ---------------------------------------------------------------------------

type SlotRuntime = {
  requestTimestamps: Array<number>,
  queue: Promise<*>,
  cooldownUntil: number,
  consecutiveFailures: number,
  /** Adaptive RPM: starts at the slot's rpmLimit, halves on provider-side
   * 1302 rate limits, recovers after success streaks. See getEffectiveRpm. */
  adaptiveRpm: number,
  successStreak: number,
};

const runtimes: { [string]: SlotRuntime } = {};

const getRuntime = (slotId: string): SlotRuntime => {
  if (!runtimes[slotId]) {
    runtimes[slotId] = {
      requestTimestamps: [],
      queue: Promise.resolve(),
      cooldownUntil: 0,
      consecutiveFailures: 0,
      adaptiveRpm: 0, // 0 = not yet initialised (set on first use)
      successStreak: 0,
    };
  }
  const runtime = runtimes[slotId];
  if (!runtime.adaptiveRpm) {
    const slot = getProviderSlots().find(s => s.id === slotId);
    runtime.adaptiveRpm = slot && slot.rpmLimit > 0 ? slot.rpmLimit : 60;
  }
  return runtime;
};

/** Provider said 1302 (too many requests): slow down this slot, hard. */
const noteRateLimited = (slot: AiProviderSlot) => {
  const runtime = getRuntime(slot.id);
  runtime.adaptiveRpm = Math.max(3, Math.floor(runtime.adaptiveRpm / 2));
  runtime.successStreak = 0;
};

/** A request succeeded: slowly trust the provider again. */
const noteSuccessPacing = (slot: AiProviderSlot) => {
  const runtime = getRuntime(slot.id);
  runtime.successStreak += 1;
  if (runtime.successStreak >= 4) {
    const ceiling = slot.rpmLimit > 0 ? slot.rpmLimit : 60;
    runtime.adaptiveRpm = Math.min(
      ceiling,
      Math.ceil(runtime.adaptiveRpm * 1.25)
    );
    runtime.successStreak = 0;
  }
};

const getEffectiveRpm = (slot: AiProviderSlot, runtime: SlotRuntime) =>
  slot.rpmLimit > 0 ? Math.min(slot.rpmLimit, runtime.adaptiveRpm) : 0;

const msUntilSlotFree = (
  slot: AiProviderSlot,
  runtime: SlotRuntime
): number => {
  const now = Date.now();
  if (now < runtime.cooldownUntil) {
    return runtime.cooldownUntil - now;
  }
  const effectiveRpm = getEffectiveRpm(slot, runtime);
  if (!effectiveRpm || effectiveRpm <= 0) return 0;
  const windowStart = now - 60 * 1000;
  runtime.requestTimestamps = runtime.requestTimestamps.filter(
    timestamp => timestamp > windowStart
  );
  if (runtime.requestTimestamps.length < effectiveRpm) return 0;
  const oldestInWindow = runtime.requestTimestamps[0];
  return Math.max(oldestInWindow + 60 * 1000 - now, 250);
};

const cooldownSlot = (slot: AiProviderSlot, ms: number, reason: string) => {
  const runtime = getRuntime(slot.id);
  runtime.cooldownUntil = Date.now() + ms;
  emitAiStatus({
    kind: 'provider-cooldown',
    slotId: slot.id,
    label: slot.label,
    message: `${reason} — cooling down ${(ms / 1000).toFixed(
      0
    )}s before reuse.`,
    timestamp: Date.now(),
  });
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Wait until the slot may accept another request (rate window / cooldown).
 */
const waitForSlotCapacity = async (slot: AiProviderSlot): Promise<number> => {
  const runtime = getRuntime(slot.id);
  let waitedMs = 0;
  for (let attempt = 0; attempt < 240; attempt++) {
    const waitMs = msUntilSlotFree(slot, runtime);
    if (waitMs <= 0) return waitedMs;
    waitedMs += waitMs;
    if (waitedMs > 500) {
      emitAiStatus({
        kind: 'queued',
        slotId: slot.id,
        label: slot.label,
        message: `Waiting for ${slot.label} free-tier rate window (${(
          waitedMs / 1000
        ).toFixed(0)}s queued)...`,
        timestamp: Date.now(),
      });
    }
    await sleep(Math.min(waitMs, 5000));
  }
  return waitedMs;
};

const isRateLimitError = (error: any): boolean => {
  const status = error && error.response && error.response.status;
  return status === 429 || status === 503;
};

const isServerError = (error: any): boolean => {
  const status = error && error.response && error.response.status;
  return !!status && status >= 500;
};

const extractRetryAfterMs = (error: any): ?number => {
  const headers = error && error.response && error.response.headers;
  if (!headers) return null;
  const retryAfter =
    headers['retry-after'] || headers['Retry-After'] || headers['retry-after-ms'];
  if (retryAfter) {
    const seconds = parseFloat(retryAfter);
    if (!isNaN(seconds)) return seconds > 1000 ? seconds : seconds * 1000;
  }
  return null;
};

/**
 * Extract the provider's own error code from the response body
 * (Z.ai/OpenAI shape: {"error": {"code": "1302", "message": ...}}).
 * Z.ai codes (docs.z.ai/api-reference/api-code):
 *  1302 = too many requests (RPM/concurrency) — back off, halve the pace
 *  1305 = the service is temporarily OVERLOADED — Z.ai's free servers are
 *         busy; NOT the user's quota or key. Retry the same slot shortly.
 *  1308/1310/1316-1321 = usage window exhausted (resets at a given time)
 *  1113 = insufficient balance / model not free
 *  1311 = the plan does not include this model
 */
const extractProviderErrorCode = (error: any): ?string => {
  const data = error && error.response && error.response.data;
  if (!data) return null;
  const code = data.error ? data.error.code : data.code;
  if (code === undefined || code === null) return null;
  return String(code);
};

/** Usage-window limits (1308, 1310, 1316-1321): long cooldown needed. */
const isUsageWindowLimitCode = (code: ?string): boolean =>
  !!code && ['1308', '1310', '1316', '1317', '1318', '1319', '1320', '1321'].includes(code);

const markSlotResult = (slot: AiProviderSlot, success: boolean) => {
  const runtime = getRuntime(slot.id);
  if (success) {
    runtime.consecutiveFailures = 0;
    emitAiStatus({
      kind: 'provider-success',
      slotId: slot.id,
      label: slot.label,
      message: `Answered by ${slot.label} (${slot.model}).`,
      timestamp: Date.now(),
    });
  } else {
    runtime.consecutiveFailures += 1;
  }
};

// ---------------------------------------------------------------------------
// Core request helpers
// ---------------------------------------------------------------------------

const isSlotUsable = (slot: AiProviderSlot): boolean =>
  slot.enabled &&
  (slot.keyless || (slot.apiKey && slot.apiKey.trim().length > 0));

const buildChain = (
  slots: Array<AiProviderSlot>,
  options: { preferRole?: ?AiProviderRole, preferSlotId?: ?string }
): Array<AiProviderSlot> => {
  const usable = slots.filter(isSlotUsable);
  const chain = [...usable];
  chain.sort((a, b) => {
    const aRole = ROLE_PRIORITY[a.role] ?? 3;
    const bRole = ROLE_PRIORITY[b.role] ?? 3;
    return aRole - bRole;
  });
  if (options.preferSlotId) {
    const index = chain.findIndex(slot => slot.id === options.preferSlotId);
    if (index > 0) {
      const [preferred] = chain.splice(index, 1);
      chain.unshift(preferred);
    }
  }
  if (options.preferRole) {
    const rolePriority = ROLE_PRIORITY[options.preferRole] ?? 3;
    chain.sort((a, b) => {
      const aMatch = a.role === options.preferRole ? 0 : 1;
      const bMatch = b.role === options.preferRole ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
      return (ROLE_PRIORITY[a.role] ?? 3) - (ROLE_PRIORITY[b.role] ?? 3);
    });
  }
  return chain;
};

const callSlotChatCompletions = async ({
  slot,
  messages,
  tools,
  temperature,
  onWaited,
}: {
  slot: AiProviderSlot,
  messages: Array<any>,
  tools?: ?Array<any>,
  temperature: number,
  onWaited?: (waitedMs: number) => void,
}): Promise<any> => {
  const runtime = getRuntime(slot.id);
  // Serialize requests per slot so the rate window stays accurate.
  const task = runtime.queue.then(async () => {
    const waitedMs = await waitForSlotCapacity(slot);
    if (onWaited && waitedMs > 500) onWaited(waitedMs);

    const headers: { [string]: string } = {
      'Content-Type': 'application/json',
    };
    if (slot.apiKey && slot.apiKey.trim().length > 0) {
      headers['Authorization'] = `Bearer ${slot.apiKey.trim()}`;
    }

    const payload: { [string]: any } = {
      model: slot.model,
      messages,
      temperature: typeof temperature === 'number' ? temperature : 0.7,
    };
    if (tools && tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = 'auto';
    }
    if (
      slot.disableThinking &&
      /glm-[456]|zai|z\.ai|bigmodel/i.test(
        `${slot.model} ${sanitizeBaseUrl(slot.baseUrl)}`
      )
    ) {
      // Zhipu/Z.ai reasoning models accept this OpenAI-style extension to
      // skip the thinking phase (ignored by non-GLM providers).
      payload.thinking = { type: 'disabled' };
    }

    // Transient errors (5xx, timeouts, network blips) are retried on the
    // same provider before failing over to the next one.
    //
    // Z.ai code 1305 ("The service may be temporarily overloaded") deserves
    // special care: the FREE flash tier is globally shared and regularly
    // returns 1305 for bursts of a few seconds to a few minutes — with a
    // perfectly valid key and untouched quota. Tests from other tools work
    // "fine and fast" simply because they happened to miss those bursts.
    // So 1305 is retried patiently (4 attempts, 4s/8s/16s) on the SAME
    // provider instead of surfacing "rate limit" errors to the user.
    const maxAttempts = 4;
    let lastError: any = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      runtime.requestTimestamps.push(Date.now());
      try {
        const response = await aiFetch(
          `${sanitizeBaseUrl(slot.baseUrl)}/chat/completions`,
          {
            method: 'POST',
            headers,
            body: payload,
            timeoutMs: 180000,
          }
        );
        noteSuccessPacing(slot);
        return response.data;
      } catch (error) {
        lastError = error;
        const providerErrorCode = extractProviderErrorCode(error);

        // 1305 = temporary overload on the provider side: retrying the same
        // provider beats failing over (the next one may not be configured).
        if (
          (providerErrorCode === '1305' || isServerError(error)) &&
          attempt < maxAttempts
        ) {
          const backoffMs = providerErrorCode === '1305'
            ? 4000 * attempt
            : 2000 * attempt;
          emitAiStatus({
            kind: 'request-retry',
            slotId: slot.id,
            label: slot.label,
            message:
              providerErrorCode === '1305'
                ? `${slot.label}: Z.ai's free servers are momentarily busy (code 1305 — not your key, not your quota). Retrying in ${Math.round(
                    backoffMs / 1000
                  )}s (attempt ${attempt + 1}/${maxAttempts})...`
                : `${slot.label} had a transient error (attempt ${attempt}/${maxAttempts}) — retrying in ${Math.round(
                    backoffMs / 1000
                  )}s.`,
            timestamp: Date.now(),
          });
          await sleep(backoffMs);
          continue;
        }

        if (providerErrorCode === '1113' || providerErrorCode === '1311') {
          // Z.ai: the model is not free / not in the plan / balance empty.
          // Hammering will not help — cool the slot down for a long time and
          // let the next team member answer.
          cooldownSlot(
            slot,
            10 * 60 * 1000,
            `${slot.label}: ${
              providerErrorCode === '1113'
                ? 'this model is not free on your account / balance is empty (code 1113) — use a free model (e.g. glm-4.7-flash) or top up the balance'
                : 'your plan does not include this model (code 1311) — switch to a free one (e.g. glm-4.7-flash)'
            }`
          );
          throw error;
        }
        if (isUsageWindowLimitCode(providerErrorCode)) {
          // Usage window exhausted (per 5h/7d/month). The limit resets at a
          // time given by Z.ai — cool down for a long while.
          cooldownSlot(
            slot,
            10 * 60 * 1000,
            `${slot.label}: usage window exhausted (code ${providerErrorCode}) — the provider resets it automatically; the team will use another member meanwhile`
          );
          throw error;
        }
        if (isRateLimitError(error)) {
          // 1302 = too many requests for this account+model (requests from
          // other tools/devices with the same key also count).
          noteRateLimited(slot);
          const retryAfterMs =
            extractRetryAfterMs(error) ||
            (providerErrorCode === '1302' ? 25000 : 15000);
          cooldownSlot(
            slot,
            Math.min(Math.max(retryAfterMs, 8000), 90000),
            `${slot.label} hit its rate limit (HTTP ${
              error.response ? error.response.status : 429
            }${providerErrorCode ? `, code ${providerErrorCode}` : ''})`
          );
          // Fail over immediately — another team member answers now.
          throw error;
        }
        const retryable =
          error &&
          (error.code === 'ECONNABORTED' ||
            (!error.response && !!error.message));
        if (!retryable || attempt >= maxAttempts) {
          throw error;
        }
        const backoffMs = Math.min(
          extractRetryAfterMs(error) || 2000 * attempt,
          15000
        );
        emitAiStatus({
          kind: 'request-retry',
          slotId: slot.id,
          label: slot.label,
          message: `${
            slot.label
          } had a transient error (attempt ${attempt}/${maxAttempts}) — retrying in ${Math.round(
            backoffMs / 1000
          )}s.`,
          timestamp: Date.now(),
        });
        await sleep(backoffMs);
      }
    }
    throw lastError || new Error('Request failed');
  });
  // Keep the queue chain alive even if this task fails.
  runtime.queue = task.catch(() => {});
  return task;
};

/**
 * Serialize an out-of-band request (connection test, model discovery)
 * through the matching team slot's rate window. Free tiers such as Z.ai's
 * GLM allow a single concurrent request per account: firing a "Test
 * connection" while the agent is thinking returns HTTP 429 (code 1302) even
 * with a perfect key. The wait is BOUNDED (~20s) so a test always answers
 * quickly even when the provider is busy with a long agent request or a
 * long cooldown — worst case the request hits the provider's rate limit and
 * the caller shows its explanation. When no team slot matches the endpoint,
 * the request runs directly.
 */
export const runGatedOnMatchingSlot = async (
  baseUrl: string,
  fn: () => Promise<any>
): Promise<any> => {
  try {
    const target = sanitizeBaseUrl(baseUrl || '').toLowerCase();
    if (!target) return fn();
    const slot = getProviderSlots().find(
      s => sanitizeBaseUrl(s.baseUrl).toLowerCase() === target
    );
    if (!slot) return fn();
    const runtime = getRuntime(slot.id);
    const deadline = Date.now() + 20000;
    // Wait for the slot's in-flight request (bounded), then for a free
    // rate-window slot (bounded by the same deadline).
    await Promise.race([runtime.queue, sleep(20000)]);
    for (;;) {
      const waitMs = msUntilSlotFree(slot, runtime);
      if (waitMs <= 0 || Date.now() >= deadline) break;
      await sleep(Math.max(0, Math.min(waitMs, deadline - Date.now())));
    }
    runtime.requestTimestamps.push(Date.now());
    return fn();
  } catch (ignored) {
    return fn();
  }
};

export type OrchestratedResult = {|
  data: any,
  slotId: string,
  providerLabel: string,
  model: string,
|};

/**
 * How long before the slot gets out of cooldown (0 = ready now).
 */
export const getSlotCooldownRemainingMs = (slotId: string): number => {
  const runtime = runtimes[slotId];
  if (!runtime) return 0;
  return Math.max(runtime.cooldownUntil - Date.now(), 0);
};

/**
 * Send a chat-completions request through the provider team:
 * wait for the rate window, fail over to the next provider on
 * 429/5xx/network errors, and report everything on the status bus.
 */
export const chatCompletionWithFailover = async ({
  messages,
  tools,
  temperature = 0.7,
  preferRole,
  preferSlotId,
  onStatus,
}: {
  messages: Array<any>,
  tools?: ?Array<any>,
  temperature?: number,
  preferRole?: ?AiProviderRole,
  preferSlotId?: ?string,
  onStatus?: (message: string) => void,
}): Promise<OrchestratedResult> => {
  const slots = getProviderSlots();
  const chain = buildChain(slots, { preferRole, preferSlotId });

  if (chain.length === 0) {
    const message =
      'No AI provider is ready. Open Preferences → AI Provider (or the AI toolbar gear) and add an API key for GLM 4.7 Flash (Z.ai), Gemini or any OpenAI-compatible provider.';
    emitAiStatus({
      kind: 'team-exhausted',
      slotId: null,
      label: 'AI team',
      message,
      timestamp: Date.now(),
    });
    throw new Error(message);
  }

  emitAiStatus({
    kind: 'request-start',
    slotId: chain[0].id,
    label: chain[0].label,
    message: `AI request started — team: ${chain
      .map(slot => slot.label)
      .join(' → ')}`,
    timestamp: Date.now(),
  });

  const errors: Array<string> = [];
  let lastRateLimitedSlot: ?AiProviderSlot = null;
  for (let index = 0; index < chain.length; index++) {
    const slot = chain[index];
    // A cooling-down provider is skipped when another ready team member can
    // answer right now — never make the user wait for a cooldown when a
    // failover target is available. If it is the last usable option, we
    // still wait for it (better late than "no provider available").
    const cooldownRemainingMs = getSlotCooldownRemainingMs(slot.id);
    if (cooldownRemainingMs > 0 && index < chain.length - 1) {
      const anotherReadySlot = chain
        .slice(index + 1)
        .some(laterSlot => getSlotCooldownRemainingMs(laterSlot.id) === 0);
      if (anotherReadySlot) {
        emitAiStatus({
          kind: 'provider-cooldown',
          slotId: slot.id,
          label: slot.label,
          message: `${slot.label} is cooling down (${Math.ceil(
            cooldownRemainingMs / 1000
          )}s left) — trying the next team member instead.`,
          timestamp: Date.now(),
        });
        errors.push(
          `${slot.label}: skipped (cooling down ${Math.ceil(
            cooldownRemainingMs / 1000
          )}s after a rate limit)`
        );
        continue;
      }
    }
    if (index > 0 && onStatus) {
      onStatus(
        `Failing over to ${slot.label}... (previous provider unavailable)`
      );
    }
    try {
      const data = await callSlotChatCompletions({
        slot,
        messages,
        tools,
        temperature,
      });
      markSlotResult(slot, true);
      return {
        data,
        slotId: slot.id,
        providerLabel: slot.label,
        model: slot.model,
      };
    } catch (error) {
      markSlotResult(slot, false);
      if (isRateLimitError(error)) {
        lastRateLimitedSlot = slot;
      }
      errors.push(`${slot.label}: ${describeAiError(error, slot.baseUrl)}`);
      emitAiStatus({
        kind: 'provider-cooldown',
        slotId: slot.id,
        label: slot.label,
        message: `${slot.label} could not answer (${errors.length}/${
          chain.length
        } tried). ${describeAiError(error, slot.baseUrl)}`,
        timestamp: Date.now(),
      });
      // Continue to the next provider in the chain.
    }
  }

  // Last resort: when a provider was rate-limited (typically the only
  // usable one, e.g. a GLM-only setup), wait for its free-tier window to
  // recover and retry once instead of failing the request outright —
  // "AI answered 30s later" beats "All providers failed".
  if (lastRateLimitedSlot) {
    const waitMs = getSlotCooldownRemainingMs(lastRateLimitedSlot.id);
    if (waitMs <= 60000) {
      emitAiStatus({
        kind: 'queued',
        slotId: lastRateLimitedSlot.id,
        label: lastRateLimitedSlot.label,
        message: `${lastRateLimitedSlot.label} hit a rate limit but can recover — waiting ${Math.ceil(
          (waitMs + 500) / 1000
        )}s for its free-tier window, then one final retry.`,
        timestamp: Date.now(),
      });
      if (waitMs > 0) await sleep(waitMs + 500);
      try {
        const data = await callSlotChatCompletions({
          slot: lastRateLimitedSlot,
          messages,
          tools,
          temperature,
        });
        markSlotResult(lastRateLimitedSlot, true);
        return {
          data,
          slotId: lastRateLimitedSlot.id,
          providerLabel: lastRateLimitedSlot.label,
          model: lastRateLimitedSlot.model,
        };
      } catch (error) {
        errors.push(
          `${lastRateLimitedSlot.label}: ${describeAiError(
            error,
            lastRateLimitedSlot.baseUrl
          )}`
        );
      }
    }
  }

  const exhaustedMessage = `All AI providers in your team failed.\n\n${errors
    .map(error => `• ${error}`)
    .join('\n')}`;
  emitAiStatus({
    kind: 'team-exhausted',
    slotId: null,
    label: 'AI team',
    message: exhaustedMessage,
    timestamp: Date.now(),
  });
  throw new Error(exhaustedMessage);
};

// ---------------------------------------------------------------------------
// Parallel AI TEAM ("harness" mode, inspired by DeepSeek Harness)
// ---------------------------------------------------------------------------
// Horizons runs its providers as a real TEAM, not just as a fallback chain:
// while the BUILDER (primary, e.g. GLM) implements the user's request with
// tools, the RESEARCHER (specialist, e.g. Gemini) works on the SAME request
// IN PARALLEL — asset/UX ideas, naming, gameplay polish and pitfalls — on a
// different provider with its own rate window. The builder receives the
// notes on its next step and the final answer carries them, clearly
// labelled. (Architecture credit: DeepSeek Harness' "everything is a
// swappable module" pattern — model adapters, tool registry, agent loop:
// https://github.com/deepseek-ai/deepseek-harness, MIT.)

type ResearchSession = {|
  prompt: string,
  promise: Promise<?string>,
  notes: ?string,
  injected: boolean,
  specialistLabel: string,
|};

const researchSessions: { [string]: ResearchSession } = {};

const RESEARCHER_SYSTEM_PROMPT = `You are the researcher/designer of a two-AI team building a GDevelop game.
The builder AI (another model) is implementing the user's request WITH tools in parallel —
you cannot modify the project. Your job is to make the result better:
1. IMPLEMENTATION PLAN: the exact objects/variables/instructions the builder should use
   (GDevelop terms: e.g. "condition Collision Player↔Coin, action Delete Coin"),
   with correct object names taken from the project context.
2. Asset & UX suggestions (objects to add, visual style, menu/feedback ideas).
3. Gameplay polish (difficulty curve, juice: sounds, particles, screen effects).
4. Pitfalls the builder should avoid (common GDevelop mistakes, event logic traps).
Be CONCRETE and brief: max ~150 words, plain bullet points, no preamble.`;

/** Can the team run parallel research right now? (specialist configured) */
export const isTeamResearchAvailable = (): boolean => {
  const specialist = getProviderSlots().find(
    slot => slot.role === 'specialist' && isSlotUsable(slot)
  );
  return !!specialist;
};

/**
 * Kick off (or replace) the parallel research for a conversation step.
 * NEVER awaited by the caller while the builder works — results are picked
 * up later via getTeamResearchNotes / injectResearchNotesIntoMessages.
 * Only runs on a *specialist* slot: parallel research must never steal the
 * primary provider's rate window (that would self-inflict 1302 errors).
 */
export const startTeamResearch = ({
  sessionId,
  userPrompt,
  projectDigest,
}: {|
  sessionId: string,
  userPrompt: string,
  projectDigest?: ?string,
|}): void => {
  if (!userPrompt || !userPrompt.trim()) return;
  const existing = researchSessions[sessionId];
  if (existing && existing.prompt === userPrompt) return; // Already running.

  const specialist = getProviderSlots().find(
    slot => slot.role === 'specialist' && isSlotUsable(slot)
  );
  if (!specialist) {
    // No specialist → no parallel job for the second team member. The
    // builder keeps working alone; nothing is surfaced to the user.
    return;
  }

  emitAiStatus({
    kind: 'team-parallel',
    slotId: specialist.id,
    label: specialist.label,
    message: `Team mode: ${specialist.label} starts researching in parallel while the builder implements.`,
    timestamp: Date.now(),
  });

  const userContent = [
    `# USER REQUEST\n${userPrompt.slice(0, 6000)}`,
    projectDigest
      ? `\n# PROJECT CONTEXT (truncated)\n${projectDigest.slice(0, 12000)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const promise = (async (): Promise<?string> => {
    try {
      const data = await callSlotChatCompletions({
        slot: specialist,
        messages: [
          { role: 'system', content: RESEARCHER_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        tools: null,
        temperature: 0.6,
      });
      const choice = data && data.choices && data.choices[0];
      const text = (choice && choice.message && choice.message.content) || '';
      return text.trim() || null;
    } catch (ignored) {
      // Research is best-effort: a busy Gemini must never break the build.
      return null;
    }
  })();

  const session: ResearchSession = {
    prompt: userPrompt,
    promise,
    notes: null,
    injected: false,
    specialistLabel: specialist.label,
  };
  promise.then(notes => {
    session.notes = notes;
    if (notes) {
      emitAiStatus({
        kind: 'team-parallel',
        slotId: specialist.id,
        label: specialist.label,
        message: `${specialist.label} finished its parallel research — notes ready for the builder.`,
        timestamp: Date.now(),
      });
    }
  });
  researchSessions[sessionId] = session;
};

/** Result of a (possibly still-running) research session. */
export type TeamResearchResult = {|
  notes: string,
  providerLabel: string,
|};

/**
 * Wait (bounded) for the research notes of a session; null when absent,
 * unavailable or not ready in time.
 */
export const getTeamResearchNotes = async (
  sessionId: string,
  waitMs: number
): Promise<?TeamResearchResult> => {
  const session = researchSessions[sessionId];
  if (!session) return null;
  const resolve = (): ?TeamResearchResult =>
    session.notes
      ? { notes: session.notes, providerLabel: session.specialistLabel }
      : null;
  if (session.notes !== null && session.notes !== undefined) {
    return resolve();
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (session.notes !== null && session.notes !== undefined) {
      return resolve();
    }
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
    // Also resolve when the underlying promise has settled empty.
    const done = await Promise.race([
      session.promise.then(() => true),
      sleep(0).then(() => false),
    ]);
    if (done) {
      return resolve();
    }
  }
};

/**
 * Inject the arrived research notes into the builder's message list (as a
 * system note) — once per session step. Returns true when injected.
 */
export const injectResearchNotesIntoMessages = (
  sessionId: string,
  messages: Array<any>
): boolean => {
  const session = researchSessions[sessionId];
  if (!session || session.injected) return false;
  if (!session.notes) return false;
  messages.push({
    role: 'system',
    content: `TEAM RESEARCH NOTES (from the researcher AI, working in parallel — use them to improve what you build):\n${session.notes}`,
  });
  session.injected = true;
  // Make the A↔A communication VISIBLE to the user in the team channel.
  emitAiStatus({
    kind: 'team-parallel',
    slotId: null,
    label: session.specialistLabel,
    message: `${session.specialistLabel} → builder: research notes delivered (${session.notes.length} chars) — the builder takes them into account.`,
    timestamp: Date.now(),
  });
  return true;
};

/** Forget a session's research (called when the conversation is reset). */
export const clearTeamResearch = (sessionId?: ?string): void => {
  if (sessionId) {
    delete researchSessions[sessionId];
  } else {
    Object.keys(researchSessions).forEach(key => {
      delete researchSessions[key];
    });
  }
};

// ---------------------------------------------------------------------------
// Specialist tools: ask_specialist + web_search
// ---------------------------------------------------------------------------

const SPECIALIST_SYSTEM_PROMPT = `You are the specialist AI of the Horizons game editor team.
The primary agent (GLM) delegates tasks to you that need your strengths:
vision, image/video understanding, long-context analysis, or up-to-date knowledge.
Answer with a precise, self-contained result the primary agent can use directly.`;

/**
 * Primary → specialist delegation (e.g. GLM asks Gemini for help).
 */
export const askSpecialist = async ({
  task,
  details,
  projectContext,
}: {
  task: string,
  details?: ?string,
  projectContext?: ?string,
}): Promise<string> => {
  emitAiStatus({
    kind: 'delegation',
    slotId: null,
    label: 'Specialist AI',
    message: `Delegating to specialist AI: ${task.slice(0, 80)}`,
    timestamp: Date.now(),
  });

  const userContent = [
    `# TASK FROM PRIMARY AGENT\n${task}`,
    details ? `\n# DETAILS\n${details.slice(0, 24000)}` : '',
    projectContext
      ? `\n# PROJECT CONTEXT (truncated)\n${projectContext.slice(0, 24000)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const result = await chatCompletionWithFailover({
      messages: [
        { role: 'system', content: SPECIALIST_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0.5,
      preferRole: 'specialist',
      // Never recurse: the specialist answers without tools.
      tools: null,
    });
    const choice = result.data && result.data.choices && result.data.choices[0];
    const text =
      (choice && choice.message && choice.message.content) ||
      'The specialist returned an empty answer.';
    return `[SPECIALIST ANSWER — via ${result.providerLabel}]\n${text}`;
  } catch (error) {
    return `[SPECIALIST UNAVAILABLE] The specialist AI could not be reached: ${(error &&
      error.message) ||
      'unknown error'}. Continue with your own knowledge and tell the user the specialist was unavailable.`;
  }
};

/**
 * POST-BUILD REVIEW by the specialist (second team member).
 *
 * Makes the team effort real and visible: after the builder (primary, e.g.
 * GLM) has finished its answer, the specialist (e.g. Gemini) reviews what
 * was done against the user's request — did it cover everything, what
 * should be checked in preview, what to ask for next. Runs on the
 * specialist's OWN rate window, so it never steals the builder's quota.
 * Best-effort: a busy specialist is skipped silently.
 */
export const reviewBySpecialist = async ({
  userPrompt,
  builderAnswer,
  projectDigest,
}: {|
  userPrompt: string,
  builderAnswer: string,
  projectDigest?: ?string,
|}): Promise<?{| text: string, providerLabel: string |}> => {
  const specialist = getProviderSlots().find(
    slot => slot.role === 'specialist' && isSlotUsable(slot)
  );
  if (!specialist) return null;

  emitAiStatus({
    kind: 'team-parallel',
    slotId: specialist.id,
    label: specialist.label,
    message: `${specialist.label} is reviewing the builder's work…`,
    timestamp: Date.now(),
  });

  const userContent = [
    `# USER REQUEST
${(userPrompt || '').slice(0, 4000)}`,
    `# BUILDER'S FINAL REPORT (what the other AI just did)
${(builderAnswer || '').slice(0, 6000)}`,
    projectDigest
      ? `# PROJECT CONTEXT (truncated)\n${projectDigest.slice(0, 8000)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const data = await callSlotChatCompletions({
      slot: specialist,
      messages: [
        {
          role: 'system',
          content:
            'You are the reviewer of a two-AI team building a GDevelop game. ' +
            'The builder AI just finished implementing the user\'s request and reported ' +
            'what it did. Review its report against the user request. Answer in at most ' +
            '80 words, plain text: (1) a one-line verdict — COMPLETE, MOSTLY COMPLETE ' +
            'or INCOMPLETE (with what is missing); (2) one thing to verify in the game ' +
            'preview; (3) optionally the best next step for the user. Be honest and specific, ' +
            'no preamble.',
        },
        { role: 'user', content: userContent },
      ],
      tools: null,
      temperature: 0.4,
    });
    const choice = data && data.choices && data.choices[0];
    const text = ((choice && choice.message && choice.message.content) || '').trim();
    if (!text) return null;
    emitAiStatus({
      kind: 'team-parallel',
      slotId: specialist.id,
      label: specialist.label,
      message: `${specialist.label} review delivered: "${text.slice(0, 160)}"`,
      timestamp: Date.now(),
    });
    return { text, providerLabel: specialist.label };
  } catch (ignored) {
    // Review is best-effort: never break the builder's answer.
    return null;
  }
};

/**
 * Web search via Gemini native google_search grounding (free tier, no extra key).
 * Falls back to a clear explanation when no Gemini key is configured.
 */
export const webSearch = async (query: string): Promise<string> => {
  emitAiStatus({
    kind: 'web-search',
    slotId: 'gemini-specialist',
    label: 'Web search',
    message: `Searching the web for: ${query.slice(0, 80)}`,
    timestamp: Date.now(),
  });

  const slots = getProviderSlots();
  const geminiSlot = slots.find(
    slot =>
      slot.id === 'gemini-specialist' ||
      ((slot.capabilities || []).includes('web-search') && isSlotUsable(slot))
  );
  if (!geminiSlot || !isSlotUsable(geminiSlot)) {
    return '[WEB SEARCH UNAVAILABLE] Add a Gemini (Google AI Studio) API key in the AI team settings to enable live web search. Answer from your own knowledge meanwhile.';
  }

  // Rate-limit the native call through the same window as the slot.
  const runtime = getRuntime(geminiSlot.id);
  const task = runtime.queue.then(async () => {
    await waitForSlotCapacity(geminiSlot);
    runtime.requestTimestamps.push(Date.now());
    const url = `${GEMINI_NATIVE_BASE_URL}/models/${
      geminiSlot.model
    }:generateContent?key=${encodeURIComponent(geminiSlot.apiKey.trim())}`;
    const response = await aiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `Search the web and answer concisely with sources:\n${query}`,
              },
            ],
          },
        ],
        tools: [{ google_search: {} }],
      },
      timeoutMs: 45000,
    });

    const candidate =
      response.data && response.data.candidates && response.data.candidates[0];
    const parts = candidate && candidate.content && candidate.content.parts;
    const answer = parts
      ? parts
          .map(part => part.text || '')
          .filter(Boolean)
          .join('\n')
      : '';
    const grounding =
      candidate && candidate.groundingMetadata
        ? candidate.groundingMetadata.groundingChunks
        : null;
    const sources = grounding
      ? grounding
          .map(chunk =>
            chunk.web && chunk.web.title
              ? `- ${chunk.web.title}${
                  chunk.web.uri ? ` (${chunk.web.uri})` : ''
                }`
              : null
          )
          .filter(Boolean)
          .slice(0, 8)
          .join('\n')
      : '';
    return `[WEB SEARCH RESULTS — via ${geminiSlot.label}]\n${answer ||
      'No answer returned.'}${sources ? `\n\nSources:\n${sources}` : ''}`;
  });
  runtime.queue = task.catch(() => {});

  try {
    return await task;
  } catch (error) {
    return `[WEB SEARCH FAILED] ${(error &&
      error.response &&
      error.response.data &&
      JSON.stringify(error.response.data).slice(0, 300)) ||
      (error && error.message) ||
      'unknown error'}. Answer from your own knowledge.`;
  }
};

// ---------------------------------------------------------------------------
// Team introspection helpers (for the UI)
// ---------------------------------------------------------------------------

export const getTeamSummary = (): Array<{|
  slotId: string,
  label: string,
  role: AiProviderRole,
  model: string,
  ready: boolean,
  rpmLimit: number,
|}> =>
  getProviderSlots().map(slot => ({
    slotId: slot.id,
    label: slot.label,
    role: slot.role,
    model: slot.model,
    ready: isSlotUsable(slot),
    rpmLimit: slot.rpmLimit,
  }));

export const countReadySlots = (): number =>
  getProviderSlots().filter(isSlotUsable).length;

export type SlotHealth = {|
  slotId: string,
  ready: boolean,
  enabled: boolean,
  hasKey: boolean,
  cooldownRemainingMs: number,
  requestsLastMinute: number,
  consecutiveFailures: number,
|};

/**
 * Live runtime health of every slot (cooldowns, queue pressure, failures).
 * Used by the team dialog to show what the orchestrator is doing right now.
 */
export const getSlotsHealth = (): Array<SlotHealth> => {
  const now = Date.now();
  return getProviderSlots().map(slot => {
    const runtime = runtimes[slot.id];
    const windowStart = now - 60 * 1000;
    const recentTimestamps = runtime
      ? runtime.requestTimestamps.filter(ts => ts > windowStart)
      : [];
    return {
      slotId: slot.id,
      ready: isSlotUsable(slot),
      enabled: slot.enabled,
      hasKey: slot.keyless || slot.apiKey.trim().length > 0,
      cooldownRemainingMs:
        runtime && runtime.cooldownUntil > now
          ? runtime.cooldownUntil - now
          : 0,
      requestsLastMinute: recentTimestamps.length,
      consecutiveFailures: runtime ? runtime.consecutiveFailures : 0,
    };
  });
};

/**
 * Clear cooldowns / failure counters / rate windows — the "Refresh" button
 * for when the team is stuck (e.g. after network came back).
 */
export const resetAiRuntimes = (slotId?: ?string): void => {
  const resetOne = (id: string) => {
    const runtime = runtimes[id];
    if (runtime) {
      runtime.cooldownUntil = 0;
      runtime.requestTimestamps = [];
      runtime.consecutiveFailures = 0;
    }
  };
  if (slotId) {
    resetOne(slotId);
  } else {
    Object.keys(runtimes).forEach(resetOne);
  }
};

const isDefaultSlotId = (slotId: string): boolean =>
  DEFAULT_PROVIDER_SLOTS.some(slot => slot.id === slotId);

export const canRemoveSlot = (slotId: string): boolean =>
  !isDefaultSlotId(slotId);

/**
 * Append a new user-defined OpenAI-compatible provider slot.
 */
export const addCustomProviderSlot = (
  preset?: ?$Shape<AiProviderSlot>
): Array<AiProviderSlot> => {
  const slots = getProviderSlots();
  const id = `custom-${Date.now().toString(36)}`;
  slots.push({
    id,
    label: (preset && preset.label) || 'Custom provider',
    baseUrl: (preset && preset.baseUrl) || '',
    apiKey: (preset && preset.apiKey) || '',
    model: (preset && preset.model) || '',
    rpmLimit: (preset && preset.rpmLimit) || 0,
    enabled: preset ? preset.enabled !== false : true,
    role: (preset && preset.role) || 'fallback',
    capabilities: (preset && preset.capabilities) || ['text'],
    keyless: !!(preset && preset.keyless),
  });
  saveProviderSlots(slots);
  return slots;
};

/**
 * Remove a user-defined slot (default slots cannot be removed).
 */
export const removeProviderSlot = (slotId: string): Array<AiProviderSlot> => {
  if (isDefaultSlotId(slotId)) return getProviderSlots();
  const slots = getProviderSlots().filter(slot => slot.id !== slotId);
  saveProviderSlots(slots);
  delete runtimes[slotId];
  return slots;
};
