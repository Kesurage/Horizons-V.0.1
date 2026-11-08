// @flow
import type {
  AiRequestAssistantMessage,
  AiRequestMessageAssistantFunctionCall,
} from '../Utils/GDevelopServices/Generation';
import {
  chatCompletionWithFailover,
  askSpecialist,
  webSearch,
  getProviderSlots,
} from './MultiAiOrchestrator';
import { DEFAULT_AI_SYSTEM_PROMPT } from './UniversalAiClient';

export type UniversalAiConfig = {
  baseUrl: string,
  apiKey: string,
  model: string,
  temperature: number,
  customSystemPrompt?: string,
};

/**
 * Compact, hand-tuned digest of the (simplified) project, so that ANY
 * OpenAI-compatible model can reason about the whole game structure —
 * scenes, objects, behaviors, variables, properties and extensions —
 * without sending the entire project JSON.
 */
export const buildProjectDigest = (
  simplifiedProjectJson: string | null,
  extensionsSummaryJson: string | null
): string => {
  if (!simplifiedProjectJson) {
    return 'No project is currently opened. The user may be chatting without a game project.';
  }
  try {
    const project = JSON.parse(simplifiedProjectJson);
    const lines: Array<string> = [];

    // Project properties
    lines.push('# PROJECT');
    const projectName =
      (project.name && (project.name.value || project.name)) || 'Untitled';
    const description =
      (project.description &&
        (project.description.value || project.description)) ||
      '';
    const packageName =
      (project.packageName &&
        (project.packageName.value || project.packageName)) ||
      '';
    const orientation =
      (project.orientation &&
        (project.orientation.value || project.orientation)) ||
      '';
    const gameResolutionSize =
      project.properties && project.properties.gameResolutionSize
        ? `${project.properties.gameResolutionSize[0]}x${
            project.properties.gameResolutionSize[1]
          }`
        : '';
    lines.push(`- Name: ${projectName}`);
    if (description) lines.push(`- Description: ${description}`);
    if (packageName) lines.push(`- Package: ${packageName}`);
    if (orientation) lines.push(`- Orientation: ${orientation}`);
    if (gameResolutionSize) lines.push(`- Resolution: ${gameResolutionSize}`);

    // Global objects
    const globalObjects =
      (project.objects && project.objects.objects) || project.objects || [];
    if (Array.isArray(globalObjects) && globalObjects.length > 0) {
      lines.push('', '# GLOBAL OBJECTS');
      globalObjects.forEach(obj => {
        const type = (obj.type && (obj.type.value || obj.type)) || 'unknown';
        lines.push(
          `- ${obj.name || '?'} (type: ${type}${
            obj.behaviors && obj.behaviors.length
              ? `, behaviors: ${obj.behaviors
                  .map(b => b.name || b.type || '?')
                  .join(', ')}`
              : ''
          })`
        );
      });
    }

    // Global variables
    const globalVariables =
      (project.variables && project.variables.variables) ||
      project.variables ||
      [];
    if (Array.isArray(globalVariables) && globalVariables.length > 0) {
      lines.push('', '# GLOBAL VARIABLES');
      globalVariables.forEach(v => {
        lines.push(
          `- ${v.name || '?'} (${v.type || 'number'}): ${JSON.stringify(
            v.value ?? ''
          )}`
        );
      });
    }

    // Scenes
    const layouts =
      (project.layouts && project.layouts.layouts) || project.layouts || [];
    if (Array.isArray(layouts)) {
      layouts.forEach(layout => {
        lines.push('', `# SCENE: ${layout.name || '?'}`);
        if (layout.description)
          lines.push(`- Description: ${layout.description}`);
        const objects =
          (layout.objects && layout.objects.objects) || layout.objects || [];
        if (Array.isArray(objects) && objects.length > 0) {
          lines.push('## Objects');
          objects.forEach(obj => {
            const type =
              (obj.type && (obj.type.value || obj.type)) || 'unknown';
            lines.push(
              `- ${obj.name || '?'} (type: ${type}${
                obj.behaviors && obj.behaviors.length
                  ? `, behaviors: ${obj.behaviors
                      .map(b => b.name || b.type || '?')
                      .join(', ')}`
                  : ''
              })`
            );
          });
        }
        const variables =
          (layout.variables && layout.variables.variables) ||
          layout.variables ||
          [];
        if (Array.isArray(variables) && variables.length > 0) {
          lines.push('## Scene variables');
          variables.forEach(v => {
            lines.push(
              `- ${v.name || '?'} (${v.type || 'number'}): ${JSON.stringify(
                v.value ?? ''
              )}`
            );
          });
        }
        const instances =
          (layout.instances && layout.instances.instances) ||
          layout.instances ||
          [];
        if (Array.isArray(instances) && instances.length > 0) {
          lines.push(`## Instances (${instances.length} placed)`);
          const byObject: { [string]: number } = {};
          instances.forEach(inst => {
            const key = inst.name || inst.i || '?';
            byObject[key] = (byObject[key] || 0) + 1;
          });
          Object.keys(byObject).forEach(objectName => {
            lines.push(`- ${objectName}: x${byObject[objectName]}`);
          });
        }
        // Events summary: count by type so the AI knows what logic exists.
        const countEvents = (events: any): number => {
          if (!events) return 0;
          if (Array.isArray(events)) {
            return events.reduce(
              (acc, ev) => acc + 1 + countEvents(ev.events || ev.e),
              0
            );
          }
          if (typeof events === 'object') {
            const list = events.events || events.e || [];
            return Array.isArray(list)
              ? list.reduce(
                  (acc: number, ev: any) =>
                    acc + 1 + countEvents(ev.events || ev.e),
                  0
                )
              : 0;
          }
          return 0;
        };
        const eventsCount = countEvents(
          layout.events && (layout.events.events || layout.events.e)
            ? layout.events
            : layout.events
        );
        lines.push(`## Events: ${eventsCount} event(s) in this scene`);
      });
    }

    // Extensions summary (project-specific extensions, behaviors, objects)
    if (extensionsSummaryJson) {
      try {
        const extSummary = JSON.parse(extensionsSummaryJson);
        const extText = JSON.stringify(extSummary);
        lines.push(
          '',
          '# PROJECT-SPECIFIC EXTENSIONS SUMMARY',
          extText.length > 12000
            ? extText.slice(0, 12000) + '\n... (truncated)'
            : extText
        );
      } catch (e) {
        // Ignore malformed summaries.
      }
    }

    return lines.join('\n');
  } catch (e) {
    // If parsing fails, fall back to a truncated raw dump.
    return (
      '# PROJECT (raw, truncated)\n' +
      simplifiedProjectJson.slice(0, 20000) +
      (simplifiedProjectJson.length > 20000 ? '\n... (truncated)' : '')
    );
  }
};

