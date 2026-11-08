// @flow
import { Trans, t } from '@lingui/macro';
import React from 'react';
import Dialog, { DialogPrimaryButton } from '../UI/Dialog';
import FlatButton from '../UI/FlatButton';
import RaisedButton from '../UI/RaisedButton';
import Text from '../UI/Text';
import TextField from '../UI/TextField';
import AlertMessage from '../UI/AlertMessage';
import { ColumnStackLayout, LineStackLayout } from '../UI/Layout';
import { Column, Line } from '../UI/Grid';
import { CompactToggleField } from '../UI/CompactToggleField';
import PreferencesContext from '../MainFrame/Preferences/PreferencesContext';
import {
  AI_PRESETS,
  testAiConnection,
  fetchAvailableModels,
} from './UniversalAiClient';
import MultiAiTeamDialog from './MultiAiTeamDialog';
import {
  countReadySlots,
  getProviderSlots,
  saveProviderSlots,
} from './MultiAiOrchestrator';
import { sanitizeBaseUrl } from './UniversalAiClient';
import CheckCircleIcon from '../UI/CustomSvgIcons/CheckCircle';
import RefreshIcon from '../UI/CustomSvgIcons/Refresh';

type Props = {|
  open: boolean,
  onClose: () => void,
|};

export const AiQuickSettingsDialog = ({ open, onClose }: Props): React.Node => {
  const preferences = React.useContext(PreferencesContext);
  const { values } = preferences;

  const [testing, setTesting] = React.useState(false);
  const [showTeamDialog, setShowTeamDialog] = React.useState(false);
  const [teamReadyCount, setTeamReadyCount] = React.useState(0);
  const [testResult, setTestResult] = React.useState<?{|
    success: boolean,
    message: string,
  |}>(null);
  const [showApiKey, setShowApiKey] = React.useState(false);
  const [fetchingModels, setFetchingModels] = React.useState(false);
  const [availableModels, setAvailableModels] = React.useState<Array<string>>(
    []
  );

  React.useEffect(
    () => {
      if (open) setTeamReadyCount(countReadySlots());
    },
    [open]
  );

  if (!open) return null;

  /**
   * Keep the Multi-AI team slots in sync with the single-provider fields of
   * this dialog: the orchestrator only reads the team slots, so a key typed
   * here must be pushed to the matching slot (or a new custom slot) —
   * otherwise the request would fail with "No AI provider is ready".
   */
  const syncConfigToTeamSlots = (
    rawBaseUrl: string,
    apiKey: string,
    model: string
  ) => {
    try {
      const baseUrl = sanitizeBaseUrl(rawBaseUrl || '');
      if (!baseUrl) return;
      const slots = getProviderSlots();
      const matchingIndex = slots.findIndex(
        slot =>
          sanitizeBaseUrl(slot.baseUrl).toLowerCase() === baseUrl.toLowerCase()
      );
      if (matchingIndex >= 0) {
        const updated = slots.map((slot, index) =>
          index === matchingIndex
            ? {
                ...slot,
                apiKey: apiKey || slot.apiKey,
                model: model || slot.model,
                enabled: apiKey || slot.keyless ? true : slot.enabled,
              }
            : slot
        );
        saveProviderSlots(updated);
      } else if (apiKey) {
        slots.push({
          id: 'custom-quick-' + Date.now().toString(36),
          label: `Custom (${model || 'model'})`,
          baseUrl,
          apiKey,
          model: model || 'gpt-4o',
          rpmLimit: 0,
          enabled: true,
          role: 'fallback',
          capabilities: ['text'],
          keyless: false,
        });
        saveProviderSlots(slots);
      }
      setTeamReadyCount(countReadySlots());
    } catch (ignored) {
      // Never break typing because of a storage issue.
    }
  };

  const handleApplyPreset = (presetKey: string) => {
    const preset = AI_PRESETS[presetKey];
    if (!preset) return;
    preferences.setAiProviderType(presetKey);
    preferences.setAiBaseUrl(preset.baseUrl);
    preferences.setAiModel(preset.model);
    syncConfigToTeamSlots(preset.baseUrl, values.aiApiKey || '', preset.model);
    setTestResult(null);
    setAvailableModels([]);
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testAiConnection({
        baseUrl: values.aiBaseUrl || 'https://api.openai.com/v1',
        apiKey: values.aiApiKey || '',
        model: values.aiModel || 'gpt-4o',
      });
      // A successful test means the key works — make sure the team can use it.
      if (res.success) {
        syncConfigToTeamSlots(
          values.aiBaseUrl || 'https://api.openai.com/v1',
          values.aiApiKey || '',
          values.aiModel || 'gpt-4o'
        );
      }
      setTestResult(res);
    } catch (e) {
      setTestResult({
        success: false,
        message: e.message || 'Connection test failed',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleFetchModels = async () => {
    setFetchingModels(true);
    try {
      const models = await fetchAvailableModels({
        baseUrl: values.aiBaseUrl || 'https://api.openai.com/v1',
        apiKey: values.aiApiKey || '',
      });
      setAvailableModels(models);
      if (models.length > 0) {
        setTestResult({
          success: true,
          message: `Found ${models.length} model(s) on endpoint.`,
        });
      }
    } catch (e) {
      setTestResult({
        success: false,
        message: 'Could not fetch models: ' + e.message,
      });
    } finally {
      setFetchingModels(false);
    }
  };

  return (
    <Dialog
      title={<Trans>AI Provider & Model Settings</Trans>}
      open={open}
      onRequestClose={onClose}
      maxWidth="sm"
      actions={[
        <FlatButton
          key="close"
          label={<Trans>Done</Trans>}
          primary
          onClick={onClose}
        />,
      ]}
    >
      <ColumnStackLayout noMargin>
        <Text size="body-small">
          <Trans>
            Quickly switch your AI model, endpoint, or API key. All calls go
            directly from your browser — and automatically fail over between
            your configured AI team members on rate limits.
          </Trans>
        </Text>

        <RaisedButton
          primary
          label={<Trans>Multi-AI Team (GLM + Gemini + fallbacks)</Trans>}
          onClick={() => setShowTeamDialog(true)}
        />
        {teamReadyCount > 0 && (
          <Text size="body-small" noMargin>
            <Trans>{teamReadyCount} AI provider(s) ready in your team.</Trans>
          </Text>
        )}

        <Text size="sub-title">
          <Trans>Presets</Trans>
        </Text>
        <Line noMargin>
          <LineStackLayout wrap>
            {Object.keys(AI_PRESETS).map(key => {
              const preset = AI_PRESETS[key];
              const isSelected =
                values.aiBaseUrl === preset.baseUrl &&
                values.aiModel === preset.model;
              return (
                <FlatButton
                  key={key}
                  label={preset.label}
                  primary={isSelected}
                  onClick={() => handleApplyPreset(key)}
                />
              );
            })}
          </LineStackLayout>
        </Line>

        <TextField
          floatingLabelText={<Trans>API Base URL</Trans>}
          value={values.aiBaseUrl || ''}
          placeholder="https://api.openai.com/v1"
          onChange={(e, text) => preferences.setAiBaseUrl(text.trim())}
          helperMarkdownText={t`Free text — any OpenAI-compatible base URL. Can always be edited or cleared (empty = OpenAI default).`}
          fullWidth
        />

        <Line alignItems="center" noMargin>
          <Column expand noMargin>
            <TextField
              floatingLabelText={<Trans>API Key</Trans>}
              type={showApiKey ? 'text' : 'password'}
              value={values.aiApiKey || ''}
              onChange={(e, text) => {
                preferences.setAiApiKey(text);
                syncConfigToTeamSlots(
                  values.aiBaseUrl || 'https://api.openai.com/v1',
                  text,
                  values.aiModel || 'gpt-4o'
                );
              }}
              helperMarkdownText={t`Stored locally in your browser (and synced to your AI team).`}
              fullWidth
            />
          </Column>
          <FlatButton
            label={showApiKey ? <Trans>Hide</Trans> : <Trans>Show</Trans>}
            onClick={() => setShowApiKey(!showApiKey)}
          />
        </Line>

        <Line alignItems="center" noMargin>
          <Column expand noMargin>
            <TextField
              floatingLabelText={<Trans>Model Name</Trans>}
              value={values.aiModel || ''}
              placeholder="gpt-4o"
              onChange={(e, text) => preferences.setAiModel(text.trim())}
              helperMarkdownText={t`Free text — any model ID (e.g. gpt-4o, glm-4.6, gemini-2.5-flash). Empty = gpt-4o.`}
              fullWidth
            />
          </Column>
          <FlatButton
            label={
              fetchingModels ? (
                <Trans>Loading...</Trans>
              ) : (
                <Trans>Discover</Trans>
              )
            }
            icon={<RefreshIcon />}
            disabled={fetchingModels}
            onClick={handleFetchModels}
          />
        </Line>

        {availableModels.length > 0 && (
          <Line noMargin>
            <LineStackLayout wrap>
              {availableModels.slice(0, 6).map(m => (
                <FlatButton
                  key={m}
                  label={m}
                  primary={values.aiModel === m}
                  onClick={() => preferences.setAiModel(m)}
                />
              ))}
            </LineStackLayout>
          </Line>
        )}

        <TextField
          floatingLabelText={<Trans>Custom System Prompt (optional)</Trans>}
          multiline
          rows={3}
          value={values.aiCustomSystemPrompt || ''}
          onChange={(e, text) => preferences.setAiCustomSystemPrompt(text)}
          helperMarkdownText={t`Leave empty to use the built-in Horizons AI prompt.`}
          fullWidth
        />

        <CompactToggleField
          labelColor="primary"
          checked={values.aiAutoEdit !== false}
          onCheck={(autoEdit: boolean) => preferences.setAiAutoEdit(autoEdit)}
          label="Autoedit — let the AI modify the project"
          markdownDescription="When ON, the AI agent can build scenes, objects and events. When OFF, it only explains and suggests, without modifying anything."
        />

        <Line justifyContent="flex-start" noMargin>
          <RaisedButton
            primary
            label={
              testing ? (
                <Trans>Testing...</Trans>
              ) : (
                <Trans>Test Connection</Trans>
              )
            }
            icon={<CheckCircleIcon />}
            disabled={testing}
            onClick={handleTestConnection}
          />
        </Line>

        {testResult && (
          <AlertMessage kind={testResult.success ? 'info' : 'error'}>
            {testResult.message}
          </AlertMessage>
        )}
      </ColumnStackLayout>

      <MultiAiTeamDialog
        open={showTeamDialog}
        onClose={() => {
          setShowTeamDialog(false);
          setTeamReadyCount(countReadySlots());
        }}
      />
    </Dialog>
  );
};
export default AiQuickSettingsDialog;
