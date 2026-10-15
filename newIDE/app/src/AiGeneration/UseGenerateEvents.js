// @flow
import * as React from 'react';
import { makeSimplifiedProjectBuilder } from '../EditorFunctions/SimplifiedProject/SimplifiedProject';
import {
  executeUniversalAiChat,
} from './UniversalAiClient';
import {
  buildProjectDigest,
  getUniversalAiSystemPrompt,
  EVENTS_JSON_GUIDE,
  EVENTS_OPERATIONS_GUIDE,
} from './UniversalAiAgent';
import {
  type EventsGenerationResult,
} from '../EditorFunctions';
import type { AiGeneratedEvent } from '../Utils/GDevelopServices/Generation';

const gd: libGDevelop = global.gd;

/**
 * Extract the first JSON object found in a string (models sometimes wrap
 * JSON in markdown fences or add prose around it).
 */
const extractJson = (text: string): ?Object => {
  if (!text) return null;
  const cleaned = text
    .replace(/```json/gi, '```')
    .split('```')
    .map(part => part.trim())
    .filter(Boolean);
  const candidates = [text, ...cleaned];
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch (e) {
        // Try next candidate.
      }
    }
  }
  return null;
};

/**
 * Offline events generation: compiles a natural-language description of game
 * logic into GDevelop events JSON using the user's custom AI provider
 * (no GDevelop cloud involved).
 */
export const useGenerateEvents = ({
  project,
}: {|
  project: ?gdProject,
|}): {| generateEvents: any |} => {
  const generateEvents = React.useCallback(
    async ({
      sceneName,
      eventsDescription,
      extensionNamesList,
      objectsList,
      existingEventsAsText,
      placementHint,
      estimatedComplexity,
    }: {|
      sceneName: string,
      eventsDescription: string,
      extensionNamesList: string,
      objectsList: string,
      existingEventsAsText: string,
      existingEventsJson: string | null,
      placementHint: string,
      relatedAiRequestId: string,
      estimatedComplexity: number | null,
    |}): Promise<EventsGenerationResult> => {
      if (!project) throw new Error('No project is opened.');

      const simplifiedProjectBuilder = makeSimplifiedProjectBuilder(gd);
      const simplifiedProjectJson = JSON.stringify(
        simplifiedProjectBuilder.getSimplifiedProject(project, {})
      );
      const projectSpecificExtensionsSummaryJson = JSON.stringify(
        simplifiedProjectBuilder.getProjectSpecificExtensionsSummary(project)
      );

      try {
        const projectDigest = buildProjectDigest(
          simplifiedProjectJson,
          projectSpecificExtensionsSummaryJson
        );

        const compilerPrompt = [
          'Compile the following game logic request into GDevelop serialized events JSON operations.',
          '',
          `Target scene: "${sceneName}"`,
          `Objects concerned: ${objectsList || '(all scene objects)'}`,
          `Extensions available: ${extensionNamesList || '(builtin instructions)'}`,
          placementHint ? `Placement hint: ${placementHint}` : '',
          '',
          '# REQUESTED LOGIC',
          eventsDescription,
          '',
          existingEventsAsText
            ? '# EXISTING EVENTS IN THE SCENE (as readable text)\n' +
              existingEventsAsText.slice(0, 8000)
            : '# The scene has no events yet (or none relevant). Use "insert_at_end".',
          '',
          EVENTS_JSON_GUIDE,
          EVENTS_OPERATIONS_GUIDE,
        ]
          .filter(Boolean)
          .join('\n');

        // Chat-style call on purpose: the strict JSON contract is enforced by
        // the prompt itself, not by tool calling.
        const config = {
          baseUrl: (() => {
            try {
              const raw = localStorage.getItem('gd-preferences');
              if (raw) {
                const parsed = JSON.parse(raw);
                return (
                  (parsed.values && parsed.values.aiBaseUrl) ||
                  'https://api.openai.com/v1'
                );
              }
            } catch (e) {}
            return 'https://api.openai.com/v1';
          })(),
          apiKey: (() => {
            try {
              const raw = localStorage.getItem('gd-preferences');
              if (raw) {
                const parsed = JSON.parse(raw);
                return (parsed.values && parsed.values.aiApiKey) || '';
              }
            } catch (e) {}
            return '';
          })(),
          model: (() => {
            try {
              const raw = localStorage.getItem('gd-preferences');
              if (raw) {
                const parsed = JSON.parse(raw);
                return (parsed.values && parsed.values.aiModel) || 'gpt-4o';
              }
            } catch (e) {}
            return 'gpt-4o';
          })(),
          temperature: 0.2,
          customSystemPrompt: getUniversalAiSystemPrompt({
            mode: 'chat',
            projectDigest,
          }),
        };

        const { assistantText } = await executeUniversalAiChat({
          userPrompt: compilerPrompt,
          conversationHistory: [],
          config,
        });

        const parsedResult = extractJson(assistantText);
        if (
          !parsedResult ||
          !Array.isArray(parsedResult.changes) ||
          parsedResult.changes.length === 0
        ) {
          return {
            generationCompleted: true,
            aiGeneratedEvent: ({
              id: 'aige_univ_' + Date.now(),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              status: 'ready',
              error: null,
              resultMessage:
                'The model did not return valid events JSON. ' +
                'Ask it to be more precise, or try a different model: some models follow the events JSON format better than others.',
              changes: [],
            }: any),
          };
        }

        const aiGeneratedEvent: AiGeneratedEvent = ({
          id: 'aige_univ_' + Date.now(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: 'ready',
          error: null,
          resultMessage: parsedResult.resultMessage || null,
          changes: parsedResult.changes.map(change => ({
            operationName: change.operationName || 'insert_at_end',
            operationTargetEvent: change.operationTargetEvent || null,
            isEventsJsonValid: change.generatedEvents
              ? typeof change.generatedEvents === 'string'
              : null,
            generatedEvents: change.generatedEvents || null,
            areEventsValid: null,
            extensionNames: change.extensionNames || null,
            diagnosticLines: [],
            undeclaredVariables: [],
            undeclaredObjectVariables: {},
            missingObjectBehaviors: {},
            missingResources: [],
          })),
        }: any);

        return { generationCompleted: true, aiGeneratedEvent };
      } catch (error) {
        console.error('Error while generating events locally:', error);
        return {
          generationCompleted: false,
          errorMessage: error.message,
        };
      }
    },
    [project]
  );

  return { generateEvents };
};
