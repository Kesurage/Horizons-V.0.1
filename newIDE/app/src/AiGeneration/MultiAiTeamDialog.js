// @flow
import { Trans, t } from '@lingui/macro';
import * as React from 'react';
import Dialog, { DialogPrimaryButton } from '../UI/Dialog';
import FlatButton from '../UI/FlatButton';
import RaisedButton from '../UI/RaisedButton';
import Text from '../UI/Text';
import TextField from '../UI/TextField';
import AlertMessage from '../UI/AlertMessage';
import { ColumnStackLayout, LineStackLayout } from '../UI/Layout';
import { Column, Line, Spacer } from '../UI/Grid';
import { CompactToggleField } from '../UI/CompactToggleField';
import SelectField from '../UI/SelectField';
import SelectOption from '../UI/SelectOption';
import RefreshIcon from '../UI/CustomSvgIcons/Refresh';
import DeleteIcon from '../UI/CustomSvgIcons/Trash';
import {
  getProviderSlots,
  saveProviderSlots,
  subscribeAiStatus,
  getSlotsHealth,
  resetAiRuntimes,
  addCustomProviderSlot,
  removeProviderSlot,
  canRemoveSlot,
  type AiProviderSlot,
  type AiProviderRole,
  type AiStatusEvent,
  type SlotHealth,
} from './MultiAiOrchestrator';
import { testAiConnection, fetchAvailableModels } from './UniversalAiClient';
import { type Limits } from '../Utils/GDevelopServices/Usage';

const FREE_TIER_HINTS: { [string]: string } = {
  'glm-primary':
    'Free tier: ~40 req/min on Z.ai. Great for agentic, heavy and long-context tasks.',
  'gemini-specialist':
    'Free tier: ~15 req/min, higher daily limits, 1M context. Vision, image/video analysis & live web search.',
  'groq-fallback':
    'Free tier: ~30 req/min. Ultra-fast fallback for simple turns.',
};

const ROLE_LABELS: { [AiProviderRole]: string } = {
  primary: 'Primary (does most work)',
  specialist: 'Specialist (helps & analyzes)',
  fallback: 'Fallback (when others are limited)',
};

