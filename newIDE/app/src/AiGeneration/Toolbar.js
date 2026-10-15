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

type Props = {|
  onStartNewChat: () => void,
  canStartNewChat: boolean,
  onOpenHistory: () => void,
  onOpenAiSettings?: () => void,
|};

/**
 * Small chip showing the AI provider/model currently used by the panel.
 * Clicking it opens the AI settings dialog. Turns amber when unconfigured.
 */
const AiStatusChip = ({
  onOpenAiSettings,
}: {|
  onOpenAiSettings: () => void,
|}): React.Node => {
  const preferences = React.useContext(PreferencesContext);
  const { values } = preferences;

  const baseUrl = values.aiBaseUrl || 'https://api.openai.com/v1';
  const model = values.aiModel || 'gpt-4o';
  const presetKey = Object.keys(AI_PRESETS).find(
    key => AI_PRESETS[key].baseUrl === baseUrl
  );
  const providerLabel = presetKey
    ? AI_PRESETS[presetKey].label.replace(/ \(.*\)$/, '')
    : 'Custom';
  const isLocal =
    baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1');

  return (
    <Tooltip
      title={t`Provider: ${providerLabel} — Model: ${model} (${baseUrl}). Click to change AI settings.`}
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
          maxWidth: 220,
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
            background: isLocal ? '#2e7d32' : '#1565c0',
          }}
        />
        {providerLabel} · {model}
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
