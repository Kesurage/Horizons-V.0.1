// @flow
import axios from 'axios';
import type {
  AiRequest,
  AiRequestAssistantMessage,
  AiRequestUserMessage,
} from '../Utils/GDevelopServices/Generation';
import {
  chatCompletionWithFailover,
  getProviderSlots,
} from './MultiAiOrchestrator';

export type UniversalAiConfig = {
  baseUrl: string,
  apiKey: string,
  model: string,
  temperature: number,
  customSystemPrompt?: string,
};

const LOCAL_STORAGE_HISTORY_KEY = 'gd-universal-ai-history';

export const DEFAULT_AI_SYSTEM_PROMPT = `You are Horizons AI, an expert game development assistant for GDevelop / Horizons.
You help game developers write game logic, construct events, scripts, behaviors, expressions, and troubleshoot issues.
When giving event logic, format it clearly:
- Conditions: What triggers the event
- Actions: What happens when conditions are met
Provide concise, accurate, and ready-to-use game development instructions.`;

export const AI_PRESETS: {
  [key: string]: {
    label: string,
    baseUrl: string,
    model: string,
    description: string,
    requiresKey: boolean,
  },
} = {
  glm: {
    label: 'GLM 4.7 Flash (Z.ai)',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    model: 'glm-4.7-flash',
    description:
      'Z.ai GLM — agent-oriented workhorse, generous free tier (~40 req/min). Get a key at z.ai.',
    requiresKey: true,
  },
  gemini: {
    label: 'Gemini Flash (Google AI)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-flash-latest',
    description:
      'Google AI Studio — free tier ~15 req/min, huge context, vision + web search specialist.',
    requiresKey: true,
  },
  ollama: {
    label: 'Ollama (Local Offline)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2:latest',
    description:
      'Runs 100% locally on your computer with zero internet required.',
    requiresKey: false,
  },
  lmstudio: {
    label: 'LM Studio (Local Offline)',
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-model',
    description: 'Local OpenAI-compatible runner on port 1234.',
    requiresKey: false,
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    description: 'Official OpenAI API.',
    requiresKey: true,
  },
  openrouter: {
    label: 'OpenRouter (Multi-model)',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-3.5-sonnet',
    description: 'Access Claude, Gemini, DeepSeek, Llama and more via one key.',
    requiresKey: true,
  },
  groq: {
    label: 'Groq (Ultra-fast)',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    description: 'Ultra-low latency inference.',
    requiresKey: true,
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    description: 'Cost-effective reasoning and coding model.',
    requiresKey: true,
  },
};

/**
 * Clean up base URL to ensure no trailing slash.
 */
export const DEFAULT_AI_BASE_URL = 'https://api.openai.com/v1';

/**
 * Normalize any user-typed base URL into a clean OpenAI-compatible base:
 * - trims whitespace and trailing slashes
 * - if the user typed just an origin (https://api.example.com), append /v1
 * - if the user already pasted the full /chat/completions path, strip it
 *   (the /chat/completions suffix is appended by the callers)
 * Everything else (…/v1, …/v4, …/v1beta/openai, …/api/paas/v4, …/api/v1) is kept as-is.
 */
export const sanitizeBaseUrl = (rawUrl: ?string): string => {
  if (!rawUrl || !rawUrl.trim()) return DEFAULT_AI_BASE_URL;
  let url = rawUrl.trim();
  while (url.endsWith('/')) {
    url = url.slice(0, -1);
  }
  if (url.endsWith('/chat/completions')) {
    url = url.slice(0, -'/chat/completions'.length);
  }
  try {
    // Origin-only URLs (no path) get /v1 appended, following the most
    // common OpenAI-compatible convention.
    const parsed = new URL(url);
    if (parsed.pathname === '' || parsed.pathname === '/') {
      url = `${url}/v1`;
    }
  } catch (ignored) {
    // Invalid URL: return as-is, the request will fail with a clear error.
  }
  return url;
};

export const getChatCompletionsUrl = (rawUrl: ?string): string =>
  `${sanitizeBaseUrl(rawUrl)}/chat/completions`;

