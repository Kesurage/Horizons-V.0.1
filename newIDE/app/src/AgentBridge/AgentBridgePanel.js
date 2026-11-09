// @flow
import * as React from 'react';
import { Trans } from '@lingui/macro';
import {
  subscribeToBridgeStatus,
  refreshBridgeStatus,
  startBridge,
  stopBridge,
  type BridgeStatus,
} from './AgentBridgeServer';
import {
  subscribeToBridgeLogs,
  clearBridgeLogs,
  formatBridgeLogTime,
  type BridgeLogEntry,
} from './BridgeLogs';

/**
 * The AGENT BRIDGE panel — the app's single AI surface.
 *
 * Press Start → the app connects OUT to a public relay (MQTT over WebSocket,
 * no account, works on mobile data) and exposes a token-protected API.
 * An external AI agent — with its own intelligence, no API key needed in
 * the app — can then drive the whole editor: browse the project, write
 * events/objects/extensions, save — everything logged live below.
 */

const MAX_FEED_ENTRIES = 60;

const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (ignored) {
    // Fall back to the legacy path.
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const succeeded = document.execCommand('copy');
    document.body.removeChild(textarea);
    return succeeded;
  } catch (ignored) {
    return false;
  }
};

const dotStyle = (color: string, pulsing: boolean): Object => ({
  width: 8,
  height: 8,
  borderRadius: 999,
  flexShrink: 0,
  background: color,
  animation: pulsing ? 'gd-ai-pulse 1.2s infinite' : 'none',
});

const buttonStyle = (primary: boolean): Object => ({
  fontSize: 12,
  padding: primary ? '6px 14px' : '3px 10px',
  borderRadius: 6,
  cursor: 'pointer',
  fontWeight: primary ? 600 : 400,
  color: primary ? '#1b1b2b' : 'rgba(255,255,255,0.85)',
  background: primary ? '#69f0ae' : 'rgba(255,255,255,0.06)',
  border: primary ? 'none' : '1px solid rgba(255,255,255,0.14)',
});

const monoStyle: Object = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  color: 'rgba(255,255,255,0.85)',
  background: 'rgba(0,0,0,0.3)',
  borderRadius: 4,
  padding: '2px 6px',
  wordBreak: 'break-all',
};

const labelStyle: Object = {
  fontSize: 11,
  color: 'rgba(255,255,255,0.45)',
  flexShrink: 0,
};

const rowStyle: Object = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
  marginTop: 4,
};

const RELAY_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

