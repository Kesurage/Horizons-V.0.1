// @flow
import { Trans, t } from '@lingui/macro';
import * as React from 'react';
import { ToolbarGroup } from '../UI/Toolbar';
import AddIcon from '../UI/CustomSvgIcons/Add';
import ChatBubblesIcon from '../UI/CustomSvgIcons/ChatBubbles';
import SettingsIcon from '../UI/CustomSvgIcons/Settings';
import IconButton from '../UI/IconButton';
import RaisedButton from '../UI/RaisedButton';
import { Tooltip } from '@material-ui/core';
import PreferencesContext from '../MainFrame/Preferences/PreferencesContext';
import { AI_PRESETS } from './UniversalAiClient';
import {
  subscribeAiStatus,
  getTeamSummary,
  type AiStatusEvent,
} from './MultiAiOrchestrator';

type Props = {|
  onStartNewChat: () => void,
  canStartNewChat: boolean,
  onOpenHistory: () => void,
  onOpenAiSettings?: () => void,
|};

/**
 * Small chip showing the AI provider/model currently used by the panel.
 * Subscribes to the Multi-AI orchestrator status bus so it reflects
 * queueing, failover and delegation live. Clicking opens AI settings.
 */
const AiStatusChip = ({
  onOpenAiSettings,
}: {|
  onOpenAiSettings: () => void,
|}): React.Node => {
  const preferences = React.useContext(PreferencesContext);
  const { values } = preferences;

  const [lastEvent, setLastEvent] = React.useState<?AiStatusEvent>(null);
  const [teamSummary, setTeamSummary] = React.useState(getTeamSummary);

  React.useEffect(() => {
    const unsubscribe = subscribeAiStatus(event => {
      setLastEvent(event);
      setTeamSummary(getTeamSummary());
    });
    return unsubscribe;
  }, []);

  const baseUrl = values.aiBaseUrl || 'https://api.openai.com/v1';
  const readySlots = teamSummary.filter(slot => slot.ready);
  const readyLabels = readySlots.map(slot => slot.label.split(' (')[0]);
  const providerLabel = readySlots.length
    ? readyLabels.join(' + ')
    : 'No AI key';
  const presetKey = Object.keys(AI_PRESETS).find(
    key => AI_PRESETS[key].baseUrl === baseUrl
  );
  const legacyLabel = presetKey
    ? AI_PRESETS[presetKey].label.replace(/ \(.*\)$/, '')
    : 'Custom';
  const displayLabel = readySlots.length ? providerLabel : legacyLabel;

  const isBusy =
    lastEvent &&
    ['request-start', 'queued', 'delegation', 'web-search'].includes(
      lastEvent.kind
    );
  const dotColor = !readySlots.length
    ? '#e53935'
    : isBusy
    ? '#fb8c00'
    : lastEvent && lastEvent.kind === 'team-exhausted'
    ? '#e53935'
    : '#2e7d32';

  return (
    <Tooltip
      title={
        readySlots.length
          ? t`AI team: ${readyLabels.join(' + ')} — rate limits queued, failover automatic. Click for settings.`
          : t`No AI provider configured. Click to add your free GLM (Z.ai) / Gemini keys.`
      }
    >
      <button
        onClick={onOpenAiSettings}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          border: '1px solid rgba(0,0,0,0.15)',
          borderRadius: 999,
          background: 'rgba(0,0,0,0.03)',
          padding: '2px 10px',
          cursor: 'pointer',
          fontSize: 12,
          maxWidth: 240,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            flexShrink: 0,
            background: dotColor,
            animation: isBusy ? 'gd-ai-pulse 1.2s infinite' : undefined,
          }}
        />
        {displayLabel}
        {lastEvent && isBusy ? ` · ${lastEvent.kind === 'queued' ? 'queued' : lastEvent.label}` : ''}
      </button>
    </Tooltip>
  );
};

export const Toolbar = ({
  onStartNewChat,
  canStartNewChat,
  onOpenHistory,
  onOpenAiSettings,
}: Props): React.Node => {
  return (
    <>
      <ToolbarGroup firstChild>
        <IconButton
          size="small"
          color="default"
          tooltip={t`View history`}
          onClick={onOpenHistory}
        >
          <ChatBubblesIcon />
        </IconButton>
        {onOpenAiSettings && (
          <>
            <AiStatusChip onOpenAiSettings={onOpenAiSettings} />
            <IconButton
              size="small"
              color="default"
              tooltip={t`AI Provider & Model Settings`}
              onClick={onOpenAiSettings}
            >
              <SettingsIcon />
            </IconButton>
          </>
        )}
      </ToolbarGroup>
      <ToolbarGroup lastChild>
        <RaisedButton
          primary
          onClick={onStartNewChat}
          icon={<AddIcon />}
          label={<Trans>New chat</Trans>}
          disabled={!canStartNewChat}
          style={{
            flexShrink: 0,
          }}
        />
      </ToolbarGroup>
    </>
  );
};
