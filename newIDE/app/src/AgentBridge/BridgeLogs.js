// @flow
/**
 * Ring-buffer log shared by the Agent Bridge: every request, write, error
 * and agent note lands here. The panel shows it live and the `/logs`
 * endpoint serves it to the agent — the "what did it do / what is it
 * doing / progress" record of every bridge session.
 */

export type BridgeLogLevel = 'info' | 'request' | 'write' | 'error' | 'agent';

export type BridgeLogEntry = {|
  ts: number,
  level: BridgeLogLevel,
  message: string,
  detail?: string,
|};

const MAX_LOG_ENTRIES = 300;

let entries: Array<BridgeLogEntry> = [];
const listeners = new Set<(entries: Array<BridgeLogEntry>) => void>();

export const pushBridgeLog = (
  level: BridgeLogLevel,
  message: string,
  detail?: string
) => {
  const entry: BridgeLogEntry = {
    ts: Date.now(),
    level,
    message,
    ...(detail ? { detail } : {}),
  };
  entries.push(entry);
  if (entries.length > MAX_LOG_ENTRIES) {
    entries = entries.slice(-MAX_LOG_ENTRIES);
  }
  for (const listener of listeners) {
    try {
      listener(entries);
    } catch (ignored) {
      // A broken listener must not break the bridge.
    }
  }
};

export const getBridgeLogs = (): Array<BridgeLogEntry> => entries;

export const clearBridgeLogs = () => {
  entries = [];
  for (const listener of listeners) {
    try {
      listener(entries);
    } catch (ignored) {
      // Ignore.
    }
  }
};

export const subscribeToBridgeLogs = (
  listener: (entries: Array<BridgeLogEntry>) => void
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const formatBridgeLogTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds()
  )}`;
};