const brokerHost = (broker: ?string): string => {
  if (!broker) return '';
  const noScheme = String(broker).replace(/^wss?:\/\//, '');
  return noScheme.split('/')[0];
};

const AgentBridgePanel = (): React.Node => {
  const [expanded, setExpanded] = React.useState(() => {
    try {
      return window.localStorage.getItem('gd-agent-bridge-expanded') === '1';
    } catch (ignored) {
      return false;
    }
  });
  const [status, setStatus] = React.useState<BridgeStatus | null>(null);
  const [logs, setLogs] = React.useState<Array<BridgeLogEntry>>([]);
  const [tokenRevealed, setTokenRevealed] = React.useState(false);
  const [flash, setFlash] = React.useState<string>('');
  const logBottomRef = React.useRef<?HTMLDivElement>(null);

  React.useEffect(() => {
    const unsubscribeStatus = subscribeToBridgeStatus(setStatus);
    const unsubscribeLogs = subscribeToBridgeLogs(setLogs);
    refreshBridgeStatus();
    return () => {
      unsubscribeStatus();
      unsubscribeLogs();
    };
  }, []);

  React.useEffect(() => {
    if (logBottomRef.current && expanded) {
      logBottomRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [logs, expanded]);

  const flashMessage = (message: string) => {
    setFlash(message);
    setTimeout(() => setFlash(''), 2500);
  };

  const toggleExpanded = () => {
    setExpanded(previous => {
      const next = !previous;
      try {
        window.localStorage.setItem(
          'gd-agent-bridge-expanded',
          next ? '1' : '0'
        );
      } catch (ignored) {
        // Preferences are best-effort.
      }
      return next;
    });
  };

  const running = !!(status && status.running);
  const supported = !status || status.supported !== false;
  const relay = status ? status.relay : null;
  const relayOnline = !!(relay && relay.active);
  const relayConnecting = !!(relay && relay.connecting);
  const relayHost = brokerHost(relay ? relay.broker : '');
  const relayTopic = relay && relay.topic ? relay.topic : '';

  const maskToken = (token: string) =>
    token.length > 12
      ? `${token.slice(0, 6)}${'•'.repeat(14)}${token.slice(-4)}`
      : '••••••••';

  const buildBriefing = (): string => {
    if (!status) return '';
    const topic = relayTopic || 'hz/?';
    return [
      'Horizons Agent Bridge — connect an AI agent to my game editor (v0.3.1):',
      '',
      'Relay (works on mobile data, no account, no API key):',
      `  broker: ${RELAY_BROKERS[0]}`,
      `  fallback broker: ${RELAY_BROKERS[1]}`,
      `  topic: ${topic}`,
      `  token: ${status.token}`,
      '',
      'Protocol (MQTT over WebSocket + TLS, QoS 1):',
      `  1. subscribe to  ${topic}/evt  and  ${topic}/status`,
      `  2. publish commands to  ${topic}/cmd  as JSON:`,
      `     {"id":"<any-id>","token":"${status.token}","method":"GET","path":"/","query":"","body":""}`,
      `  3. the answer arrives on  ${topic}/evt :`,
      '     {"id":"<same-id>","status":200,"body":"<json>"}',
      '',
      'Start with GET / — it returns the full manifest and a complete',
      'self-serve guide (endpoints, event JSON format, workflow, safety nets).',
      'Then browse and edit the project live and save it. Keep the app open',
      'while the agent works.',
      status.urls.length
        ? `(On the same Wi-Fi, ${status.urls[0]} with the same token also works.)`
        : '',
    ]
      .filter(line => line !== '')
      .join('\n');
  };

  const onStart = async () => {
    await startBridge();
  };

  const onStop = async () => {
    await stopBridge();
    setTokenRevealed(false);
  };

  const headerColor = running
    ? relayOnline
      ? '#69f0ae'
      : relayConnecting
      ? '#ffa726'
      : '#4caf50'
    : status && status.supported === false
    ? '#78909c'
    : '#ffa726';

  const headerText = !supported
    ? 'Android app only'
    : running
    ? relayOnline
      ? `Relay: ${relayHost || 'online'}`
      : relayConnecting
      ? 'Connecting to relay…'
      : status && status.urls.length
      ? status.urls[0].replace(/^https?:\/\//, '')
      : `port ${status ? status.port : ''}`
    : status && status.starting
    ? 'Starting…'
    : 'Off — press Start';

  return (
    <div
      style={{
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        background: 'rgba(0,0,0,0.12)',
        flexShrink: 0,
      }}
    >
      {/* Header — always visible, acts as the toggle. */}
      <div
        onClick={toggleExpanded}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 10px',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <span
          style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}
        >
          <Trans>Agent Bridge</Trans>
        </span>
        <span
          style={dotStyle(
            headerColor,
            !!(status && (status.starting || (running && relayConnecting)))
          )}
        />
        <span
          style={{
            fontSize: 11,
            color: 'rgba(255,255,255,0.45)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}
        >
          {headerText}
        </span>
        <span
          style={{
            fontSize: 10,
            color: 'rgba(255,255,255,0.45)',
            flexShrink: 0,
          }}
        >
          {expanded ? '▾' : '▸'}
        </span>
      </div>

      {/* Expanded: the whole bridge control room. */}
      {expanded && (
        <div style={{ padding: '0 10px 8px' }}>
          {!supported && (
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
              <Trans>
                The bridge needs the Android app (it connects to the relay
                from the device). In a desktop browser there is nothing to
                host.
              </Trans>
            </div>
          )}

          {supported && !running && (
            <div>
              <div
                style={{
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: 'rgba(255,255,255,0.6)',
                  marginBottom: 8,
                }}
              >
                <Trans>
                  Press Start and give any AI agent the briefing — it can then
                  browse your project, write events, objects and extensions,
                  and save. Works on mobile data and Wi-Fi, no account, no API
                  key. Everything appears in the log below, and every change
                  can be reverted.
                </Trans>
              </div>
              <button
                style={buttonStyle(true)}
                onClick={onStart}
                disabled={!!(status && status.starting)}
              >
                <Trans>Start Bridge</Trans>
              </button>
            </div>
          )}

          {running && status && (
            <div>
              {/* Relay status */}
              <div style={rowStyle}>
                <span style={labelStyle}>
                  <Trans>Relay</Trans>
                </span>
                {relayOnline ? (
                  <span style={monoStyle}>
                    {relayHost || 'online'} · {relayTopic}
                  </span>
                ) : relayConnecting ? (
                  <span
                    style={{
                      fontSize: 11,
                      color: 'rgba(255,255,255,0.55)',
                    }}
                  >
                    <Trans>connecting…</Trans>
                  </span>
                ) : (
                  <span
                    style={{
                      fontSize: 11,
                      color: '#ef9a9a',
                    }}
                  >
                    {relay && relay.lastError
                      ? relay.lastError
                      : 'offline'}
                  </span>
                )}
              </div>

              {/* Token */}
              <div style={rowStyle}>
                <span style={labelStyle}>
                  <Trans>Token</Trans>
                </span>
                <span style={monoStyle}>
                  {tokenRevealed
                    ? status.token
                    : maskToken(status.token)}
                </span>
                <button
                  style={buttonStyle(false)}
                  onClick={() => setTokenRevealed(previous => !previous)}
                >
                  {tokenRevealed ? <Trans>Hide</Trans> : <Trans>Show</Trans>}
                </button>
                <button
                  style={buttonStyle(false)}
                  onClick={() => {
                    copyToClipboard(status.token).then(() =>
                      flashMessage('Token copied')
                    );
                  }}
                >
                  <Trans>Copy</Trans>
                </button>
              </div>

              {/* LAN access (bonus, when the local server could bind) */}
              {status.urls.length > 0 && (
                <div style={rowStyle}>
                  <span style={labelStyle}>
                    <Trans>Same Wi-Fi</Trans>
                  </span>
                  <span style={monoStyle}>{status.urls[0]}</span>
                  <button
                    style={buttonStyle(false)}
                    onClick={() => {
                      copyToClipboard(status.urls[0]).then(() =>
                        flashMessage('LAN URL copied')
                      );
                    }}
                  >
                    <Trans>Copy</Trans>
                  </button>
                </div>
              )}

              {/* One-click briefing for the agent chat */}
              <div style={{ marginTop: 8 }}>
                <button
                  style={buttonStyle(true)}
                  onClick={() => {
                    copyToClipboard(buildBriefing()).then(succeeded =>
                      flashMessage(
                        succeeded
                          ? 'Agent briefing copied — paste it in a chat with any AI'
                          : 'Copy failed — long-press the token to copy it manually'
                      )
                    );
                  }}
                >
                  <Trans>Copy agent briefing</Trans>
                </button>
                {flash && (
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: 11,
                      color: '#69f0ae',
                    }}
                  >
                    {flash}
                  </span>
                )}
              </div>

              {/* Stats + live log */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginTop: 8,
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>
                  <Trans>Activity log</Trans> · {status.requestsServed}{' '}
                  <Trans>requests</Trans>
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    style={buttonStyle(false)}
                    onClick={() => {
                      clearBridgeLogs();
                    }}
                  >
                    <Trans>Clear</Trans>
                  </button>
                  <button
                    style={{ ...buttonStyle(false), color: '#ef9a9a' }}
                    onClick={onStop}
                    disabled={!!(status && status.stopping)}
                  >
                    <Trans>Stop Bridge</Trans>
                  </button>
                </div>
              </div>
              <div
                style={{
                  marginTop: 4,
                  maxHeight: 150,
                  overflowY: 'auto',
                  borderRadius: 6,
                  padding: '4px 8px',
                  background: 'rgba(0,0,0,0.25)',
                  border: '1px solid rgba(255,255,255,0.06)',
                }}
              >
                {logs.length === 0 ? (
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
                    <Trans>
                      Everything the agent does appears here (requests,
                      writes, notes, errors…).
                    </Trans>
                  </div>
                ) : (
                  logs.slice(-MAX_FEED_ENTRIES).map((entry, index) => {
                    const colorByLevel = {
                      info: 'rgba(255,255,255,0.6)',
                      request: '#4dabf5',
                      write: '#69f0ae',
                      error: '#ef5350',
                      agent: '#ce93d8',
                    };
                    return (
                      <div
                        key={index}
                        style={{
                          display: 'flex',
                          gap: 6,
                          fontSize: 11,
                          lineHeight: 1.4,
                          padding: '1px 0',
                        }}
                      >
                        <span
                          style={{
                            color: 'rgba(255,255,255,0.35)',
                            flexShrink: 0,
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {formatBridgeLogTime(entry.ts)}
                        </span>
                        <span
                          style={{
                            color:
                              colorByLevel[entry.level] ||
                              'rgba(255,255,255,0.6)',
                          }}
                        >
                          {entry.message}
                        </span>
                      </div>
                    );
                  })
                )}
                <div ref={logBottomRef} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default AgentBridgePanel;
