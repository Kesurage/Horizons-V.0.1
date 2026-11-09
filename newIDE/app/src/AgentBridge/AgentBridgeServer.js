// @flow
/**
 * Singleton managing the Agent Bridge lifecycle:
 *  - starts/stops the native bridge (outbound relay connection + best-effort
 *    local server for LAN access),
 *  - receives every forwarded request (event "bridgeRequest"), routes it
 *    through the BridgeApi and sends the answer back,
 *  - tracks relay status (broker, topic, online state) for the UI panel.
 */
import { getBridgePlugin } from './BridgeNative';
import { handleBridgeRequest, setAgentBridgeContext } from './BridgeApi';
import { pushBridgeLog } from './BridgeLogs';

export type BridgeRelayState = {
  active: boolean,
  connecting: boolean,
  broker: string,
  topic: string,
  lastError: string,
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
  localServerError: string,
  startedAt: number,
  requestsServed: number,
  relay: BridgeRelayState,
};

const status: BridgeStatus = {
  supported: false,
  running: false,
  starting: false,
  stopping: false,
  port: 0,
  token: '',
  urls: [],
  localServerError: '',
  startedAt: 0,
  requestsServed: 0,
  relay: {
    active: false,
    connecting: false,
    broker: '',
    topic: '',
    lastError: '',
    lastEvent: '',
  },
};

type StatusListener = (status: BridgeStatus) => void;
const statusListeners = new Set<StatusListener>();

let listenersRegistered = false;

const notifyStatus = () => {
  for (const listener of statusListeners) {
    try {
      listener({ ...status, relay: { ...status.relay } });
    } catch (ignored) {
      // A broken listener must not break the bridge.
    }
  }
};

export const subscribeToBridgeStatus = (
  listener: StatusListener
): (() => void) => {
  statusListeners.add(listener);
  listener({ ...status, relay: { ...status.relay } });
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
  status.localServerError = nativeState.localServerError || '';
  status.startedAt = nativeState.startedAt || 0;
  status.requestsServed = nativeState.requestsServed || 0;
  if (nativeState.relay) {
    status.relay = {
      active: !!nativeState.relay.active,
      connecting: !!nativeState.relay.connecting,
      broker: nativeState.relay.broker || '',
      topic: nativeState.relay.topic || '',
      lastError: nativeState.relay.lastError || '',
      lastEvent: status.relay.lastEvent,
    };
  }
  notifyStatus();
};

const brokerHost = (broker: string): string => {
  if (!broker) return '';
  const noScheme = String(broker).replace(/^wss?:\/\//, '');
  return noScheme.split('/')[0];
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

  plugin.addListener('relayEvent', (event: any) => {
    if (!event) return;
    const phase = event.phase || '';
    status.relay.lastEvent = event.message || phase;
    if (phase === 'online') {
      status.relay.active = true;
      status.relay.connecting = false;
      status.relay.broker = event.broker || status.relay.broker;
      status.relay.topic = event.topic || status.relay.topic;
      status.relay.lastError = '';
      pushBridgeLog(
        'info',
        `Relay online via ${brokerHost(status.relay.broker)} — agents can connect on ${status.relay.topic}`
      );
    } else if (phase === 'offline') {
      status.relay.active = false;
      status.relay.connecting = true;
      pushBridgeLog('info', 'Relay connection lost — reconnecting…');
    } else if (phase === 'error') {
      status.relay.active = false;
      status.relay.connecting = false;
      status.relay.lastError = event.message || 'Relay error';
      pushBridgeLog('error', 'Relay failed', status.relay.lastError);
    } else if (phase === 'closed') {
      status.relay.active = false;
      status.relay.connecting = false;
      pushBridgeLog('info', 'Relay closed');
    } else if (phase === 'connecting') {
      status.relay.connecting = true;
      pushBridgeLog('info', event.message || 'Connecting to the relay…');
    } else if (phase === 'warning') {
      pushBridgeLog('error', 'Relay warning', event.message || '');
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
    if (status.localServerError) {
      // Not fatal at all: the relay works on any network, the local server
      // is only a bonus for devices on the same Wi-Fi.
      pushBridgeLog(
        'error',
        'Local server (same Wi-Fi access) failed to start',
        `${status.localServerError} — the relay still works everywhere.`
      );
    }
    pushBridgeLog(
      'info',
      'Bridge session started — connecting the relay (broker.emqx.io)…'
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
  status.localServerError = '';
  status.relay = {
    active: false,
    connecting: false,
    broker: '',
    topic: '',
    lastError: '',
    lastEvent: '',
  };
  pushBridgeLog('info', 'Bridge stopped.');
  notifyStatus();
};

// Re-exported so the MainFrame sync component can update it without
// importing two modules.
export { setAgentBridgeContext };
