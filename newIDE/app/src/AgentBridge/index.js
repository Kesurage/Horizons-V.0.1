// @flow
/**
 * The Agent Bridge: the app becomes a token-protected server that an
 * external AI agent can drive — no AI API keys needed in the app.
 *
 * - AgentBridgePanel: the Start button / token / live log (top of the AI panel).
 * - AgentBridgeServer: lifecycle of the native server + request routing.
 * - BridgeApi: the REST API implementation (reads/writes the project).
 * - AgentBridgeContextSync: keeps the API connected to the opened project.
 */
export { default as AgentBridgePanel } from './AgentBridgePanel';
export { default as AgentBridgeContextSync } from './AgentBridgeContextSync';
export {
  startBridge,
  stopBridge,
  subscribeToBridgeStatus,
  refreshBridgeStatus,
} from './AgentBridgeServer';
export { setAgentBridgeContext } from './AgentBridgeServer';
export { isBridgeAvailable } from './BridgeNative';