/**
 * Turn any request error into a human-readable, actionable message
 * (extracts the provider's own error message when available).
 */
export const describeAiError = (error: any, baseUrl: string): string => {
  const response = error && error.response;
  if (response) {
    const status = response.status;
    const providerMessage =
      response.data && response.data.error && response.data.error.message
        ? response.data.error.message
        : response.data && typeof response.data.message === 'string'
        ? response.data.message
        : null;
    if (status === 401 || status === 403) {
      return `The provider rejected the API key (HTTP ${status}).${
        providerMessage ? ` Provider says: "${providerMessage}"` : ''
      } Check the API key for ${baseUrl}.`;
    }
    if (status === 404) {
      return `Endpoint or model not found (HTTP 404).${
        providerMessage ? ` Provider says: "${providerMessage}"` : ''
      } Check the Base URL (${baseUrl}) and the model name — try "Discover Models".`;
    }
    if (status === 429) {
      return `Rate limit or quota reached on the provider (HTTP 429).${
        providerMessage ? ` Provider says: "${providerMessage}"` : ''
      } Wait a moment or check your plan/billing.`;
    }
    if (status >= 500) {
      return `The provider had a server error (HTTP ${status}).${
        providerMessage ? ` Provider says: "${providerMessage}"` : ''
      } This is on the provider side, try again.`;
    }
    return `The provider returned HTTP ${status}.${
      providerMessage ? ` Provider says: "${providerMessage}"` : ''
    }`;
  }
  if (error && error.code === 'ECONNABORTED') {
    return `The request timed out. ${baseUrl} did not answer in time — check the endpoint is running.`;
  }
  if (error && error.message && error.message.includes('Network Error')) {
    if (baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1')) {
      return `Could not reach ${baseUrl}. Start the local server (e.g. 'ollama serve') and allow browser requests (OLLAMA_ORIGINS="*").`;
    }
    return `Network/CORS error: the browser could not call ${baseUrl} directly. The provider must allow browser (cross-origin) requests — most OpenAI-compatible clouds do, but some (and self-hosted servers) block it. Test the same URL/key in another tool to confirm.`;
  }
  return (error && error.message) || 'Unknown connection error.';
};

/**
 * Test connectivity and model response from any OpenAI-compatible endpoint.
 */
export const testAiConnection = async (config: {
  baseUrl: string,
  apiKey: string,
  model: string,
}): Promise<{| success: boolean, message: string, latencyMs?: number |}> => {
  const startTime = Date.now();
  const baseUrl = sanitizeBaseUrl(config.baseUrl);

  try {
    const headers: { [string]: string } = {
      'Content-Type': 'application/json',
    };
    if (config.apiKey && config.apiKey.trim().length > 0) {
      headers['Authorization'] = `Bearer ${config.apiKey.trim()}`;
    }

    const payload = {
      model: config.model.trim() || 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: 'Reply with "OK" only.',
        },
      ],
      max_tokens: 10,
      temperature: 0.1,
    };

    const response = await axios.post(`${baseUrl}/chat/completions`, payload, {
      headers,
      timeout: 30000,
    });

    const latencyMs = Date.now() - startTime;
    if (
      response.data &&
      response.data.choices &&
      response.data.choices.length > 0
    ) {
      const reply = response.data.choices[0].message?.content || 'Success';
      return {
        success: true,
        message: `Connected successfully! Model replied in ${latencyMs}ms: "${reply.trim()}"`,
        latencyMs,
      };
    }

    return {
      success: true,
      message: `Connection successful (${latencyMs}ms).`,
      latencyMs,
    };
  } catch (error) {
    return {
      success: false,
      message: describeAiError(error, baseUrl),
    };
  }
};

/**
 * Fetch available models from OpenAI-compatible /models endpoint.
 */
export const fetchAvailableModels = async (config: {
  baseUrl: string,
  apiKey: string,
}): Promise<Array<string>> => {
  const baseUrl = sanitizeBaseUrl(config.baseUrl);
  try {
    const headers: { [string]: string } = {};
    if (config.apiKey && config.apiKey.trim().length > 0) {
      headers['Authorization'] = `Bearer ${config.apiKey.trim()}`;
    }
    const response = await axios.get(`${baseUrl}/models`, {
      headers,
      timeout: 8000,
    });
    if (response.data && Array.isArray(response.data.data)) {
      return response.data.data.map(m => m.id).filter(Boolean);
    }
    return [];
  } catch (err) {
    return [];
  }
};