/** Quick-add presets for custom providers. */
const ADD_PRESETS: Array<{| label: string, baseUrl: string, model: string |}> = [
  { label: 'Z.ai (GLM)', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-4.7-flash' },
  {
    label: 'Gemini (Google AI)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-flash-latest',
  },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', model: '' },
  { label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', model: '' },
  { label: 'Other (OpenAI-compatible)', baseUrl: '', model: '' },
];

type SlotCardState = {|
  testing: boolean,
  testResult: ?{| success: boolean, message: string |},
  fetchingModels: boolean,
  models: Array<string>,
  modelsError: ?string,
|};

const SlotCard = ({
  slot,
  health,
  onChange,
  onRemove,
}: {|
  slot: AiProviderSlot,
  health: ?SlotHealth,
  onChange: (updates: $Shape<AiProviderSlot>) => void,
  onRemove?: () => void,
|}): React.Node => {
  const [state, setState] = React.useState<SlotCardState>({
    testing: false,
    testResult: null,
    fetchingModels: false,
    models: [],
    modelsError: null,
  });
  const [showKey, setShowKey] = React.useState<boolean>(false);
  const [expanded, setExpanded] = React.useState<boolean>(false);

  const ready = slot.enabled && (slot.keyless || slot.apiKey.trim().length > 0);

  const handleTest = async () => {
    setState(prev => ({ ...prev, testing: true, testResult: null }));
    try {
      const result = await testAiConnection({
        baseUrl: slot.baseUrl,
        apiKey: slot.apiKey,
        model: slot.model,
      });
      setState(prev => ({ ...prev, testing: false, testResult: result }));
    } catch (error) {
      setState(prev => ({
        ...prev,
        testing: false,
        testResult: {
          success: false,
          message: (error && error.message) || 'Test failed',
        },
      }));
    }
  };

  const handleFetchModels = async () => {
    setState(prev => ({
      ...prev,
      fetchingModels: true,
      modelsError: null,
    }));
    try {
      const models = await fetchAvailableModels({
        baseUrl: slot.baseUrl,
        apiKey: slot.apiKey,
      });
      setState(prev => ({
        ...prev,
        fetchingModels: false,
        models,
        modelsError: null,
      }));
    } catch (error) {
      setState(prev => ({
        ...prev,
        fetchingModels: false,
        models: [],
        modelsError:
          (error && error.message) || 'Could not fetch the model list.',
      }));
    }
  };

  const healthSummary = health
    ? [
        health.cooldownRemainingMs > 0
          ? `cooling down ${Math.ceil(health.cooldownRemainingMs / 1000)}s`
          : null,
        health.requestsLastMinute > 0
          ? `${health.requestsLastMinute} req in the last minute`
          : null,
        health.consecutiveFailures > 0
          ? `${health.consecutiveFailures} failure(s) in a row`
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <LineStackLayout noMargin alignItems="center">
      <Column expand noMargin>
        <Line alignItems="center" noMargin>
          <span
            title={ready ? 'Ready' : 'Not configured'}
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              marginRight: 8,
              flexShrink: 0,
              background: ready
                ? '#43a047'
                : slot.enabled
                ? '#fdd835'
                : '#9e9e9e',
            }}
          />
          <Text displayInlineAsSpan size="sub-title" noMargin>
            {slot.label}
          </Text>
        </Line>
        <Text size="body-small">
          {ROLE_LABELS[slot.role]} · {slot.model || '(no model set)'}
          {slot.rpmLimit > 0 ? ` · ${slot.rpmLimit} req/min max` : ''}
        </Text>
        {healthSummary && (
          <Text size="body-small" noMargin>
            {healthSummary}
          </Text>
        )}
        {FREE_TIER_HINTS[slot.id] && (
          <Text size="body-small" noMargin>
            {FREE_TIER_HINTS[slot.id]}
          </Text>
        )}
      </Column>
      <Column noMargin>
        <CompactToggleField
          checked={slot.enabled}
          onCheck={(checked: boolean) => onChange({ enabled: checked })}
          label="Enabled"
        />
      </Column>
      <Column noMargin>
        <FlatButton
          label={expanded ? 'Less' : 'Configure'}
          onClick={() => setExpanded(!expanded)}
        />
      </Column>
      {expanded && (
        <Column expand noMargin>
          <Spacer />
          <TextField
            floatingLabelText={<Trans>Display name</Trans>}
            value={slot.label}
            fullWidth
            onChange={(e, text) => onChange({ label: text })}
          />
          <TextField
            floatingLabelText={<Trans>Base URL</Trans>}
            value={slot.baseUrl}
            placeholder="https://api.example.com/v1"
            fullWidth
            onChange={(e, text) => onChange({ baseUrl: text.trim() })}
            helperMarkdownText={t`Any OpenAI-compatible endpoint. An origin without a path gets /v1 appended automatically; a pasted /chat/completions suffix is stripped.`}
          />
          {!slot.keyless && (
            <Line alignItems="center" noMargin>
              <Column expand noMargin>
                <TextField
                  floatingLabelText={<Trans>API Key</Trans>}
                  type={showKey ? 'text' : 'password'}
                  value={slot.apiKey}
                  fullWidth
                  onChange={(e, text) => onChange({ apiKey: text })}
                  helperMarkdownText={t`Stored locally, never sent anywhere except this provider.`}
                />
              </Column>
              <FlatButton
                label={showKey ? <Trans>Hide</Trans> : <Trans>Show</Trans>}
                onClick={() => setShowKey(!showKey)}
              />
            </Line>
          )}
          <Line alignItems="center" noMargin>
            <Column expand noMargin>
              <TextField
                floatingLabelText={<Trans>Model</Trans>}
                value={slot.model}
                placeholder="gpt-4o"
                fullWidth
                onChange={(e, text) => onChange({ model: text.trim() })}
              />
            </Column>
            <FlatButton
              label={
                state.fetchingModels ? (
                  <Trans>Loading...</Trans>
                ) : (
                  <Trans>Discover models</Trans>
                )
              }
              icon={<RefreshIcon />}
              disabled={state.fetchingModels || !slot.baseUrl}
              onClick={handleFetchModels}
            />
          </Line>
          {state.modelsError && (
            <AlertMessage kind="warning">
              {state.modelsError}
            </AlertMessage>
          )}
          {state.models.length > 0 && (
            <LineStackLayout wrap noMargin>
              {state.models.slice(0, 12).map(modelId => (
                <FlatButton
                  key={modelId}
                  label={modelId}
                  primary={slot.model === modelId}
                  onClick={() => onChange({ model: modelId })}
                />
              ))}
            </LineStackLayout>
          )}
          <Line alignItems="center" noMargin>
            <Column expand noMargin>
              <TextField
                floatingLabelText={<Trans>Requests / minute</Trans>}
                type="number"
                value={String(slot.rpmLimit || 0)}
                fullWidth
                onChange={(e, text) => {
                  const value = parseInt(text, 10);
                  onChange({ rpmLimit: isNaN(value) ? 0 : value });
                }}
                helperMarkdownText={t`0 = no limit. Requests queue automatically when the free-tier rate window is full.`}
              />
            </Column>
            <Column noMargin>
              <FlatButton
                label={<Trans>Refresh rate window</Trans>}
                icon={<RefreshIcon />}
                onClick={() => resetAiRuntimes(slot.id)}
              />
            </Column>
          </Line>
          <Line alignItems="center" noMargin>
            <Column expand noMargin>
              <SelectField
                fullWidth
                floatingLabelText={<Trans>Role in the team</Trans>}
                value={slot.role}
                onChange={(e, i, value: string) =>
                  onChange({ role: (value: any) })
                }
              >
                <SelectOption value="primary" primaryText="Primary" />
                <SelectOption value="specialist" primaryText="Specialist" />
                <SelectOption value="fallback" primaryText="Fallback" />
              </SelectField>
            </Column>
            <FlatButton
              label={
                state.testing ? (
                  <Trans>Testing...</Trans>
                ) : (
                  <Trans>Test</Trans>
                )
              }
              disabled={state.testing}
              onClick={handleTest}
            />
            {onRemove && (
              <FlatButton
                icon={<DeleteIcon />}
                label={<Trans>Remove</Trans>}
                onClick={onRemove}
              />
            )}
          </Line>
          {state.testResult && (
            <AlertMessage kind={state.testResult.success ? 'info' : 'error'}>
              {state.testResult.message}
            </AlertMessage>
          )}
        </Column>
      )}
    </LineStackLayout>
  );
};

