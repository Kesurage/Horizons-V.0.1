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
import {
  getProviderSlots,
  saveProviderSlots,
  subscribeAiStatus,
  type AiProviderSlot,
  type AiProviderRole,
  type AiStatusEvent,
} from './MultiAiOrchestrator';
import { testAiConnection } from './UniversalAiClient';
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

type SlotCardState = {|
  testing: boolean,
  testResult: ?{| success: boolean, message: string |},
|};

const SlotCard = ({
  slot,
  onChange,
}: {|
  slot: AiProviderSlot,
  onChange: (updates: $Shape<AiProviderSlot>) => void,
|}): React.Node => {
  const [state, setState] = React.useState<SlotCardState>({
    testing: false,
    testResult: null,
  });
  const [showKey, setShowKey] = React.useState<boolean>(false);
  const [expanded, setExpanded] = React.useState<boolean>(false);

  const ready = slot.enabled && (slot.keyless || slot.apiKey.trim().length > 0);

  const handleTest = async () => {
    setState({ testing: true, testResult: null });
    try {
      const result = await testAiConnection({
        baseUrl: slot.baseUrl,
        apiKey: slot.apiKey,
        model: slot.model,
      });
      setState({ testing: false, testResult: result });
    } catch (error) {
      setState({
        testing: false,
        testResult: {
          success: false,
          message: (error && error.message) || 'Test failed',
        },
      });
    }
  };

  return (
    <LineStackLayout
      noMargin
      alignItems="center"
    >
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
          {ROLE_LABELS[slot.role]} · {slot.model}
          {slot.rpmLimit > 0 ? ` · ${slot.rpmLimit} req/min max` : ''}
        </Text>
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
            floatingLabelText={<Trans>Base URL</Trans>}
            value={slot.baseUrl}
            fullWidth
            onChange={(e, text) => onChange({ baseUrl: text.trim() })}
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
                fullWidth
                onChange={(e, text) => onChange({ model: text.trim() })}
              />
            </Column>
            <Column noMargin>
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
  const [lastEvent, setLastEvent] = React.useState<?AiStatusEvent>(null);

  React.useEffect(() => {
    if (open) {
      setSlots(getProviderSlots());
    }
  }, [open]);

  React.useEffect(() => {
    const unsubscribe = subscribeAiStatus(event => setLastEvent(event));
    return unsubscribe;
  }, []);

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

  const readyCount = slots.filter(
    slot => slot.enabled && (slot.keyless || slot.apiKey.trim().length > 0)
  ).length;

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
              free tiers).
            </Trans>
          </AlertMessage>
        ) : (
          <AlertMessage kind="info">
            <Trans>
              {readyCount} provider(s) ready. Requests automatically fail over
              to the next provider on rate limits (HTTP 429) or outages.
            </Trans>
          </AlertMessage>
        )}

        {lastEvent && (
          <AlertMessage kind={lastEvent.kind === 'team-exhausted' ? 'error' : 'info'}>
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
              onChange={updates => handleSlotChange(slot.id, updates)}
            />
          </div>
        ))}

        <Text size="body-small">
          <Trans>
            Tip: keys stay on this device (local storage). The AI can use the
            specialist via ask_specialist and web_search tools when you enable
            Gemini.
          </Trans>
        </Text>
      </ColumnStackLayout>
    </Dialog>
  );
};

export default MultiAiTeamDialog;
