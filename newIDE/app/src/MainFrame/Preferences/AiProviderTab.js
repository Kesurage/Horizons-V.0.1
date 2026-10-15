// @flow
import { Trans, t } from '@lingui/macro';
import React from 'react';
import Text from '../../UI/Text';
import TextField from '../../UI/TextField';
import FlatButton from '../../UI/FlatButton';
import RaisedButton from '../../UI/RaisedButton';
import AlertMessage from '../../UI/AlertMessage';
import { ColumnStackLayout, LineStackLayout } from '../../UI/Layout';
import { Column, Line } from '../../UI/Grid';
import PreferencesContext from './PreferencesContext';
import {
  AI_PRESETS,
  testAiConnection,
  fetchAvailableModels,
  sanitizeBaseUrl,
} from '../../AiGeneration/UniversalAiClient';
import TuneIcon from '../../UI/CustomSvgIcons/Tune';
import CheckCircleIcon from '../../UI/CustomSvgIcons/CheckCircle';
import RefreshIcon from '../../UI/CustomSvgIcons/Refresh';

export const AiProviderTab = (): React.Node => {
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
          message: `Found ${models.length} model(s) available on this endpoint.`,
        });
      } else {
        setTestResult({
          success: false,
          message: 'Endpoint did not return a /models list. You can still type the model name manually.',
        });
      }
    } catch (e) {
      setTestResult({
        success: false,
        message: 'Could not fetch models from /models: ' + e.message,
      });
    } finally {
      setFetchingModels(false);
    }
  };

  return (
    <ColumnStackLayout noMargin>
      <Text size="block-title">
        <Trans>Universal AI & Offline Model Provider</Trans>
      </Text>
      <Text size="body">
        <Trans>
          Connect any OpenAI-compatible AI provider or local offline model (Ollama, LM Studio, OpenAI, OpenRouter, Groq, DeepSeek).
          GDevelop proprietary cloud subscriptions are completely bypassed.
        </Trans>
      </Text>

      <Text size="sub-title">
        <Trans>Quick Presets</Trans>
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

      <Text size="sub-title">
        <Trans>Endpoint Configuration</Trans>
      </Text>

      <TextField
        floatingLabelText={<Trans>API Base URL</Trans>}
        value={values.aiBaseUrl || 'https://api.openai.com/v1'}
        onChange={(e, text) => preferences.setAiBaseUrl(text)}
        helperMarkdownText={t`e.g., \`https://api.openai.com/v1\`, \`http://localhost:11434/v1\` (Ollama), or \`https://openrouter.ai/api/v1\``}
        fullWidth
      />

      <Line alignItems="center" noMargin>
        <Column expand noMargin>
          <TextField
            floatingLabelText={<Trans>API Key</Trans>}
            type={showApiKey ? 'text' : 'password'}
            value={values.aiApiKey || ''}
            onChange={(e, text) => preferences.setAiApiKey(text)}
            helperMarkdownText={t`Stored locally in your browser. Not required for local Ollama/LM Studio.`}
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
            floatingLabelText={<Trans>Model Name / ID</Trans>}
            value={values.aiModel || 'gpt-4o'}
            onChange={(e, text) => preferences.setAiModel(text)}
            helperMarkdownText={t`e.g. \`gpt-4o\`, \`llama3.2:latest\`, \`deepseek-chat\`, \`anthropic/claude-3.5-sonnet\``}
            fullWidth
          />
        </Column>
        <FlatButton
          label={fetchingModels ? <Trans>Loading...</Trans> : <Trans>Discover Models</Trans>}
          icon={<RefreshIcon />}
          disabled={fetchingModels}
          onClick={handleFetchModels}
        />
      </Line>

      {availableModels.length > 0 && (
        <Line noMargin>
          <LineStackLayout wrap>
            <Text size="body-small">
              <Trans>Available on endpoint:</Trans>
            </Text>
            {availableModels.slice(0, 8).map(m => (
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
        floatingLabelText={<Trans>Temperature (0.0 = Precise, 1.0 = Creative)</Trans>}
        type="number"
        value={values.aiTemperature !== undefined ? String(values.aiTemperature) : '0.7'}
        onChange={(e, text) => {
          const val = parseFloat(text);
          if (!isNaN(val)) preferences.setAiTemperature(val);
        }}
        fullWidth
      />

      <TextField
        floatingLabelText={<Trans>Custom System Prompt (optional)</Trans>}
        multiline
        rows={4}
        value={values.aiCustomSystemPrompt || ''}
        onChange={(e, text) => preferences.setAiCustomSystemPrompt(text)}
        helperMarkdownText={t`Overrides the default Horizons AI personality. Leave empty to use the built-in prompt (recommended: it includes your project context and GDevelop instructions).`}
        fullWidth
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

      <AlertMessage kind="info">
        <Trans>
          Offline tip: When using Ollama on your local machine, run `ollama serve` and set OLLAMA_ORIGINS="*" so the browser can make direct requests to `http://localhost:11434/v1`.
        </Trans>
      </AlertMessage>
    </ColumnStackLayout>
  );
};
export default AiProviderTab;
