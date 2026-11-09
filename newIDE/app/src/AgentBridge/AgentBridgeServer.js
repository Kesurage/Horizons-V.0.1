// @flow
/**
 * Singleton managing the Agent Bridge lifecycle:
 *  - starts/stops the native HTTP server plugin,
 *  - receives every forwarded HTTP request (event "bridgeRequest"),
 *    routes it through the BridgeApi and sends the answer back,
 *  - tracks status (URLs, token, tunnel) for the UI panel.
 */
import { getBridgePlugin } from './BridgeNative';
import { handleBridgeRequest, setAgentBridgeContext } from './BridgeApi';
import { pushBridgeLog } from './BridgeLogs';

export type BridgeTunnelState = {
  active: boolean,
  url: string,
  subdomain: string,
  server: string,
  lastEvent: string,
};

export type BridgeStatus = {
  supported: boolean,
  running: boolean,
  starting: boolean,
  stopping: boolean,
  port: number,
  token: string,
  urls: Array<string>,
  startedAt: number,
  requestsServed: number,
  tunnel: BridgeTunnelState,
};

const status: BridgeStatus = {
  supported: false,
  running: false,
  starting: false,
  stopping: false,
  port: 0,
  token: '',
  urls: [],
  startedAt: 0,
  requestsServed: 0,
  tunnel: {
    active: false,
    url: '',
    subdomain: '',
    server: '',
    lastEvent: '',
  },
};

type StatusListener = (status: BridgeStatus) => void;
const statusListeners = new Set<StatusListener>();

let listenersRegistered = false;

const notifyStatus = () => {
  for (const listener of statusListeners) {
    try {
      listener({ ...status, tunnel: { ...status.tunnel } });
    } catch (ignored) {
      // A broken listener must not break the bridge.
    }
  }
};

export const subscribeToBridgeStatus = (
  listener: StatusListener
): (() => void) => {
  statusListeners.add(listener);
  listener({ ...status, tunnel: { ...status.tunnel } });
  return () => {
    statusListeners.delete(listener);
  };
};

const applyNativeState = (nativeState: any) => {
  if (!nativeState) return;
  status.running = !!nativeState.running;
  status.port = nativeState.port || 0;
  status.token = nativeState.token || '';
  status.urls = Array.isArray(nativeState.urls) ? nativeState.urls : [];
  status.startedAt = nativeState.startedAt || 0;
  status.requestsServed = nativeState.requestsServed || 0;
  if (nativeState.tunnel) {
    status.tunnel = {
      active: !!nativeState.tunnel.active,
      url: nativeState.tunnel.url || '',
      subdomain: nativeState.tunnel.subdomain || '',
      server: nativeState.tunnel.server || '',
      lastEvent: status.tunnel.lastEvent,
    };
  }
  notifyStatus();
};

const ensureListeners = () => {
  const plugin = getBridgePlugin();
  if (!plugin || listenersRegistered) return;
  listenersRegistered = true;

  plugin.addListener('bridgeRequest', async (request: any) => {
    if (!request || !request.id) return;
    status.requestsServed++;
    try {
      const answer = await handleBridgeRequest({
        method: request.method || 'GET',
        path: request.path || '/',
        query: request.query || '',
        body: request.body || '',
      });
      await plugin.respond({
        id: request.id,
        status: answer.status,
        body: answer.body,
      });
    } catch (error) {
      pushBridgeLog('error', 'Request handling crashed', String(error));
      try {
        await plugin.respond({
          id: request.id,
          status: 500,
          body: JSON.stringify({
            ok: false,
            error: 'The app crashed while handling the request.',
          }),
        });
      } catch (respondError) {
        // The native side times out on its own.
      }
    }
  });

  plugin.addListener('tunnelEvent', (event: any) => {
    if (!event) return;
    const phase = event.phase || '';
    status.tunnel.lastEvent = event.message || phase;
    if (phase === 'registered' && event.url) {
      status.tunnel.active = true;
      status.tunnel.url = event.url;
      pushBridgeLog('info', `Public tunnel: ${event.url}`);
    } else if (phase === 'error') {
      status.tunnel.active = false;
      pushBridgeLog('error', 'Public tunnel failed', event.message || '');
    } else if (phase === 'closed') {
      status.tunnel.active = false;
      status.tunnel.url = '';
      pushBridgeLog('info', 'Public tunnel closed');
    } else if (phase === 'registering') {
      pushBridgeLog('info', event.message || 'Registering public tunnel…');
    }
    notifyStatus();
  });
};

// ---------------------------------------------------------------------------
// Public API used by the AgentBridgePanel.
// ---------------------------------------------------------------------------

export const refreshBridgeStatus = async () => {
  const plugin = getBridgePlugin();
  status.supported = !!plugin;
  if (!plugin) {
    notifyStatus();
    return;
  }
  ensureListeners();
  try {
    const nativeState = await plugin.getState();
    applyNativeState(nativeState);
  } catch (ignored) {
    // Not running yet.
  }
  notifyStatus();
};

export const startBridge = async (): Promise<boolean> => {
  const plugin = getBridgePlugin();
  if (!plugin) {
    status.supported = false;
    notifyStatus();
    return false;
  }
  status.supported = true;
  status.starting = true;
  notifyStatus();
  ensureListeners();
  try {
    const result = await plugin.start({ port: 8090 });
    status.starting = false;
    if (result && result.ok === false) {
      pushBridgeLog('error', 'Bridge failed to start', result.error || '');
      notifyStatus();
      return false;
    }
    applyNativeState(result);
    pushBridgeLog(
      'info',
      `Bridge listening on port ${status.port}${
        status.urls.length ? ' — ' + status.urls.join(', ') : ''
      }`
    );
    notifyStatus();
    return true;
  } catch (error) {
    status.starting = false;
    pushBridgeLog('error', 'Bridge failed to start', String(error));
    notifyStatus();
    return false;
  }
};

export const stopBridge = async () => {
  const plugin = getBridgePlugin();
  if (!plugin) return;
  status.stopping = true;
  notifyStatus();
  try {
    const nativeState = await plugin.stop();
    applyNativeState(nativeState);
  } catch (ignored) {
    // Ignore.
  }
  status.stopping = false;
  status.running = false;
  status.urls = [];
  status.port = 0;
  pushBridgeLog('info', 'Bridge stopped.');
  notifyStatus();
};

export const startBridgeTunnel = async (): Promise<boolean> => {
  const plugin = getBridgePlugin();
  if (!plugin || !status.running) return false;
  try {
    const result = await plugin.startTunnel({});
    if (result && result.ok === false) {
      pushBridgeLog('error', 'Public tunnel failed', result.error || '');
      return false;
    }
    // The tunnelEvent listener reports registration + URL.
    pushBridgeLog('info', 'Requesting a public URL…');
    return true;
  } catch (error) {
    pushBridgeLog('error', 'Public tunnel failed', String(error));
    return false;
  }
};

export const stopBridgeTunnel = async () => {
  const plugin = getBridgePlugin();
  if (!plugin) return;
  try {
    await plugin.stopTunnel();
  } catch (ignored) {
    // Ignore.
  }
  status.tunnel.active = false;
  status.tunnel.url = '';
  notifyStatus();
};

// Re-exported so the MainFrame sync component can update it without
// importing two modules.
export { setAgentBridgeContext };