type Props = {|
  open: boolean,
  onClose: () => void,
|};

/**
 * Full team editor for the Horizons Multi-AI system:
 * GLM (primary) + Gemini (specialist) + any fallbacks,
 * each with its own key, model and rate-limit handling.
 */
export const MultiAiTeamDialog = ({ open, onClose }: Props): React.Node => {
  const [slots, setSlots] = React.useState<Array<AiProviderSlot>>([]);
  const [health, setHealth] = React.useState<Array<SlotHealth>>([]);
  const [lastEvent, setLastEvent] = React.useState<?AiStatusEvent>(null);
  const [showAddPresets, setShowAddPresets] = React.useState<boolean>(false);

  React.useEffect(() => {
    if (open) {
      setSlots(getProviderSlots());
      setHealth(getSlotsHealth());
    }
  }, [open]);

  React.useEffect(() => {
    const unsubscribe = subscribeAiStatus(event => setLastEvent(event));
    return unsubscribe;
  }, []);

  // Keep the live health lines fresh while the dialog is open.
  React.useEffect(() => {
    if (!open) return;
    const interval = setInterval(() => setHealth(getSlotsHealth()), 3000);
    return () => clearInterval(interval);
  }, [open]);

  const handleSlotChange = (slotId: string, updates: $Shape<AiProviderSlot>) => {
    setSlots(prevSlots =>
      prevSlots.map(slot =>
        slot.id === slotId ? { ...slot, ...updates } : slot
      )
    );
  };

  const handleSave = () => {
    saveProviderSlots(slots);
    onClose();
  };

  const handleAddProvider = (preset: {| label: string, baseUrl: string, model: string |}) => {
    const newSlots = addCustomProviderSlot({
      label: preset.label,
      baseUrl: preset.baseUrl,
      model: preset.model,
      role: 'fallback',
    });
    setSlots(newSlots);
    setShowAddPresets(false);
  };

  const handleRemoveSlot = (slotId: string) => {
    setSlots(removeProviderSlot(slotId));
  };

  const handleRefreshStatus = () => {
    setSlots(getProviderSlots());
    setHealth(getSlotsHealth());
  };

  const readyCount = slots.filter(
    slot => slot.enabled && (slot.keyless || slot.apiKey.trim().length > 0)
  ).length;

  const healthBySlotId: { [string]: SlotHealth } = {};
  health.forEach(entry => {
    healthBySlotId[entry.slotId] = entry;
  });

  return (
    <Dialog
      title={<Trans>Multi-AI Team</Trans>}
      open={open}
      onRequestClose={onClose}
      maxWidth="md"
      actions={[
        <FlatButton
          key="cancel"
          label={<Trans>Cancel</Trans>}
          onClick={onClose}
        />,
        <DialogPrimaryButton
          key="save"
          label={<Trans>Save team</Trans>}
          primary
          onClick={handleSave}
        />,
      ]}
      secondaryActions={[
        <FlatButton
          key="refresh"
          label={<Trans>Refresh status</Trans>}
          icon={<RefreshIcon />}
          onClick={handleRefreshStatus}
        />,
        <FlatButton
          key="reset-windows"
          label={<Trans>Reset rate windows</Trans>}
          onClick={() => {
            resetAiRuntimes();
            setHealth(getSlotsHealth());
          }}
        />,
        <FlatButton
          key="defaults"
          label={<Trans>Reset to defaults</Trans>}
          onClick={() => {
            try {
              localStorage.removeItem('gd-multi-ai-slots-v1');
            } catch (ignored) {}
            setSlots(getProviderSlots());
          }}
        />,
      ]}
    >
      <ColumnStackLayout noMargin>
        <Text size="body">
          <Trans>
            Your AI team works together: the <b>primary</b> agent (GLM 4.7
            Flash) handles heavy agentic work; the <b>specialist</b> (Gemini)
            analyzes media, searches the web and takes over when the primary
            hits its free-tier rate limit. <b>Fallbacks</b> add even more
            capacity. All requests are queued and rate-limited automatically.
          </Trans>
        </Text>

        {readyCount === 0 ? (
          <AlertMessage kind="warning">
            <Trans>
              No provider is ready yet. Add an API key to at least one provider
              below (GLM from z.ai, Gemini from Google AI Studio — both have
              free tiers), then press <b>Test</b> to check it.
            </Trans>
          </AlertMessage>
        ) : (
          <AlertMessage kind="info">
            <Trans>
              {readyCount} provider(s) ready. Requests automatically retry and
              fail over to the next provider on rate limits (HTTP 429) or
              outages.
            </Trans>
          </AlertMessage>
        )}

        {lastEvent && (
          <AlertMessage
            kind={
              lastEvent.kind === 'team-exhausted'
                ? 'error'
                : lastEvent.kind === 'request-retry' ||
                  lastEvent.kind === 'provider-cooldown'
                ? 'warning'
                : 'info'
            }
          >
            <b>{lastEvent.label}</b>: {lastEvent.message}
          </AlertMessage>
        )}

        {slots.map(slot => (
          <div
            key={slot.id}
            style={{
              border: '1px solid rgba(0,0,0,0.12)',
              borderRadius: 8,
              padding: 12,
            }}
          >
            <SlotCard
              slot={slot}
              health={healthBySlotId[slot.id]}
              onChange={updates => handleSlotChange(slot.id, updates)}
              onRemove={
                canRemoveSlot(slot.id)
                  ? () => handleRemoveSlot(slot.id)
                  : null
              }
            />
          </div>
        ))}

        {showAddPresets ? (
          <ColumnStackLayout noMargin>
            <Text size="sub-title">
              <Trans>Pick a provider to add</Trans>
            </Text>
            <LineStackLayout wrap noMargin>
              {ADD_PRESETS.map(preset => (
                <FlatButton
                  key={preset.label}
                  label={preset.label}
                  onClick={() => handleAddProvider(preset)}
                />
              ))}
            </LineStackLayout>
          </ColumnStackLayout>
        ) : (
          <RaisedButton
            label={<Trans>Add a provider</Trans>}
            icon={<RefreshIcon />}
            onClick={() => setShowAddPresets(true)}
          />
        )}

        <Text size="body-small">
          <Trans>
            Tip: keys stay on this device (local storage). Use <b>Discover
            models</b> to list the models an endpoint offers, and <b>Test</b>{" "}
            to verify a provider before saving. The AI can use the specialist
            via ask_specialist and web_search tools when you enable Gemini.
          </Trans>
        </Text>
      </ColumnStackLayout>
    </Dialog>
  );
};

export default MultiAiTeamDialog;
