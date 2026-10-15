// @flow
import axios from 'axios';
import type {
  AiRequest,
  AiRequestAssistantMessage,
  AiRequestUserMessage,
} from '../Utils/GDevelopServices/Generation';

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

export const AI_PRESETS: { [key: string]: { label: string, baseUrl: string, model: string, description: string, requiresKey: boolean } } = {
  ollama: {
    label: 'Ollama (Local Offline)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2:latest',
    description: 'Runs 100% locally on your computer with zero internet required.',
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
export const sanitizeBaseUrl = (rawUrl: ?string): string => {
  if (!rawUrl) return 'https://api.openai.com/v1';
  let url = rawUrl.trim();
  while (url.endsWith('/')) {
    url = url.slice(0, -1);
  }
  return url;
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
      timeout: 15000,
    });

    const latencyMs = Date.now() - startTime;
    if (response.data && response.data.choices && response.data.choices.length > 0) {
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
    let errorDetail = error.message;
    if (error.response) {
      if (error.response.status === 401) {
        errorDetail = 'Authentication failed (401). Please check your API key.';
      } else if (error.response.status === 404) {
        errorDetail = `Endpoint or model not found (404). Check Base URL (${baseUrl}) or Model name (${config.model}).`;
      } else if (error.response.data && error.response.data.error) {
        errorDetail = error.response.data.error.message || JSON.stringify(error.response.data.error);
      }
    } else if (error.code === 'ECONNABORTED') {
      errorDetail = 'Request timed out after 15s. Ensure the local server is running and responding.';
    } else if (error.message.includes('Network Error') && (baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1'))) {
      errorDetail = `Could not reach ${baseUrl}. Ensure Ollama / local LLM is started (e.g. 'ollama serve') and CORS allows browser requests (OLLAMA_ORIGINS="*").`;
    }

    return {
      success: false,
      message: errorDetail,
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
  const baseUrl = sanitizeBaseUrl(config.baseUrl);
  const headers: { [string]: string } = {
    'Content-Type': 'application/json',
  };
  if (config.apiKey && config.apiKey.trim().length > 0) {
    headers['Authorization'] = `Bearer ${config.apiKey.trim()}`;
  }

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

  const response = await axios.post(
    `${baseUrl}/chat/completions`,
    {
      model: config.model || 'gpt-4o',
      messages: chatMessages,
      temperature: typeof config.temperature === 'number' ? config.temperature : 0.7,
    },
    {
      headers,
      timeout: 60000,
    }
  );

  const assistantText =
    response.data?.choices?.[0]?.message?.content ||
    'No response received from AI model.';
  const requestId = 'airq_univ_' + Date.now();

  return {
    assistantText,
    requestId,
  };
};

/**
 * Local offline store for AiRequests so chat history works seamlessly without GDevelop servers.
 */
export const getLocalAiHistory = (): Array<AiRequest> => {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LOCAL_STORAGE_HISTORY_KEY) : null;
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
