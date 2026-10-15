// @flow
import { type Limits } from '../Utils/GDevelopServices/Usage';
import {
  type AiConfigurationPreset,
  type AiSettings,
} from '../Utils/GDevelopServices/Generation';

export type AiConfigurationPresetWithAvailability = {|
  ...AiConfigurationPreset,
  disabled: boolean,
  enableWith: 'higher-tier-plan' | null,
|};

export const getAiConfigurationPresetsWithAvailability = ({
  getAiSettings,
  limits,
}: {|
  getAiSettings: () => AiSettings | null,
  limits: ?Limits,
|}): Array<AiConfigurationPresetWithAvailability> => {
  const aiSettings = getAiSettings();
  if (!aiSettings || !aiSettings.aiRequest || !aiSettings.aiRequest.presets) {
    return [
      {
        id: 'universal-chat',
        name: 'Universal AI Assistant',
        description: 'OpenAI-compatible / local offline model',
        mode: 'chat',
        isDefault: true,
        disabled: false,
        enableWith: null,
      },
      {
        id: 'universal-agent',
        name: 'Universal Event Logic Agent',
        description: 'Generates events and logic using configured model',
        mode: 'agent',
        isDefault: true,
        disabled: false,
        enableWith: null,
      },
    ];
  }

  // All presets are 100% unlocked for Horizons Universal AI
  return aiSettings.aiRequest.presets.map(preset => ({
    ...preset,
    disabled: false,
    enableWith: null,
  }));
};

export const getDefaultAiConfigurationPresetId = (
  mode: 'chat' | 'agent' | 'orchestrator',
  aiConfigurationPresetsWithAvailability: Array<AiConfigurationPresetWithAvailability>
): string => {
  const defaultPresetWithAvailability = aiConfigurationPresetsWithAvailability.find(
    preset => preset.isDefault && preset.mode === mode
  );

  return (
    (defaultPresetWithAvailability && defaultPresetWithAvailability.id) ||
    'default'
  );
};
