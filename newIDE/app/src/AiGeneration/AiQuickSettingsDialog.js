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
  const [testResult, setTestResult] = React.useState<?{|
    success: boolean,
    message: string,
  |}>(null);
  const [showApiKey, setShowApiKey] = React.useState(false);
  const [fetchingModels, setFetchingModels] = React.useState(false);
  const [availableModels, setAvailableModels] = React.useState<Array<string>>([]);

  if (!open) return null;

  const handleApplyPreset = (presetKey: string) => {
    const preset = AI_PRESETS[presetKey];
    if (!preset) return;
    preferences.setAiProviderType(presetKey);
    preferences.setAiBaseUrl(preset.baseUrl);
    preferences.setAiModel(preset.model);
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
            Quickly switch your AI model, endpoint, or API key. All calls go directly from your browser.
          </Trans>
        </Text>

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
          value={values.aiBaseUrl || 'https://api.openai.com/v1'}
          onChange={(e, text) => preferences.setAiBaseUrl(text)}
          fullWidth
        />

        <Line alignItems="center" noMargin>
          <Column expand noMargin>
            <TextField
              floatingLabelText={<Trans>API Key</Trans>}
              type={showApiKey ? 'text' : 'password'}
              value={values.aiApiKey || ''}
              onChange={(e, text) => preferences.setAiApiKey(text)}
              helperMarkdownText={t`Stored locally in your browser.`}
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
              value={values.aiModel || 'gpt-4o'}
              onChange={(e, text) => preferences.setAiModel(text)}
              fullWidth
            />
          </Column>
          <FlatButton
            label={fetchingModels ? <Trans>Loading...</Trans> : <Trans>Discover</Trans>}
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
          hideTooltip
          checked={values.aiAutoEdit !== false}
          onCheck={(autoEdit: boolean) => preferences.setAiAutoEdit(autoEdit)}
          label={t`Autoedit — let the AI modify the project`}
          markdownDescription={t`When ON, the AI agent can build scenes, objects and events. When OFF, it only explains and suggests, without modifying anything.`}
        />

        <Line justifyContent="flex-start" noMargin>
          <RaisedButton
            primary
            label={testing ? <Trans>Testing...</Trans> : <Trans>Test Connection</Trans>}
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
    </Dialog>
  );
};
export default AiQuickSettingsDialog;