/**
 * OpenAI-compatible tool schemas for the GDevelop editor functions.
 * Argument names match exactly what `EditorFunctions/index.js` extracts.
 */
export const UNIVERSAL_AI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_or_replace_object',
      description:
        'Create a new object in a scene (or replace an existing one), choosing it from the public asset library or creating it from scratch. Provide either an object_type (e.g. "Sprite", "TextObject::Text", "TiledSpriteObject::TiledSprite", "PanelSpriteObject::PanelSprite") to create from scratch, or search_terms/description to find an asset from the library, or an asset_id.',
      parameters: {
        type: 'object',
        properties: {
          scene_name: { type: 'string', description: 'Name of the scene.' },
          object_name: {
            type: 'string',
            description: 'Name of the object to create or replace.',
          },
          object_type: {
            type: 'string',
            description:
              'Optional object type to create the object from scratch. Use "Sprite" for ordinary image-based objects, "TextObject::Text" for texts, "TiledSpriteObject::TiledSprite", "PanelSpriteObject::PanelSprite", "ParticleSystem::ParticleEmitter", "Cube3DObject", "Model3DObject", etc.',
          },
          asset_id: {
            type: 'string',
            description:
              'Optional asset store id to install the object from the asset library.',
          },
          search_terms: {
            type: 'string',
            description:
              'Optional short keywords to search the asset library (e.g. "space ship pixel").',
          },
          description: {
            type: 'string',
            description:
              'Optional description of the wanted asset (e.g. "a pixel-art knight character walking").',
          },
          replace_existing_object: {
            type: 'boolean',
            description:
              'Replace the object if it already exists (requires search_terms, description or asset_id).',
          },
          duplicated_object_name: {
            type: 'string',
            description:
              'Instead of searching an asset, duplicate this existing object.',
          },
          duplicated_object_scene: {
            type: 'string',
            description:
              'Scene of the object to duplicate (if not scene_name).',
          },
          target_object_scope: {
            type: 'string',
            description:
              'Where to create the object: "scene" (default) or "global" (shared across scenes).',
          },
          placement_hint: {
            type: 'string',
            description:
              'Optional short description of where/how the object should be used.',
          },
        },
        required: ['scene_name', 'object_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_object_properties',
      description:
        'Read the current properties, variables and behaviors of an object before changing it.',
      parameters: {
        type: 'object',
        properties: {
          scene_name: { type: 'string' },
          object_name: { type: 'string' },
        },
        required: ['scene_name', 'object_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'change_object_property',
      description:
        'Change one or more properties of an object (e.g. width, height, the text of a Text object...). changed_properties is a list of { property_name, value } entries.',
      parameters: {
        type: 'object',
        properties: {
          scene_name: { type: 'string' },
          object_name: { type: 'string' },
          changed_properties: {
            type: 'array',
            description: 'List of { property_name, value } entries to change.',
            items: {
              type: 'object',
              properties: {
                property_name: { type: 'string' },
                value: { type: 'string' },
              },
              required: ['property_name', 'value'],
            },
          },
        },
        required: ['scene_name', 'object_name', 'changed_properties'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_behavior',
      description:
        'Add a behavior to an object (e.g. "PlatformerObjectBehavior", "DraggableBehavior", "Physics2::Physics2Behavior", "TopDownMovementBehavior::TopDownMovementBehavior"...). The behavior type must be the full extension::Behavior type name.',
      parameters: {
        type: 'object',
        properties: {
          scene_name: { type: 'string' },
          object_name: { type: 'string' },
          behavior_type: {
            type: 'string',
            description:
              'Full behavior type, e.g. "PlatformerObjectBehavior" or "Physics2::Physics2Behavior".',
          },
          behavior_name: {
            type: 'string',
            description:
              'Optional custom name for the behavior (defaults to the type name).',
          },
        },
        required: ['scene_name', 'object_name', 'behavior_type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_behavior',
      description: 'Remove a behavior from an object.',
      parameters: {
        type: 'object',
        properties: {
          scene_name: { type: 'string' },
          object_name: { type: 'string' },
          behavior_name: { type: 'string' },
        },
        required: ['scene_name', 'object_name', 'behavior_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_behavior_properties',
      description: 'Read the properties of a behavior attached to an object.',
      parameters: {
        type: 'object',
        properties: {
          scene_name: { type: 'string' },
          object_name: { type: 'string' },
          behavior_name: { type: 'string' },
        },
        required: ['scene_name', 'object_name', 'behavior_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'change_behavior_property',
      description:
        'Change one or more properties of a behavior attached to an object (e.g. gravity, max speed, jump speed...).',
      parameters: {
        type: 'object',
        properties: {
          scene_name: { type: 'string' },
          object_name: { type: 'string' },
          behavior_name: { type: 'string' },
          changed_properties: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                property_name: { type: 'string' },
                value: { type: 'string' },
              },
              required: ['property_name', 'value'],
            },
          },
        },
        required: [
          'scene_name',
          'object_name',
          'behavior_name',
          'changed_properties',
        ],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'describe_instances',
      description:
        'List the instances placed in a scene (positions, layers, z-order) — optionally filtered by object name.',
      parameters: {
        type: 'object',
        properties: {
          scene_name: { type: 'string' },
          filter_by_object_name: { type: 'string' },
        },
        required: ['scene_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'put_2d_instances',
      description:
        'Place, move, transform or erase 2D instances in a scene (like painting with the instance brush). To simply place N copies of an object: brush_kind "point" + new_instances_count + brush_position "x,y". brush_kind can be "point", "line", "grid", "random_in_circle" or "erase". To move existing instances, pass their ids in existing_instance_ids and brush_position.',
      parameters: {
        type: 'object',
        properties: {
          scene_name: { type: 'string' },
          object_name: {
            type: 'string',
            description: 'Object to place (required to place new instances).',
          },
          layer_name: {
            type: 'string',
            description: 'Layer name (e.g. "base" or "UI").',
          },
          brush_kind: {
            type: 'string',
            description:
              'One of: "point" (place at a position), "line" (between two positions), "grid" (rows x columns), "random_in_circle", "erase" (delete instances).',
          },
          brush_position: {
            type: 'string',
            description: 'Position as "x,y" (in pixels).',
          },
          brush_end_position: {
            type: 'string',
            description: 'End position as "x,y" for line/grid brushes.',
          },
          brush_size: {
            type: 'number',
            description: 'Size of the brush area (for grid/random_in_circle).',
          },
          row_count: {
            type: 'number',
            description: 'Rows for the grid brush.',
          },
          column_count: {
            type: 'number',
            description: 'Columns for the grid brush.',
          },
          new_instances_count: {
            type: 'number',
            description:
              'Number of instances to place (default 1 when placing).',
          },
          existing_instance_ids: {
            type: 'string',
            description:
              'Comma-separated ids of existing instances to move/erase.',
          },
          instances_z_order: { type: 'number' },
          instances_rotation: {
            type: 'number',
            description: 'Angle in degrees.',
          },
          instances_size: {
            type: 'string',
            description: 'Size as "width,height" (empty to keep custom size).',
          },
          instances_opacity: { type: 'number', description: 'Opacity 0-255.' },
        },
        required: ['scene_name', 'layer_name', 'brush_kind'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'put_3d_instances',
      description:
        'Place, move, transform or erase 3D instances in a scene (like painting with the 3D instance brush). brush_kind can be "point", "grid" or "erase".',
      parameters: {
        type: 'object',
        properties: {
          scene_name: { type: 'string' },
          object_name: { type: 'string' },
          layer_name: { type: 'string' },
          brush_kind: {
            type: 'string',
            description: '"point", "grid" or "erase".',
          },
          brush_position: {
            type: 'string',
            description: 'Position as "x,y,z".',
          },
          brush_end_position: { type: 'string' },
          brush_size: { type: 'number' },
          row_count: { type: 'number' },
          column_count: { type: 'number' },
          new_instances_count: { type: 'number' },
          existing_instance_ids: { type: 'string' },
          instances_z_order: { type: 'number' },
          instances_rotation: { type: 'string' },
          instances_size: { type: 'string' },
          instances_opacity: { type: 'number' },
        },
        required: ['scene_name', 'layer_name', 'brush_kind'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_scene_events',
      description:
        'Read the events (game logic) of a scene, rendered as readable text, before modifying them.',
      parameters: {
        type: 'object',
        properties: {
          scene_name: { type: 'string' },
        },
        required: ['scene_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_scene_events',
      description:
        'Create or update the game logic (events) of a scene. Describe precisely what the logic should do; the description is compiled into real GDevelop events. Use extension_names_list to hint which extensions hold the conditions/actions you need.',
      parameters: {
        type: 'object',
        properties: {
          scene_name: { type: 'string' },
          events_description: {
            type: 'string',
            description:
              'Precise description of the events to create, e.g. "When the player collides with a Coin, delete the Coin and add 1 to Score variable."',
          },
          extension_names_list: {
            type: 'string',
            description:
              'JSON array or comma-separated names of extensions containing the needed conditions/actions (e.g. "BuiltinObject, BuiltinVariables, Physics2").',
          },
          objects_list: {
            type: 'string',
            description:
              'Optional list of object names concerned by the logic.',
          },
          placement_hint: {
            type: 'string',
            description: 'Optional hint where to insert the events.',
          },
          estimated_complexity: {
            type: 'number',
            description: 'Rough complexity estimate (1-10).',
          },
        },
        required: ['scene_name', 'events_description', 'extension_names_list'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_scene',
      description: 'Create a new scene in the project.',
      parameters: {
        type: 'object',
        properties: {
          scene_name: { type: 'string' },
          include_ui_layer: { type: 'boolean' },
          background_color: {
            type: 'string',
            description:
              'Optional background color as R;G;B (e.g. "25;26;27").',
          },
        },
        required: ['scene_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_scene',
      description: 'Delete a scene from the project.',
      parameters: {
        type: 'object',
        properties: {
          scene_name: { type: 'string' },
        },
        required: ['scene_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_scene_properties_layers_effects',
      description:
        'Read the properties, layers and effects of a scene (camera size, background color, layers...).',
      parameters: {
        type: 'object',
        properties: {
          scene_name: { type: 'string' },
        },
        required: ['scene_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'change_scene_properties_layers_effects_groups',
      description:
        'Change scene properties, layers, layer effects or object groups in one call.',
      parameters: {
        type: 'object',
        properties: {
          scene_name: { type: 'string' },
          changed_properties: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                property_name: { type: 'string' },
                value: { type: 'string' },
              },
              required: ['property_name', 'value'],
            },
          },
          changed_layers: { type: 'array', items: { type: 'object' } },
          changed_layer_effects: { type: 'array', items: { type: 'object' } },
          changed_groups: { type: 'array', items: { type: 'object' } },
        },
        required: ['scene_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_or_edit_variable',
      description:
        'Create or edit a variable (global, scene or object scope). Use variable_scope: "global", "scene" or "object". variable_name_or_path supports child variables with dots (e.g. "player.stats.hp").',
      parameters: {
        type: 'object',
        properties: {
          variable_scope: {
            type: 'string',
            description: '"global", "scene" or "object".',
          },
          variable_name_or_path: {
            type: 'string',
            description:
              'Name of the variable, or a path with dots for children (e.g. "score" or "player.stats.hp").',
          },
          value: {
            type: 'string',
            description: 'The value of the variable, as a string.',
          },
          variable_type: {
            type: 'string',
            description: '"number", "string" or "boolean".',
          },
          scene_name: {
            type: 'string',
            description: 'Required for scene and object scopes.',
          },
          object_name: {
            type: 'string',
            description: 'Required for object scope.',
          },
        },
        required: ['variable_scope', 'variable_name_or_path', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_or_update_plan',
      description:
        'Create or update a step-by-step plan for complex multi-step tasks (orchestrator mode). Each task has an id, title, description and dependencies.',
      parameters: {
        type: 'object',
        properties: {
          plan: {
            type: 'object',
            properties: {
              tasks: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    title: { type: 'string' },
                    description: { type: 'string' },
                    dependsOn: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['id', 'title', 'description'],
                },
              },
            },
            required: ['tasks'],
          },
        },
        required: ['plan'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_full_docs',
      description:
        'Read the full documentation about GDevelop extensions/features when unsure how to use them.',
      parameters: {
        type: 'object',
        properties: {
          extension_names: {
            type: 'string',
            description:
              'Comma-separated names of the extensions to read about.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_specialist',
      description:
        'Delegate a sub-task to the specialist AI of your team (e.g. Gemini). Use it for: analyzing images/video, complex project analysis, long-context reasoning, or when you need a second opinion. The specialist answers as text and cannot modify the project.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description:
              'Precise, self-contained description of what the specialist should analyze or answer.',
          },
          details: {
            type: 'string',
            description:
              'Optional data/code/context the specialist should work on (e.g. a JSON dump, an error message, a base64-free description of media).',
          },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the live web (via the Gemini google_search grounding of your AI team). Use it for up-to-date information: GDevelop updates, APIs, game design references, error troubleshooting.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query.',
          },
        },
        required: ['query'],
      },
    },
  },
];

const AGENT_RULES = `
# HOW YOU WORK
You are an autonomous agent working INSIDE the GDevelop/Horizons game editor.
You modify the actual game project by calling functions (tools).
Rules:
- ALWAYS inspect before you change: use inspect_* / describe_instances / read_scene_events to know the current state.
- Make changes with the provided tools. One tool call at a time, in a logical order.
- Use add_scene_events to create game logic: give a precise, self-contained description of conditions and actions (mention exact object names, variable names, and values).
- You lead a small AI TEAM: you are the primary agent. For media analysis, deep analysis or a second opinion, delegate with ask_specialist. For up-to-date knowledge, use web_search. Prefer solving yourself; delegate only when it truly helps.
- After finishing your changes, ALWAYS reply with a short summary of what you did in markdown, so the user can review.
- If a tool call fails, read the error and adapt (wrong argument, missing scene, wrong behavior type...), then retry differently.
- If the user asks a question without requesting changes, just answer — do not call tools.
- Never invent object names, scenes, variables or behaviors: check the project context first.
- Behavior type names use the full form, e.g. "PlatformerObjectBehavior", "Physics2::Physics2Behavior", "TopDownMovementBehavior", "DraggableBehavior".
`;

const CHAT_RULES = `
# HOW YOU WORK
You are a helpful game development assistant embedded in the GDevelop/Horizons editor.
The full structure of the user's game project is given to you as context.
Answer questions, explain concepts, suggest events logic (conditions/actions), debug issues,
and give concrete, ready-to-use guidance using GDevelop terminology (objects, behaviors, events, variables, scenes).
You cannot modify the project directly in this mode — explain what the user should do, step by step.
`;

/**
 * All engine extensions available offline (compiled into the game engine).
 * The AI agent can use any of them (objects, behaviors, conditions, actions),
 * like the objects/behaviors picker in the editor does.
 */
export const AVAILABLE_ENGINE_EXTENSIONS = `
- 3D: objects: Cube3DObject, Model3DObject; behaviors: Base3D::Base3DBehavior
- AnchorBehavior: behaviors: AnchorBehavior::AnchorBehavior
- BBText: objects: BBText
- BitmapText: objects: BitmapTextObject
- DestroyOutsideBehavior: behaviors: DestroyOutsideBehavior::DestroyOutside
- DraggableBehavior: behaviors: DraggableBehavior::Draggable
- Lighting: objects: LightObject; behaviors: Lighting::LightObstacleBehavior
- Multiplayer: behaviors: MultiplayerObjectBehavior
- PanelSpriteObject: objects: PanelSpriteObject::PanelSprite
- ParticleSystem: objects: ParticleSystem::ParticleEmitter
- PathfindingBehavior: behaviors: PathfindingBehavior::PathfindingBehavior, PathfindingBehavior::PathfindingObstacleBehavior
- Physics2Behavior: behaviors: Physics2::Physics2Behavior
- Physics3DBehavior: behaviors: Physics3D::Physics3DBehavior, Physics3D::PhysicsCar3D, Physics3D::PhysicsCharacter3D
- PhysicsBehavior: behaviors: PhysicsBehavior::PhysicsBehavior
- PlatformBehavior: behaviors: PlatformBehavior::PlatformBehavior, PlatformBehavior::PlatformerObjectBehavior
- PrimitiveDrawing: objects: PrimitiveDrawing::Drawer
- SaveState: behaviors: SaveState::SaveConfiguration
- Spine: objects: SpineObject
- TextEntryObject: objects: TextEntryObject::TextEntry
- TextInput: objects: TextInputObject
- TextObject: objects: TextObject::Text
- TileMap: objects: TileMap::CollisionMask, TileMap::SimpleTileMap, TileMap::TileMap
- TiledSpriteObject: objects: TiledSpriteObject::TiledSprite
- TopDownMovementBehavior: behaviors: TopDownMovementBehavior::TopDownMovementBehavior
- TweenBehavior: behaviors: Tween::TweenBehavior
- Video: objects: VideoObject
Also always available: core objects (Sprite, TiledSprite, Text, ShapePainter, ParticlesEmitter, BBText, Video, 3D boxes/models), p2p/socketio multiplayer tools, and every behavior action/condition of the behaviors listed above.
`;

export const getUniversalAiSystemPrompt = ({
  mode,
  projectDigest,
  customSystemPrompt,
}: {|
  mode: 'chat' | 'agent' | 'orchestrator',
  projectDigest: string,
  customSystemPrompt?: ?string,
|}): string => {
  const base =
    mode === 'chat'
      ? CHAT_RULES
      : mode === 'orchestrator'
      ? AGENT_RULES +
        '\nFor complex requests, FIRST use create_or_update_plan to lay out the steps, then execute them one by one.\n'
      : AGENT_RULES;
  const personaPrompt =
    customSystemPrompt && customSystemPrompt.trim().length > 0
      ? customSystemPrompt.trim()
      : DEFAULT_AI_SYSTEM_PROMPT;
  return (
    personaPrompt +
    '\n\n' +
    base +
    '\n\n# AVAILABLE EXTENSIONS (usable offline, no installation needed)\n' +
    AVAILABLE_ENGINE_EXTENSIONS +
    '\n\n# CURRENT GAME PROJECT (live context)\n' +
    projectDigest
  );
};

/**
 * Guide for the events compiler: how GDevelop events are serialized as JSON.
 * Used by the offline events-generation pipeline (add_scene_events).
 */
export const EVENTS_JSON_GUIDE = `
GDevelop events must be returned as serialized events JSON.
A events list is: { "events": [ <event>, ... ] }
A standard event is:
{
  "type": "BuiltinCommonInstructions::Standard",
  "disabled": false,
  "folded": false,
  "conditions": [
    {
      "type": { "value": "Collision" },
      "inverted": false,
      "parameters": ["", "Player", "Coin", "", "", ""]
    }
  ],
  "actions": [
    {
      "type": { "value": "Delete" },
      "inverted": false,
      "parameters": ["", "Coin", ""]
    }
  ],
  "events": []
}
The FIRST parameter is always the scene name — use an empty string "".
Object names are then passed as parameters (e.g. "Player", "Coin").
Expressions are passed as string parameters (e.g. "Score + 1", "Player.X()").
Common builtin instruction types (value field):
- Conditions: "Collision", "Distance", "AtPosition", "KeyReleased", "IsKeyPressed", "CursorOnObject", "Timer", "SceneJustBegins", "VariableCompare", "ObjectVariableCompare", " Always" (use "BuiltinCommonInstructions::Standard" with no condition for always), "AnimationFrame", "PosX", "PosY", "NumberProperties"...
- Actions: "Create", "Delete", "SetPosition", "AddForceXY", "SetAngle", "ChangeAnimation", "ChangeText", "ChangeVarScene", "AddVarScene", "ChangeObjectVariable", "AddObjectVariable", "ResetTimer", "PauseTimer", "PlaySound", "PlayMusic", "PlaySoundCanal", "Scene", "Quit", "SetSceneVariable", "SetObjectVariable"... plus every behavior action like "SetPropertyOfPlatformerObject", "SetGravityOfPhysics2"...
Common condition/action type names must be the FULL name of the instruction as registered by its extension (e.g. "BuiltinCommonInstructions::Standard" for the event type itself; instructions are identified by short names like "Collision", "Create", "Delete", "SetPosition"...). If unsure, prefer simple builtin instructions.
Other event types: "BuiltinCommonInstructions::ForEach" (parameters: ["", "Object"]), "BuiltinCommonInstructions::Repeat" (parameters: ["", "timesExpression"]), "BuiltinCommonInstructions::While", "BuiltinCommonInstructions::Comment" (parameters: ["", "comment text", ""]), "BuiltinCommonInstructions::Group".
Sub-events go in the "events" array of the parent event.
`;

export const EVENTS_OPERATIONS_GUIDE = `
Return STRICT JSON (no markdown fence) of the shape:
{
  "resultMessage": "short human readable summary",
  "changes": [
    {
      "operationName": "insert_at_end",
      "operationTargetEvent": null,
      "generatedEvents": "{ \\"events\\": [ ... ] }"
    }
  ]
}
operationName is one of:
- "insert_at_end": append events at the end of the scene events (no target needed).
- "insert_after_event" / "insert_before_event": insert relative to an existing event.
- "replace_entire_event_and_sub_events", "replace_event_but_keep_existing_sub_events", "insert_and_replace_event": replace the event at the target path.
- "delete_event": remove the event at the target path (no generatedEvents needed).
"operationTargetEvent" is a path string like "event-0" (first event), "event-0.1" (sub-event 1 of event 0).
When asked to adapt existing events, you may receive the existing events; prefer precise operations over replacing everything.
`;

/**
 * Convert a GDevelop AiRequest output (array of messages) into OpenAI chat
 * messages, preserving tool calls and tool results.
 *
 * Robustness: if the conversation contains tool calls that were never
 * answered (e.g. a previous request failed after the model called a tool),
 * a synthetic tool result is injected. Without this, providers reject every
 * follow-up message with "tool_calls must be followed by tool messages"
 * (HTTP 400) and the editor re-executes the same tool over and over.
 */
export const convertGDevelopOutputToOpenAiMessages = (
  output: Array<any>
): Array<any> => {
  const chatMessages: Array<any> = [];
  let pendingAssistant: any = null;

  const flushAssistant = () => {
    if (pendingAssistant) {
      chatMessages.push(pendingAssistant);
      pendingAssistant = null;
    }
  };

  // First pass: remember which tool calls already have a result.
  const answeredCallIds = new Set<string>();
  (output || []).forEach((message: any) => {
    if (message.type === 'function_call_output' && message.call_id) {
      answeredCallIds.add(message.call_id);
    }
  });

  (output || []).forEach((message: any) => {
    if (message.type === 'message' && message.role === 'user') {
      flushAssistant();
      const text = (message.content || [])
        .filter(
          c => c.type === 'input_text' || (c.text && c.type !== 'function_call')
        )
        .map(c => c.text || '')
        .join('\n');
      if (text) chatMessages.push({ role: 'user', content: text });
      return;
    }

    if (message.type === 'message' && message.role === 'assistant') {
      flushAssistant();
      const textParts: Array<string> = [];
      const toolCalls: Array<any> = [];
      (message.content || []).forEach(item => {
        if (item.type === 'output_text') {
          textParts.push(item.text || '');
        } else if (item.type === 'function_call') {
          toolCalls.push({
            id: item.call_id,
            type: 'function',
            function: { name: item.name, arguments: item.arguments || '{}' },
          });
        }
      });
      const assistantMessage: any = {};
      if (textParts.length > 0) assistantMessage.content = textParts.join('\n');
      if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
      if (assistantMessage.content || assistantMessage.tool_calls) {
        pendingAssistant = { role: 'assistant', ...assistantMessage };
      }
      return;
    }

    if (message.type === 'function_call') {
      // Standalone function call message (legacy layout) — treat as assistant tool call.
      flushAssistant();
      pendingAssistant = {
        role: 'assistant',
        tool_calls: [
          {
            id: message.call_id,
            type: 'function',
            function: {
              name: message.name,
              arguments: message.arguments || '{}',
            },
          },
        ],
      };
      return;
    }

    if (message.type === 'function_call_output') {
      // Function call outputs belong after the assistant tool_calls message.
      flushAssistant();
      chatMessages.push({
        role: 'tool',
        tool_call_id: message.call_id,
        content: message.output || '',
      });
      return;
    }
  });
  flushAssistant();

  // Second pass: heal dangling tool calls — inject a synthetic tool result
  // for every tool call that never got one, so the message sequence stays
  // valid for every OpenAI-compatible provider.
  const healed: Array<any> = [];
  chatMessages.forEach(chatMessage => {
    healed.push(chatMessage);
    if (chatMessage.role === 'assistant' && chatMessage.tool_calls) {
      chatMessage.tool_calls.forEach((toolCall: any) => {
        if (!answeredCallIds.has(toolCall.id)) {
          healed.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content:
              'The function call was interrupted (the AI request failed before it could be run). The result is unknown. If you still need this action, call the function again; otherwise continue and answer the user.',
          });
        }
      });
    }
  });

  return healed;
};

/**
 * Convert an OpenAI chat completion response into GDevelop AiRequest
 * assistant messages (output_text + function_call items).
 */
export const convertOpenAiResponseToGDevelopMessages = (
  responseMessage: any
): Array<AiRequestAssistantMessage | AiRequestMessageAssistantFunctionCall> => {
  const text: string = responseMessage?.content || '';
  const toolCalls: Array<any> = responseMessage?.tool_calls || [];

  const content: Array<any> = [];
  if (text && text.trim().length > 0) {
    content.push({
      type: 'output_text',
      status: 'completed',
      text: text,
      annotations: [],
    });
  }
  toolCalls.forEach(toolCall => {
    content.push({
      type: 'function_call',
      status: 'completed',
      call_id:
        toolCall.id ||
        'call_' +
          Date.now() +
          '_' +
          Math.random()
            .toString(36)
            .slice(2),
      name: toolCall.function?.name || 'unknown_function',
      arguments:
        typeof toolCall.function?.arguments === 'string'
          ? toolCall.function.arguments
          : JSON.stringify(toolCall.function?.arguments || {}),
    });
  });

  if (content.length === 0) {
    content.push({
      type: 'output_text',
      status: 'completed',
      text:
        '(The model returned an empty response. Try rephrasing your request.)',
      annotations: [],
    });
  }

  return [
    {
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content,
      messageId: 'msg_ast_' + Date.now(),
    },
  ];
};

/**
 * Core bridge: send the conversation through the Multi-AI team
 * (rate-limit queue + failover) and get back GDevelop-format messages.
 */
export const runUniversalAiTurn = async ({
  config,
  systemPrompt,
  historyGDevelopOutput,
  newUserPrompt,
  mode,
  existingHistoryOutput,
}: {
  config: UniversalAiConfig,
  systemPrompt: string,
  historyGDevelopOutput?: ?Array<any>,
  newUserPrompt?: ?string,
  mode: 'chat' | 'agent' | 'orchestrator',
  existingHistoryOutput?: ?Array<any>,
}): Promise<{ messages: Array<any> }> => {
  const chatMessages: Array<any> = [{ role: 'system', content: systemPrompt }];

  const historyOutput = historyGDevelopOutput || existingHistoryOutput || null;
  if (historyOutput) {
    chatMessages.push(
      ...convertGDevelopOutputToOpenAiMessages((historyOutput: any))
    );
  }

  if (newUserPrompt) {
    chatMessages.push({ role: 'user', content: newUserPrompt });
  }

  const useTools = mode !== 'chat';

  // Prefer the team slot matching the explicitly configured endpoint
  // (falls back to the default team order when not found).
  let preferSlotId = null;
  try {
    const target = (config.baseUrl || '').trim().toLowerCase();
    const slots = getProviderSlots();
    const match = slots.find(
      slot =>
        slot.baseUrl &&
        slot.baseUrl.trim().toLowerCase() === target &&
        (!slot.apiKey || slot.apiKey.trim().length === 0
          ? !!config.apiKey
          : true)
    );
    preferSlotId = match ? match.id : null;
  } catch (ignored) {
    preferSlotId = null;
  }

  const result = await chatCompletionWithFailover({
    messages: chatMessages,
    tools: useTools ? UNIVERSAL_AI_TOOLS : null,
    temperature:
      typeof config.temperature === 'number' ? config.temperature : 0.7,
    preferSlotId,
  });

  const responseMessage =
    result.data && result.data.choices && result.data.choices[0]
      ? result.data.choices[0].message
      : null;
  if (!responseMessage) {
    throw new Error('The AI provider returned an unexpected response.');
  }

  return {
    messages: convertOpenAiResponseToGDevelopMessages(responseMessage),
  };
};

export { askSpecialist, webSearch };
