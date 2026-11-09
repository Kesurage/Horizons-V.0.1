// @flow
import * as React from 'react';
import { makeSimplifiedProjectBuilder } from '../EditorFunctions/SimplifiedProject/SimplifiedProject';
import { executeUniversalAiChat } from './UniversalAiClient';
import {
  buildProjectDigest,
  getUniversalAiSystemPrompt,
  EVENTS_JSON_GUIDE,
  EVENTS_OPERATIONS_GUIDE,
} from './UniversalAiAgent';
import {
  buildInstructionCheatsheet,
  validateEventsAgainstMetadata,
} from './InstructionCheatsheet';
import { normalizeGeneratedEventsContent } from '../EditorFunctions/ApplyEventsChanges';
import { type EventsGenerationResult } from '../EditorFunctions';
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
 * Compact summary of the objects of a scene (name, type, behaviors) so the
 * compiler always knows exactly which objects exist — even when the calling
 * agent did not forward an objects list.
 */
const buildSceneObjectsSummary = (
  project: gdProject,
  sceneName: string
): string => {
  try {
    if (!project.hasLayoutNamed(sceneName)) return '';
    const scene = project.getLayout(sceneName);
    const lines: Array<string> = [];
    const describeObject = (object: gdObject) => {
      const behaviors: Array<string> = [];
      const behaviorNames = object.getAllBehaviorNames().toJSArray();
      behaviorNames.forEach(behaviorName => {
        const behavior = object.getBehavior(behaviorName);
        behaviors.push(
          `${behaviorName} (${behavior.getTypeName()})`
        );
      });
      lines.push(
        `- ${object.getName()} (type: ${object.getType()}${
          behaviors.length ? `, behaviors: ${behaviors.join(', ')}` : ''
        })`
      );
    };
    const globalObjects = project.getObjects();
    mapFor(0, globalObjects.getObjectsCount(), i => {
      describeObject(globalObjects.getObjectAt(i));
    });
    const sceneObjects = scene.getObjects();
    mapFor(0, sceneObjects.getObjectsCount(), i => {
      describeObject(sceneObjects.getObjectAt(i));
    });
    return lines.join('\n');
  } catch (ignored) {
    return '';
  }
};

// Local mapFor to avoid importing Utils just for this.
const mapFor = (start: number, end: number, callback: number => any) => {
  const result = [];
  for (let i = start; i < end; i++) {
    result.push(callback(i));
  }
  return result;
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

        // REAL instructions of the engine (exact names + parameter counts),
        // filtered to the extensions/objects/behaviors of this project.
        const instructionCheatsheet = buildInstructionCheatsheet({
          simplifiedProjectJson,
          eventsDescription,
          extensionNamesList,
        });

        // The scene's objects — the compiler must never invent object names.
        const sceneObjectsSummary = buildSceneObjectsSummary(
          project,
          sceneName
        );

        const compilerPrompt = [
          'Compile the following game logic request into GDevelop serialized events JSON operations.',
          '',
          `Target scene: "${sceneName}"`,
          `Objects concerned: ${objectsList || '(all scene objects)'}`,
          `Extensions available: ${extensionNamesList ||
            '(builtin instructions)'}`,
          placementHint ? `Placement hint: ${placementHint}` : '',
          '',
          '# REQUESTED LOGIC',
          eventsDescription,
          '',
          sceneObjectsSummary
            ? '# OBJECTS THAT EXIST IN THIS SCENE (use only these names)\n' +
              sceneObjectsSummary
            : '',
          existingEventsAsText
            ? '# EXISTING EVENTS IN THE SCENE (as readable text)\n' +
              existingEventsAsText.slice(0, 8000)
            : '# The scene has no events yet (or none relevant). Use "insert_at_end".',
          '',
          EVENTS_JSON_GUIDE,
          instructionCheatsheet ? '\n' + instructionCheatsheet : '',
          EVENTS_OPERATIONS_GUIDE,
        ]
          .filter(part => part !== '')
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
          changes: parsedResult.changes.map(change => {
            // Normalize the shape the model may still wrap ("{"events":[...]}")
            // into the plain array the apply pipeline needs, then validate
            // against the REAL engine metadata so the agent gets precise
            // feedback instead of silently-broken events.
            let generatedEvents: ?string = change.generatedEvents || null;
            let diagnosticLines: Array<string> = [];
            if (generatedEvents && typeof generatedEvents === 'string') {
              try {
                const parsedEvents = JSON.parse(generatedEvents);
                const normalized = normalizeGeneratedEventsContent(
                  parsedEvents
                );
                if (normalized !== parsedEvents) {
                  generatedEvents = JSON.stringify(normalized);
                }
                if (Array.isArray(normalized)) {
                  diagnosticLines = validateEventsAgainstMetadata(normalized);
                }
              } catch (ignored) {
                // JSON errors are handled by the apply pipeline — and it
                // reports them precisely.
              }
            }
            return {
              operationName: change.operationName || 'insert_at_end',
              operationTargetEvent: change.operationTargetEvent || null,
              isEventsJsonValid: change.generatedEvents
                ? typeof change.generatedEvents === 'string'
                : null,
              generatedEvents,
              areEventsValid: diagnosticLines.length === 0 ? null : false,
              extensionNames: change.extensionNames || null,
              diagnosticLines,
              undeclaredVariables: [],
              undeclaredObjectVariables: {},
              missingObjectBehaviors: {},
              missingResources: [],
            };
          }),
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
