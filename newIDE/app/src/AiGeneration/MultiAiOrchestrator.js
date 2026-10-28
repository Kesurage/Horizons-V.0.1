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

import axios from 'axios';
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
};

export type AiStatusEvent = {
  kind:
    | 'request-start'
    | 'queued'
    | 'provider-cooldown'
    | 'provider-success'
    | 'delegation'
    | 'web-search'
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
    rpmLimit: 40, // user-tunable; Z.ai free tier is generous for agent tasks
    enabled: true,
    role: 'primary',
    capabilities: ['text'],
    keyless: false,
  },
  {
    id: 'gemini-specialist',
    label: 'Gemini Flash (Google AI)',
    baseUrl: GEMINI_OPENAI_BASE_URL,
    apiKey: '',
    model: 'gemini-flash-latest',
    rpmLimit: 15, // Google free tier
    enabled: true,
    role: 'specialist',
    capabilities: ['text', 'vision', 'image-generation', 'video-analysis', 'web-search'],
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
const LEGACY_PREFERENCES_KEY = 'gd-preferences';
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
        const merged = DEFAULT_PROVIDER_SLOTS.map(defaultSlot => ({
          ...defaultSlot,
          ...(storedById[defaultSlot.id] || {}),
        }));
        // Keep any user-created custom slots at the end.
        const defaultIds = new Set(DEFAULT_PROVIDER_SLOTS.map(s => s.id));
        parsed.forEach(slot => {
          if (slot && slot.id && !defaultIds.has(slot.id)) {
            merged.push(slot);
          }
        });
        return cloneSlots(merged);
      }
    }
  } catch (ignored) {
    // Fall through to migration/defaults.
  }
  const seeded = migrateLegacyConfig(cloneSlots(DEFAULT_PROVIDER_SLOTS));
  saveProviderSlots(seeded);
  return seeded;
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
};

const runtimes: { [string]: SlotRuntime } = {};

const getRuntime = (slotId: string): SlotRuntime => {
  if (!runtimes[slotId]) {
    runtimes[slotId] = {
      requestTimestamps: [],
      queue: Promise.resolve(),
      cooldownUntil: 0,
      consecutiveFailures: 0,
    };
  }
  return runtimes[slotId];
};

const msUntilSlotFree = (slot: AiProviderSlot, runtime: SlotRuntime): number => {
  const now = Date.now();
  if (now < runtime.cooldownUntil) {
    return runtime.cooldownUntil - now;
  }
  if (!slot.rpmLimit || slot.rpmLimit <= 0) return 0;
  const windowStart = now - 60 * 1000;
  runtime.requestTimestamps = runtime.requestTimestamps.filter(
    timestamp => timestamp > windowStart
  );
  if (runtime.requestTimestamps.length < slot.rpmLimit) return 0;
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
    message: `${reason} — cooling down ${(ms / 1000).toFixed(0)}s before reuse.`,
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
  const retryAfter = headers['retry-after'];
  if (retryAfter) {
    const seconds = parseFloat(retryAfter);
    if (!isNaN(seconds)) return seconds * 1000;
  }
  return null;
};

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
  slot.enabled && (slot.keyless || (slot.apiKey && slot.apiKey.trim().length > 0));

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
      temperature:
        typeof temperature === 'number' ? temperature : 0.7,
    };
    if (tools && tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = 'auto';
    }

    runtime.requestTimestamps.push(Date.now());

    try {
      const response = await axios.post(
        `${sanitizeBaseUrl(slot.baseUrl)}/chat/completions`,
        payload,
        { headers, timeout: 180000 }
      );
      return response.data;
    } catch (error) {
      if (isRateLimitError(error)) {
        const retryAfterMs = extractRetryAfterMs(error) || 20000;
        cooldownSlot(
          slot,
          Math.min(Math.max(retryAfterMs, 10000), 120000),
          `${slot.label} hit its rate limit (HTTP ${
            error.response ? error.response.status : 429
          })`
        );
      } else if (isServerError(error)) {
        cooldownSlot(slot, 15000, `${slot.label} had a server error`);
      }
      throw error;
    }
  });
  // Keep the queue chain alive even if this task fails.
  runtime.queue = task.catch(() => {});
  return task;
};

export type OrchestratedResult = {|
  data: any,
  slotId: string,
  providerLabel: string,
  model: string,
|};

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
  for (let index = 0; index < chain.length; index++) {
    const slot = chain[index];
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
    return `[SPECIALIST UNAVAILABLE] The specialist AI could not be reached: ${
      (error && error.message) || 'unknown error'
    }. Continue with your own knowledge and tell the user the specialist was unavailable.`;
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
    const response = await axios.post(
      url,
      {
        contents: [
          {
            role: 'user',
            parts: [{ text: `Search the web and answer concisely with sources:\n${query}` }],
          },
        ],
        tools: [{ google_search: {} }],
      },
      { timeout: 45000 }
    );

    const candidate =
      response.data && response.data.candidates && response.data.candidates[0];
    const parts = candidate && candidate.content && candidate.content.parts;
    const answer = parts
      ? parts.map(part => part.text || '').filter(Boolean).join('\n')
      : '';
    const grounding =
      candidate && candidate.groundingMetadata
        ? candidate.groundingMetadata.groundingChunks
        : null;
    const sources = grounding
      ? grounding
          .map(chunk => chunk.web && chunk.web.title ? `- ${chunk.web.title}${chunk.web.uri ? ` (${chunk.web.uri})` : ''}` : null)
          .filter(Boolean)
          .slice(0, 8)
          .join('\n')
      : '';
    return `[WEB SEARCH RESULTS — via ${geminiSlot.label}]\n${answer || 'No answer returned.'}${
      sources ? `\n\nSources:\n${sources}` : ''
    }`;
  });
  runtime.queue = task.catch(() => {});

  try {
    return await task;
  } catch (error) {
    return `[WEB SEARCH FAILED] ${
      (error && error.response && error.response.data && JSON.stringify(error.response.data).slice(0, 300)) ||
      (error && error.message) ||
      'unknown error'
    }. Answer from your own knowledge.`;
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
