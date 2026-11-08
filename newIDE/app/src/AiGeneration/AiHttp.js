// @flow
/**
 * Network core for every AI provider call in Horizons.
 *
 * Why a custom fetch wrapper instead of axios?
 *  - `aiFetch` uses a watchdog `Promise.race`: the caller ALWAYS gets an
 *    answer (response or error) within the requested timeout, whatever the
 *    platform does underneath (a hung native bridge, an idle connection...).
 *  - Errors are normalised to the axios-like shape
 *    `{ response: { status, data, headers }, message, code }` so that the
 *    existing `describeAiError` logic keeps working unchanged.
 *
 * Platform notes:
 *  - In a plain browser, the request is a standard `fetch` (subject to CORS —
 *    the supported providers, Z.ai and Google AI Studio, allow it).
 *  - In the Horizons Android app (Capacitor), `fetch` stays the WebView's own
 *    implementation so LOCAL requests (preview files, runtime, service
 *    worker) work normally. If a request fails at the network level (e.g. a
 *    custom provider without CORS headers), it is retried ONCE through the
 *    native `CapacitorHttp` plugin — which bypasses CORS entirely. HTTP
 *    error statuses (429, 401...) are surfaced exactly like `fetch` ones.
 *  - Works in Node-based tests (where tests stub it).
 */

export type AiHttpOptions = {|
  method?: 'GET' | 'POST',
  headers?: { [string]: string },
  /** JSON-serialisable request body (POST only). */
  body?: any,
  /** Hard deadline in ms — guaranteed. */
  timeoutMs?: number,
|};

export type AiHttpResponse = {|
  status: number,
  data: any,
  headers: { [string]: string },
|};

const readHeaders = (response: any): { [string]: string } => {
  const headers: { [string]: string } = {};
  try {
    if (response.headers && typeof response.headers.forEach === 'function') {
      response.headers.forEach((value: string, key: string) => {
        headers[String(key).toLowerCase()] = value;
      });
    } else if (
      response.headers &&
      typeof response.headers.entries === 'function'
    ) {
      for (const [key, value] of response.headers.entries()) {
        headers[String(key).toLowerCase()] = String(value);
      }
    }
  } catch (ignored) {
    // Headers are best-effort only.
  }
  return headers;
};

const parseBodyText = (text: ?string): any => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (ignored) {
    return text;
  }
};

const makeHttpError = (
  status: number,
  data: any,
  headers: { [string]: string }
): any => {
  const error: any = new Error(`Request failed with status code ${status}`);
  error.response = { status, data, headers };
  return error;
};

/** The native CapacitorHttp plugin, when running inside the app shell. */
const getCapacitorHttpPlugin = (): any => {
  try {
    const capacitor = typeof window !== 'undefined' ? window.Capacitor : null;
    if (
      capacitor &&
      typeof capacitor.isNativePlatform === 'function' &&
      capacitor.isNativePlatform()
    ) {
      return (capacitor.Plugins && capacitor.Plugins.CapacitorHttp) || null;
    }
  } catch (ignored) {
    // Not in a Capacitor shell.
  }
  return null;
};

/**
 * Run a promise with a guaranteed deadline. The losing promise is silenced
 * so no unhandled rejection ever surfaces.
 */
const withWatchdog = async <T>(
  task: Promise<T>,
  timeoutMs: number
): Promise<T> => {
  let watchdogTimer;
  const watchdog = new Promise((resolve: any, reject: any) => {
    watchdogTimer = setTimeout(() => {
      const error: any = new Error(`timeout of ${timeoutMs}ms exceeded`);
      error.code = 'ECONNABORTED';
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([task, watchdog]);
  } finally {
    clearTimeout(watchdogTimer);
    task.catch(() => {});
    watchdog.catch(() => {});
  }
};

/** Perform the request through the native CapacitorHttp plugin. */
const requestThroughCapacitorHttp = async (
  url: string,
  options: ?AiHttpOptions
): Promise<AiHttpResponse> => {
  const plugin = getCapacitorHttpPlugin();
  if (!plugin) throw new Error('CapacitorHttp plugin not available');

  const method = (options && options.method) || 'GET';
  const timeoutMs = (options && options.timeoutMs) || 60000;

  const nativeRequest: { [string]: any } = {
    url,
    method,
    headers: (options && options.headers) || {},
    connectTimeout: timeoutMs,
    readTimeout: timeoutMs,
  };
  if (method === 'POST' && options && options.body !== undefined) {
    // The plugin serialises objects as a JSON body.
    nativeRequest.data = options.body;
  }

  // The plugin RESOLVES even on HTTP error statuses (with the parsed error
  // body in `data`), and only rejects on network-level failures.
  const result = await withWatchdog(plugin.request(nativeRequest), timeoutMs);
  const status = result.status;
  const headers: { [string]: string } = {};
  try {
    Object.keys(result.headers || {}).forEach(key => {
      headers[String(key).toLowerCase()] = String(result.headers[key]);
    });
  } catch (ignored) {
    // Headers are best-effort only.
  }
  return { status, data: result.data, headers };
};

/**
 * Perform an HTTP request with a guaranteed timeout.
 * Throws axios-shaped errors on HTTP >= 400, network failure or timeout.
 */
export const aiFetch = async (
  url: string,
  options?: AiHttpOptions
): Promise<AiHttpResponse> => {
  const method = (options && options.method) || 'GET';
  const timeoutMs = (options && options.timeoutMs) || 60000;
  const headers = (options && options.headers) || {};

  if (typeof fetch !== 'function') {
    throw new Error('Network Error: this environment does not provide fetch()');
  }

  const doFetch = (async () => {
    const response = await fetch(url, {
      method,
      headers,
      body:
        method === 'POST' && options && options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined,
    });
    const text = await response.text();
    return { response, text };
  })();

  let fetchResult: ?{ response: any, text: ?string } = null;
  let fetchError: ?any = null;
  try {
    fetchResult = await withWatchdog(doFetch, timeoutMs);
  } catch (error) {
    fetchError = error;
  }

  if (fetchResult && fetchResult.response) {
    const { response, text } = fetchResult;
    const status = response.status;
    const data = parseBodyText(text);
    const flatHeaders = readHeaders(response);
    if (status >= 400) {
      throw makeHttpError(status, data, flatHeaders);
    }
    return { status, data, headers: flatHeaders };
  }

  // The fetch failed at the network level (or timed out). In the app shell,
  // retry ONCE through the native stack — it bypasses CORS and uses its own
  // timeouts, which recovers custom providers that don't allow CORS.
  const isNetworkLevelError = !(fetchError && fetchError.response);
  if (isNetworkLevelError && getCapacitorHttpPlugin()) {
    try {
      const nativeResponse = await requestThroughCapacitorHttp(
        url,
        options || {}
      );
      if (nativeResponse.status >= 400) {
        throw makeHttpError(
          nativeResponse.status,
          nativeResponse.data,
          nativeResponse.headers
        );
      }
      return nativeResponse;
    } catch (nativeError) {
      if (nativeError && nativeError.response) throw nativeError;
      const error: any = new Error(
        (nativeError && nativeError.message) ||
          (fetchError && fetchError.message) ||
          'Network Error'
      );
      error.code = (nativeError && nativeError.code) || 'ERR_NETWORK';
      throw error;
    }
  }

  throw fetchError || new Error('Network Error');
};
