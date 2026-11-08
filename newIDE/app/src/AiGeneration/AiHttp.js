// @flow
/**
 * Network core for every AI provider call in Horizons.
 *
 * Why a custom fetch wrapper instead of axios?
 *  - In the Android APK, Capacitor's CapacitorHttp plugin patches
 *    `window.fetch` (and XHR) to route requests through the native network
 *    stack — bypassing WebView CORS restrictions entirely. Some native
 *    bridges do not honour the XHR `timeout` property though, which made
 *    requests hang forever ("Gemini never responds").
 *  - `aiFetch` therefore uses a watchdog `Promise.race`: the caller ALWAYS
 *    gets an answer (response or error) within the requested timeout,
 *    whatever the platform does underneath.
 *  - Errors are normalised to the axios-like shape
 *    `{ response: { status, data, headers }, message, code }` so that the
 *    existing `describeAiError` logic keeps working unchanged.
 *
 * The request also works in a plain browser (where it is subject to CORS,
 * as any request would be) and in Node-based tests (where tests stub it).
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

  let fetchAvailable = typeof fetch === 'function';
  if (!fetchAvailable) {
    throw new Error(
      'Network Error: this environment does not provide fetch()'
    );
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

  // Watchdog: whatever happens to the underlying request (including a native
  // bridge that ignores AbortController), the caller gets an answer in time.
  let watchdogTimer;
  const watchdog = new Promise((resolve: any, reject: any) => {
    watchdogTimer = setTimeout(() => {
      const error: any = new Error(
        `timeout of ${timeoutMs}ms exceeded`
      );
      error.code = 'ECONNABORTED';
      reject(error);
    }, timeoutMs);
  });

  let response;
  let text;
  try {
    const result = await Promise.race([doFetch, watchdog]);
    if (!result) throw new Error('Network Error');
    response = result.response;
    text = result.text;
  } finally {
    clearTimeout(watchdogTimer);
    // Silence a possible late rejection of the losing promise.
    doFetch.catch(() => {});
    watchdog.catch(() => {});
  }

  const status = response.status;
  const data = parseBodyText(text);
  const flatHeaders = readHeaders(response);

  if (status >= 400) {
    const error: any = new Error(
      `Request failed with status code ${status}`
    );
    error.response = {
      status,
      data,
      headers: flatHeaders,
    };
    throw error;
  }

  return { status, data, headers: flatHeaders };
};