/**
 * Send a chat completion request to custom AI provider and format as GDevelop AiRequest.
 */
export const executeUniversalAiChat = async ({
  userPrompt,
  conversationHistory = [],
  config,
  contextMetadata,
}: {
  userPrompt: string,
  conversationHistory?: Array<AiRequestAssistantMessage | AiRequestUserMessage>,
  config: UniversalAiConfig,
  contextMetadata?: ?string,
}): Promise<{ assistantText: string, requestId: string }> => {
  const systemMessage = {
    role: 'system',
    content: config.customSystemPrompt || DEFAULT_AI_SYSTEM_PROMPT,
  };

  // Convert previous history to OpenAI chat format
  const chatMessages = [systemMessage];

  if (contextMetadata) {
    chatMessages.push({
      role: 'system',
      content: `Current game project context:\n${contextMetadata}`,
    });
  }

  conversationHistory.forEach(msg => {
    if (msg.role === 'user') {
      const text = msg.content
        .filter(c => c.type === 'input_text' || c.text)
        .map(c => c.text || '')
        .join('\n');
      if (text) {
        chatMessages.push({ role: 'user', content: text });
      }
    } else if (msg.role === 'assistant') {
      const text = msg.content
        .filter(c => c.type === 'output_text')
        .map(c => c.text || '')
        .join('\n');
      if (text) {
        chatMessages.push({ role: 'assistant', content: text });
      }
    }
  });

  // Append new user prompt
  chatMessages.push({
    role: 'user',
    content: userPrompt,
  });

  // Route through the Multi-AI orchestrator: rate-limit queue + failover
  // across the whole configured team (GLM → Gemini → fallbacks).
  const data = await chatCompletionWithFailover({
    messages: chatMessages,
    temperature:
      typeof config.temperature === 'number' ? config.temperature : 0.7,
    tools: null,
    preferSlotId: getPreferredSlotIdForConfig(config),
  });

  const assistantText =
    (data.data &&
      data.data.choices &&
      data.data.choices[0] &&
      data.data.choices[0].message &&
      data.data.choices[0].message.content) ||
    'No response received from AI model.';
  const requestId = 'airq_univ_' + Date.now();

  return {
    assistantText,
    requestId,
  };
};

/**
 * When the caller passes an explicit single-provider config, prefer the
 * matching configured team slot for that endpoint (if any).
 */
export const getPreferredSlotIdForConfig = (config: UniversalAiConfig): ?string => {
  try {
    const slots = getProviderSlots();
    const target = sanitizeBaseUrl(config.baseUrl || '').toLowerCase();
    const match = slots.find(
      slot => sanitizeBaseUrl(slot.baseUrl).toLowerCase() === target
    );
    return match ? match.id : null;
  } catch (ignored) {
    return null;
  }
};

/**
 * Local offline store for AiRequests so chat history works seamlessly without GDevelop servers.
 */
export const getLocalAiHistory = (): Array<AiRequest> => {
  try {
    const raw =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(LOCAL_STORAGE_HISTORY_KEY)
        : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
};

export const saveLocalAiRequest = (aiRequest: AiRequest): void => {
  try {
    if (typeof localStorage === 'undefined') return;
    const history = getLocalAiHistory();
    const existingIndex = history.findIndex(r => r.id === aiRequest.id);
    if (existingIndex >= 0) {
      history[existingIndex] = aiRequest;
    } else {
      history.unshift(aiRequest);
    }
    // Keep max 50 recent requests to stay lightweight
    const trimmed = history.slice(0, 50);
    localStorage.setItem(LOCAL_STORAGE_HISTORY_KEY, JSON.stringify(trimmed));
  } catch (e) {
    // Ignore storage quota errors
  }
};

export const clearLocalAiHistory = (): void => {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(LOCAL_STORAGE_HISTORY_KEY);
    }
  } catch (e) {}
};
