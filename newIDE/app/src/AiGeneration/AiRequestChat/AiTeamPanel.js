// @flow
import * as React from 'react';
import { Trans } from '@lingui/macro';
import {
  subscribeAiStatus,
  getTeamSummary,
  getSlotsHealth,
  resetAiRuntimes,
  type AiStatusEvent,
  type SlotHealth,
} from '../MultiAiOrchestrator';

/**
 * The AI TEAM panel, always visible at the top of the chat.
 *
 * It answers the two questions users could not answer before:
 *  1. "Is the other AI working?" — every provider gets a live status card
 *     (ready / working / cooling down / no key), with its model and role.
 *  2. "Can they communicate?" — the Team channel shows, in real time, the
 *     messages exchanged inside the team: who starts researching in
 *     parallel, when the researcher delivers its notes to the builder,
 *     retries, queueing, delegation...
 */

type TeamSummaryEntry = {|
  slotId: string,
  label: string,
  role: 'primary' | 'specialist' | 'fallback',
  model: string,
  ready: boolean,
  rpmLimit: number,
|};

const ROLE_LABELS = {
  primary: 'Builder',
  specialist: 'Researcher',
  fallback: 'Fallback',
};

const ROLE_COLORS = {
  primary: '#4dabf5',
  specialist: '#69f0ae',
  fallback: '#b0bec5',
};

const MAX_FEED_EVENTS = 40;
const HEALTH_POLL_INTERVAL_MS = 1000;

const formatTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds()
  )}`;
};

const formatCountdown = (ms: number): string => {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

const dotStyle = (color: string, pulsing: boolean): Object => ({
  width: 8,
  height: 8,
  borderRadius: 999,
  flexShrink: 0,
  background: color,
  animation: pulsing ? 'gd-ai-pulse 1.2s infinite' : 'none',
});

type ProviderCardProps = {|
  summary: TeamSummaryEntry,
  health: ?SlotHealth,
  working: boolean,
|};

const ProviderCard = ({ summary, health, working }: ProviderCardProps) => {
  const cooldownMs = health ? health.cooldownRemainingMs : 0;
  const failures = health ? health.consecutiveFailures : 0;
  const requestsLastMinute = health ? health.requestsLastMinute : 0;

  let statusColor = '#4caf50'; // green
  let statusText = 'Ready';
  let pulsing = false;
  if (!health || !health.enabled) {
    statusColor = '#78909c';
    statusText = 'Disabled';
  } else if (!health.hasKey) {
    statusColor = '#78909c';
    statusText = 'No API key';
  } else if (cooldownMs > 0) {
    statusColor = '#ffa726';
    statusText = `Cooling down ${formatCountdown(cooldownMs)}`;
  } else if (working) {
    statusColor = '#fb8c00';
    statusText = 'Working…';
    pulsing = true;
  } else if (failures > 0) {
    statusColor = '#ef5350';
    statusText = `Errors: ${failures}`;
  }

  return (
    <div
      style={{
        flex: '1 1 180px',
        minWidth: 160,
        padding: '6px 8px',
        borderRadius: 6,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={dotStyle(statusColor, pulsing)} />
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'rgba(255,255,255,0.92)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            flex: 1,
          }}
          title={summary.label}
        >
          {summary.label}
        </span>
        <span
          style={{
            fontSize: 10,
            padding: '1px 5px',
            borderRadius: 999,
            flexShrink: 0,
            color: ROLE_COLORS[summary.role],
            background: 'rgba(255,255,255,0.06)',
            border: `1px solid ${ROLE_COLORS[summary.role]}44`,
          }}
        >
          {ROLE_LABELS[summary.role]}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 8,
          marginTop: 4,
          fontSize: 11,
          color: statusColor,
        }}
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={summary.model}
        >
          {summary.model}
        </span>
        <span style={{ flexShrink: 0 }}>{statusText}</span>
      </div>
      {requestsLastMinute > 0 && (
        <div style={{ marginTop: 2, fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>
          <Trans>requests this minute:</Trans> {requestsLastMinute}
        </div>
      )}
    </div>
  );
};

const AiTeamPanel = (): React.Node => {
  const [expanded, setExpanded] = React.useState(() => {
    try {
      return window.localStorage.getItem('gd-ai-team-panel-expanded') !== '0';
    } catch (ignored) {
      return true;
    }
  });
  const [team, setTeam] = React.useState<Array<TeamSummaryEntry>>([]);
  const [healths, setHealths] = React.useState<Array<SlotHealth>>([]);
  const [feed, setFeed] = React.useState<Array<AiStatusEvent>>([]);
  const workingBySlot = React.useRef<{ [string]: number }>({});
  const feedBottomRef = React.useRef<?HTMLDivElement>(null);

  React.useEffect(() => {
    const unsubscribe = subscribeAiStatus(event => {
      if (
        event.kind === 'request-start' ||
        event.kind === 'queued' ||
        event.kind === 'request-retry'
      ) {
        workingBySlot.current[event.slotId || ''] = Date.now();
      }
      setFeed(previousFeed => {
        const nextFeed = previousFeed.concat(event);
        return nextFeed.slice(-MAX_FEED_EVENTS);
      });
    });
    return unsubscribe;
  }, []);

  React.useEffect(() => {
    const refresh = () => {
      try {
        setTeam(getTeamSummary());
        setHealths(getSlotsHealth());
      } catch (ignored) {
        // The orchestrator state is not ready.
      }
    };
    refresh();
    const interval = setInterval(refresh, HEALTH_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  React.useEffect(() => {
    if (feedBottomRef.current && expanded) {
      feedBottomRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [feed, expanded]);

  const toggleExpanded = () => {
    setExpanded(previous => {
      const next = !previous;
      try {
        window.localStorage.setItem(
          'gd-ai-team-panel-expanded',
          next ? '1' : '0'
        );
      } catch (ignored) {
        // Preferences are best-effort.
      }
      return next;
    });
  };

  const isSlotWorking = (slotId: string): boolean => {
    const since = workingBySlot.current[slotId];
    if (!since) return false;
    return Date.now() - since < 15000;
  };

  const readyCount = team.filter(entry => entry.ready).length;
  const healthBySlotId = new Map<string, SlotHealth>();
  healths.forEach(health => healthBySlotId.set(health.slotId, health));

  const lastEvent = feed.length ? feed[feed.length - 1] : null;
  const lastEventIsError = lastEvent && lastEvent.kind === 'team-exhausted';

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
          <Trans>AI Team</Trans>
        </span>
        {team.slice(0, 4).map(entry => {
          const health = healthBySlotId.get(entry.slotId);
          const working = isSlotWorking(entry.slotId);
          let color = '#4caf50';
          if (!health || !health.enabled || !health.hasKey) color = '#78909c';
          else if (health.cooldownRemainingMs > 0) color = '#ffa726';
          else if (working) color = '#fb8c00';
          else if (health.consecutiveFailures > 0) color = '#ef5350';
          return (
            <span
              key={entry.slotId}
              title={`${entry.label} — ${entry.model}`}
              style={{ ...dotStyle(color, working), display: 'inline-block' }}
            />
          );
        })}
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>
          {readyCount} <Trans>ready</Trans>
        </span>
        <span style={{ flex: 1 }} />
        {!expanded && lastEvent && (
          <span
            style={{
              fontSize: 11,
              color: lastEventIsError ? '#ef5350' : 'rgba(255,255,255,0.45)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '50%',
            }}
          >
            {lastEvent.message}
          </span>
        )}
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

      {/* Expanded: provider cards + the team channel. */}
      {expanded && (
        <div style={{ padding: '0 10px 8px' }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {team.map(entry => (
              <ProviderCard
                key={entry.slotId}
                summary={entry}
                health={healthBySlotId.get(entry.slotId) || null}
                working={isSlotWorking(entry.slotId)}
              />
            ))}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 6,
              gap: 8,
            }}
          >
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>
              <Trans>Team channel</Trans> ·{' '}
              <Trans>keys in Preferences → AI Provider</Trans>
            </span>
            <button
              onClick={() => {
                try {
                  resetAiRuntimes();
                  setHealths(getSlotsHealth());
                  setFeed([]);
                } catch (ignored) {
                  // Ignore.
                }
              }}
              style={{
                fontSize: 10,
                padding: '1px 8px',
                borderRadius: 4,
                flexShrink: 0,
                color: 'rgba(255,255,255,0.65)',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.12)',
                cursor: 'pointer',
              }}
            >
              <Trans>Reset</Trans>
            </button>
          </div>
          <div
            style={{
              marginTop: 4,
              maxHeight: 140,
              overflowY: 'auto',
              borderRadius: 6,
              padding: '4px 8px',
              background: 'rgba(0,0,0,0.25)',
              border: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            {feed.length === 0 ? (
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
                <Trans>
                  Messages exchanged by the team will appear here (research
                  started, notes delivered to the builder, retries…).
                </Trans>
              </div>
            ) : (
              feed.map((event, index) => {
                const isError = event.kind === 'team-exhausted';
                const isHandoff =
                  event.kind === 'team-parallel' || event.kind === 'delegation';
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
                      {formatTime(event.timestamp)}
                    </span>
                    {event.label && (
                      <span
                        style={{
                          color: isHandoff
                            ? '#69f0ae'
                            : isError
                            ? '#ef5350'
                            : '#4dabf5',
                          flexShrink: 0,
                          maxWidth: 110,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={event.label}
                      >
                        {event.label}
                      </span>
                    )}
                    <span
                      style={{
                        color: isError
                          ? '#ef9a9a'
                          : 'rgba(255,255,255,0.65)',
                      }}
                    >
                      {event.message}
                    </span>
                  </div>
                );
              })
            )}
            <div ref={feedBottomRef} />
          </div>
        </div>
      )}
    </div>
  );
};

export default AiTeamPanel;
