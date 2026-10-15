// @flow
import axios from 'axios';
import { GDevelopAiCdn, GDevelopGenerationApi } from './ApiConfigs';
import { type MessageByLocale } from '../i18n/MessageByLocale';
import { getIDEVersionWithHash } from '../../Version';
import { extractNextPageUriFromLinkHeader } from './Play';
import {
  ensureIsArray,
  ensureIsObject,
  ensureObjectHasProperty,
} from '../DataValidator';
import {
  executeUniversalAiChat,
  getLocalAiHistory,
  saveLocalAiRequest,
} from '../../AiGeneration/UniversalAiClient';

const getStoredAiConfig = () => {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('gd-preferences') : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.values) {
        return {
          baseUrl: parsed.values.aiBaseUrl || 'https://api.openai.com/v1',
          apiKey: parsed.values.aiApiKey || '',
          model: parsed.values.aiModel || 'gpt-4o',
          temperature: typeof parsed.values.aiTemperature === 'number' ? parsed.values.aiTemperature : 0.7,
          customSystemPrompt: parsed.values.aiCustomSystemPrompt || '',
        };
      }
    }
  } catch (e) {}
  return {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o',
    temperature: 0.7,
    customSystemPrompt: '',
  };
};

export type Environment = 'staging' | 'live';

export type GenerationStatus = 'working' | 'ready' | 'error' | 'suspended';

export type AiRequestSuggestion = {
  title: string,
  suggestedMessage: string,
};

export type AiRequestSuggestions = {
  explanationMessage: string,
  suggestions: Array<AiRequestSuggestion>,
};

export type AiRequestPlanTask = {
  id: string,
  title: string,
  description: string,
  status: 'pending' | 'in_progress' | 'done' | 'voided',
  dependsOn: string[],
};

export type AiRequestPlan = {
  tasks: AiRequestPlanTask[],
};

export type AiRequestMessageAssistantFunctionCall = {|
  type: 'function_call',
  status: 'completed',
  call_id: string,
  name: string,
  arguments: string,
  taskId?: string,
|};

export type AiRequestFunctionCallOutput = {
  type: 'function_call_output',
  call_id: string,
  output: string,
  suggestions?: AiRequestSuggestions,
  messageId?: string,
  projectVersionIdAfterMessage?: string,
};

export type AiRequestAssistantMessage = {
  type: 'message',
  status: 'completed',
  role: 'assistant',
  content: Array<
    | {
        type: 'reasoning',
        status: 'completed',
        summary: {
          text: string,
          type: 'summary_text',
        },
      }
    | {
        type: 'output_text',
        status: 'completed',
        text: string,
        annotations: Array<{}>,
      }
    | AiRequestMessageAssistantFunctionCall
  >,
  suggestions?: AiRequestSuggestions,
  messageId?: string,
  projectVersionIdAfterMessage?: string,
};

export type AiRequestUserMessage = {
  type: 'message',
  status: 'completed',
  role: 'user',
  content: Array<{
    type: 'user_request',
    status: 'completed',
    text: string,
  }>,
  messageId?: string,
  projectVersionIdBeforeMessage?: string,
};

export type AiRequestMessage =
  | AiRequestAssistantMessage
  | AiRequestUserMessage
  | AiRequestFunctionCallOutput;

export type AiConfiguration = {
  presetId: string,
};

type AiRequestToolOptions = {
  includeEventsJson?: boolean,
  watchPollingIntervalInMs?: number,
};

export type AiRequest = {
  id: string,
  createdAt: string,
  updatedAt: string,
  userId: string,
  gameId?: string | null,
  gameProjectJson?: string | null,
  status: GenerationStatus,
  mode?: 'chat' | 'agent' | 'orchestrator',
  aiConfiguration?: AiConfiguration,
  toolsVersion?: string,
  toolOptions?: AiRequestToolOptions | null,
  forkedFromAiRequestId?: string | null,
  forkedAfterOriginalMessageId?: string | null,
  forkedAfterNewMessageId?: string | null,

  error: {
    code: string,
    message: string,
  } | null,

  output?: Array<AiRequestMessage>,

  lastUserMessagePriceInCredits?: number | null,
  totalPriceInCredits?: number | null,
};

export type AiGeneratedEventStats = {
  retriesCount: number,
  finalMissingTypes: string[],
  systemPromptTemplateHash: string,
  userPromptTemplateHash: string,
  allFeaturesSummaryContentHash: string,
  finalModelPublicId: string,
};

export type AiGeneratedEventUndeclaredVariable = {
  name: string,
  type: 'number' | 'string' | 'boolean' | 'structure' | 'array' | null,
  requiredScope: 'global' | 'scene' | 'none',
};

export type AiGeneratedEventMissingObjectBehavior = {
  /** The name of the object that is missing the behavior. */
  objectName: string,
  /** The name of the behavior that is missing. */
  name: string,
  /** The type of the behavior that is missing. */
  type: string,
};

export type AiGeneratedEventMissingResource = {
  resourceName: string,
  resourceKind:
    | 'image'
    | 'audio'
    | 'font'
    | 'video'
    | 'json'
    | 'tilemap'
    | 'tileset'
    | 'model3D'
    | 'atlas'
    | 'spine'
    | 'spritesheet'
    | 'bitmapFont'
    | string,
};

export type AiGeneratedEventChange = {
  operationName: string,
  operationTargetEvent: string | null,
  isEventsJsonValid: boolean | null,
  generatedEvents: string | null,
  areEventsValid: boolean | null,
  extensionNames: string[] | null,
  diagnosticLines: string[],
  undeclaredVariables: AiGeneratedEventUndeclaredVariable[],
  undeclaredObjectVariables: {
    [objectName: string]: AiGeneratedEventUndeclaredVariable[],
  },
  missingObjectBehaviors: {
    [objectName: string]: AiGeneratedEventMissingObjectBehavior[],
  },
  missingResources: AiGeneratedEventMissingResource[],
};

export type AiGeneratedEvent = {
  id: string,
  createdAt: string,
  updatedAt: string,
  userId: string | null, // null for calls made by the API.
  status: GenerationStatus,

  partialGameProjectJson: string,
  eventsDescription: string,
  extensionNamesList: string,
  objectsList: string,
  existingEventsAsText: string,
  existingEventsJson: string | null,
  existingEventsJsonUserRelativeKey: string | null,

  resultMessage: string | null,
  changes: Array<AiGeneratedEventChange> | null,

  error: {
    code: string,
    message: string,
  } | null,

  stats: AiGeneratedEventStats | null,
};

export type AssetSearch = {
  id: string,
  userId: string,
  createdAt: string,
  query: {
    searchTerms: string[],
    objectType: string,
    description: string | null,
    twoDimensionalViewKind: string | null,
    relatedAiRequestId: string | null,
    lastUserMessage: string | null,
    lastAssistantMessages: string[],
  },
  status: 'completed' | 'failed',
  results: Array<{
    score: number,
    asset: any,
  }> | null,
};

export type ResourceSearch = {
  id: string,
  userId: string,
  createdAt: string,
  query: {
    searchTerms: string[],
    resourceKind: string,
  },
  status: 'completed' | 'failed',
  results: Array<{
    score: number,
    resource: {
      name: string,
      url: string,
    },
  }> | null,
};

// $FlowFixMe[cannot-resolve-name]
export const apiClient: Axios = axios.create({
  baseURL: GDevelopGenerationApi.baseUrl,
});

export const getAiRequest = async (
  getAuthorizationHeader: () => Promise<string>,
  {
    userId,
    aiRequestId,
  }: {|
    userId: string,
    aiRequestId: string,
  |}
): Promise<AiRequest> => {
  const localHistory = getLocalAiHistory();
  const local = localHistory.find(r => r.id === aiRequestId);
  if (local) return local;

  const authorizationHeader = await getAuthorizationHeader();
  // $FlowFixMe[underconstrained-implicit-instantiation]
  const response = await axios.get(
    `${GDevelopGenerationApi.baseUrl}/ai-request/${aiRequestId}`,
    {
      params: {
        userId,
      },
      headers: {
        Authorization: authorizationHeader,
      },
    }
  );
  return ensureObjectHasProperty({
    data: response.data,
    propertyName: 'id',
    endpointName: '/ai-request/{id} of Generation API',
  });
};

export const getPartialAiRequest = async (
  getAuthorizationHeader: () => Promise<string>,
  {
    userId,
    aiRequestId,
    include,
  }: {|
    userId: string,
    aiRequestId: string,
    include: string,
  |}
): // $FlowFixMe[deprecated-utility]
Promise<$Shape<AiRequest>> => {
  const authorizationHeader = await getAuthorizationHeader();
  // $FlowFixMe[underconstrained-implicit-instantiation]
  const response = await axios.get(
    `${GDevelopGenerationApi.baseUrl}/ai-request/${aiRequestId}`,
    {
      params: {
        userId,
        include,
      },
      headers: {
        Authorization: authorizationHeader,
      },
    }
  );
  return ensureObjectHasProperty({
    data: response.data,
    propertyName: 'id',
    endpointName: '/ai-request/{id} of Generation API',
  });
};

export const getAiRequests = async (
  getAuthorizationHeader: () => Promise<string>,
  {
    userId,
    forceUri,
  }: {|
    userId: string,
    forceUri: ?string,
  |}
): Promise<{
  aiRequests: Array<AiRequest>,
  nextPageUri: ?string,
}> => {
  const localHistory = getLocalAiHistory();
  if (localHistory.length > 0) {
    return {
      aiRequests: localHistory,
      nextPageUri: null,
    };
  }

  const authorizationHeader = await getAuthorizationHeader();
  const uri = forceUri || '/ai-request';

  // $FlowFixMe[incompatible-type]
  const response = await apiClient.get(uri, {
    headers: {
      Authorization: authorizationHeader,
    },
    params: forceUri ? { userId } : { userId, perPage: 10 },
  });
  const nextPageUri = response.headers.link
    ? extractNextPageUriFromLinkHeader(response.headers.link)
    : null;
  return {
    aiRequests: ensureIsArray({
      data: response.data,
      endpointName: '/ai-request of Generation API',
    }),
    nextPageUri,
  };
};

export const createAiRequest = async (
  getAuthorizationHeader: () => Promise<string>,
  {
    userId,
    userRequest,
    gameProjectJson,
    gameProjectJsonUserRelativeKey,
    projectSpecificExtensionsSummaryJson,
    projectSpecificExtensionsSummaryJsonUserRelativeKey,
    payWithCredits,
    mode,
    aiConfiguration,
    gameId,
    projectVersionIdBeforeMessage,
    fileMetadata,
    storageProviderName,
    toolsVersion,
  }: {|
    userId: string,
    userRequest: string,
    gameProjectJson: string | null,
    gameProjectJsonUserRelativeKey: string | null,
    projectSpecificExtensionsSummaryJson: string | null,
    projectSpecificExtensionsSummaryJsonUserRelativeKey: string | null,
    payWithCredits: boolean,
    mode: 'chat' | 'agent' | 'orchestrator',
    aiConfiguration: AiConfiguration,
    gameId: string | null,
    projectVersionIdBeforeMessage?: string | null,
    fileMetadata: ?{
      fileIdentifier: string,
      version?: string,
      lastModifiedDate?: number,
      gameId?: string,
    },
    storageProviderName: ?string,
    toolsVersion: string,
  |}
): Promise<AiRequest> => {
  const config = getStoredAiConfig();
  const aiRequestId = 'airq_univ_' + Date.now();
  const userMessageId = 'msg_usr_' + Date.now();
  const assistantMessageId = 'msg_ast_' + (Date.now() + 1);

  const userMessage: AiRequestUserMessage = {
    type: 'message',
    status: 'completed',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: userRequest,
      },
    ],
    messageId: userMessageId,
  };

  try {
    const { assistantText } = await executeUniversalAiChat({
      userPrompt: userRequest,
      conversationHistory: [userMessage],
      config,
    });

    const assistantMessage: AiRequestAssistantMessage = {
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          status: 'completed',
          text: assistantText,
          annotations: [],
        },
      ],
      messageId: assistantMessageId,
    };

    const newAiRequest: AiRequest = {
      id: aiRequestId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userId: userId || 'local-user',
      status: 'ready',
      mode: mode || 'chat',
      error: null,
      output: [userMessage, assistantMessage],
      lastUserMessagePriceInCredits: 0,
      totalPriceInCredits: 0,
    };

    saveLocalAiRequest(newAiRequest);
    return newAiRequest;
  } catch (err) {
    const errorAssistantMessage: AiRequestAssistantMessage = {
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          status: 'completed',
          text: `⚠️ **AI Provider Error**: ${err.message}\n\nPlease check your Base URL (${config.baseUrl}) and API key in **Preferences → AI Provider** or via the AI toolbar gear icon.`,
          annotations: [],
        },
      ],
      messageId: assistantMessageId,
    };

    const errorAiRequest: AiRequest = {
      id: aiRequestId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userId: userId || 'local-user',
      status: 'ready',
      mode: mode || 'chat',
      error: null,
      output: [userMessage, errorAssistantMessage],
    };
    saveLocalAiRequest(errorAiRequest);
    return errorAiRequest;
  }
};

export const addMessageToAiRequest = async (
  getAuthorizationHeader: () => Promise<string>,
  {
    userId,
    aiRequestId,
    functionCallOutputs,
    userMessage,
    gameId,
    projectVersionIdBeforeMessage,
    payWithCredits,
    gameProjectJson,
    gameProjectJsonUserRelativeKey,
    projectSpecificExtensionsSummaryJson,
    projectSpecificExtensionsSummaryJsonUserRelativeKey,
    paused,
    mode,
    toolsVersion,
  }: {|
    userId: string,
    aiRequestId: string,
    userMessage: string,
    gameId?: string,
    projectVersionIdBeforeMessage?: string | null,
    functionCallOutputs: Array<AiRequestFunctionCallOutput>,
    payWithCredits: boolean,
    gameProjectJson: string | null,
    gameProjectJsonUserRelativeKey: string | null,
    projectSpecificExtensionsSummaryJson: string | null,
    projectSpecificExtensionsSummaryJsonUserRelativeKey: string | null,
    paused?: boolean,
    mode?: 'chat' | 'agent' | 'orchestrator',
    toolsVersion?: string,
  |}
): Promise<AiRequest> => {
  const config = getStoredAiConfig();
  const localHistory = getLocalAiHistory();
  let existingRequest = localHistory.find(r => r.id === aiRequestId);
  if (!existingRequest) {
    existingRequest = {
      id: aiRequestId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userId: userId || 'local-user',
      status: 'ready',
      mode: mode || 'chat',
      error: null,
      output: [],
    };
  }

  const userMessageId = 'msg_usr_' + Date.now();
  const assistantMessageId = 'msg_ast_' + (Date.now() + 1);

  const newUserMsg: AiRequestUserMessage = {
    type: 'message',
    status: 'completed',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: userMessage,
      },
    ],
    messageId: userMessageId,
  };

  const updatedOutput = [...(existingRequest.output || []), newUserMsg];

  try {
    const { assistantText } = await executeUniversalAiChat({
      userPrompt: userMessage,
      conversationHistory: updatedOutput,
      config,
    });

    const newAssistantMsg: AiRequestAssistantMessage = {
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          status: 'completed',
          text: assistantText,
          annotations: [],
        },
      ],
      messageId: assistantMessageId,
    };

    const updatedRequest: AiRequest = {
      ...existingRequest,
      updatedAt: new Date().toISOString(),
      status: 'ready',
      output: [...updatedOutput, newAssistantMsg],
    };

    saveLocalAiRequest(updatedRequest);
    return updatedRequest;
  } catch (err) {
    const errorAssistantMsg: AiRequestAssistantMessage = {
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          status: 'completed',
          text: `⚠️ **AI Provider Error**: ${err.message}`,
          annotations: [],
        },
      ],
      messageId: assistantMessageId,
    };
    const updatedRequest: AiRequest = {
      ...existingRequest,
      updatedAt: new Date().toISOString(),
      status: 'ready',
      output: [...updatedOutput, errorAssistantMsg],
    };
    saveLocalAiRequest(updatedRequest);
    return updatedRequest;
  }
};

export const suspendAiRequest = async (
  getAuthorizationHeader: () => Promise<string>,
  { userId, aiRequestId }: {| userId: string, aiRequestId: string |}
): Promise<AiRequest> => {
  const authorizationHeader = await getAuthorizationHeader();
  const response = await apiClient.post(
    `/ai-request/${aiRequestId}/action/suspend`,
    {},
    { params: { userId }, headers: { Authorization: authorizationHeader } }
  );
  return ensureObjectHasProperty({
    data: response.data,
    propertyName: 'id',
    endpointName: '/ai-request/{id}/action/suspend of Generation API',
  });
};

export const updateAiRequestMessage = async (
  getAuthorizationHeader: () => Promise<string>,
  {
    userId,
    aiRequestId,
    aiRequestMessageId,
    projectVersionIdBeforeMessage,
    projectVersionIdAfterMessage,
  }: {|
    userId: string,
    aiRequestId: string,
    aiRequestMessageId: string,
    projectVersionIdBeforeMessage?: ?string,
    projectVersionIdAfterMessage?: ?string,
  |}
): Promise<void> => {
  const authorizationHeader = await getAuthorizationHeader();
  await apiClient.patch(
    `/ai-request/${aiRequestId}/message/${aiRequestMessageId}`,
    {
      projectVersionIdBeforeMessage,
      projectVersionIdAfterMessage,
    },
    {
      params: {
        userId,
      },
      headers: {
        Authorization: authorizationHeader,
      },
    }
  );
};

export const sendAiRequestFeedback = async (
  getAuthorizationHeader: () => Promise<string>,
  {
    userId,
    aiRequestId,
    messageIndex,
    feedback,
    reason,
    freeFormDetails,
  }: {|
    userId: string,
    aiRequestId: string,
    messageIndex: number,
    feedback: 'like' | 'dislike',
    reason?: string,
    freeFormDetails?: string,
  |}
): Promise<AiRequest> => {
  const authorizationHeader = await getAuthorizationHeader();
  const response = await apiClient.post(
    `/ai-request/${aiRequestId}/action/set-feedback`,
    {
      gdevelopVersionWithHash: getIDEVersionWithHash(),
      messageIndex,
      feedback,
      reason,
      freeFormDetails,
    },
    {
      params: {
        userId,
      },
      headers: {
        Authorization: authorizationHeader,
      },
    }
  );
  return ensureObjectHasProperty({
    data: response.data,
    propertyName: 'id',
    endpointName: '/ai-request/{id}/action/set-feedback of Generation API',
  });
};

export const getAiRequestSuggestions = async (
  getAuthorizationHeader: () => Promise<string>,
  {
    userId,
    aiRequestId,
    suggestionsType,
    gameProjectJson,
    gameProjectJsonUserRelativeKey,
    projectSpecificExtensionsSummaryJson,
    projectSpecificExtensionsSummaryJsonUserRelativeKey,
  }: {|
    userId: string,
    aiRequestId: string,
    suggestionsType: 'simple-list' | 'list-with-explanations',
    gameProjectJson: string | null,
    gameProjectJsonUserRelativeKey: string | null,
    projectSpecificExtensionsSummaryJson: string | null,
    projectSpecificExtensionsSummaryJsonUserRelativeKey: string | null,
  |}
): Promise<AiRequest> => {
  const authorizationHeader = await getAuthorizationHeader();
  const response = await apiClient.post(
    `/ai-request/${aiRequestId}/action/get-suggestions`,
    {
      suggestionsType,
      gdevelopVersionWithHash: getIDEVersionWithHash(),
      gameProjectJson,
      gameProjectJsonUserRelativeKey,
      projectSpecificExtensionsSummaryJson,
      projectSpecificExtensionsSummaryJsonUserRelativeKey,
    },
    {
      params: {
        userId,
      },
      headers: {
        Authorization: authorizationHeader,
      },
    }
  );
  return ensureObjectHasProperty({
    data: response.data,
    propertyName: 'id',
    endpointName: '/ai-request/{id}/action/get-suggestions of Generation API',
  });
};

export type CreateAiGeneratedEventResult =
  | {|
      creationSucceeded: true,
      aiGeneratedEvent: AiGeneratedEvent,
    |}
  | {|
      creationSucceeded: false,
      errorMessage: string,
    |};

export const createAiGeneratedEvent = async (
  getAuthorizationHeader: () => Promise<string>,
  {
    userId,
    gameProjectJson,
    gameProjectJsonUserRelativeKey,
    projectSpecificExtensionsSummaryJson,
    projectSpecificExtensionsSummaryJsonUserRelativeKey,
    sceneName,
    eventsDescription,
    extensionNamesList,
    objectsList,
    existingEventsAsText,
    existingEventsJson,
    existingEventsJsonUserRelativeKey,
    placementHint,
    relatedAiRequestId,
    estimatedComplexity,
  }: {|
    userId: string,
    gameProjectJson: string | null,
    gameProjectJsonUserRelativeKey: string | null,
    projectSpecificExtensionsSummaryJson: string | null,
    projectSpecificExtensionsSummaryJsonUserRelativeKey: string | null,
    sceneName: string,
    eventsDescription: string,
    extensionNamesList: string,
    objectsList: string,
    existingEventsAsText: string,
    existingEventsJson: string | null,
    existingEventsJsonUserRelativeKey: string | null,
    placementHint: string | null,
    relatedAiRequestId: string,
    estimatedComplexity: number | null,
  |}
): Promise<CreateAiGeneratedEventResult> => {
  const authorizationHeader = await getAuthorizationHeader();
  const response = await apiClient.post(
    `/ai-generated-event`,
    {
      gdevelopVersionWithHash: getIDEVersionWithHash(),
      gameProjectJson,
      gameProjectJsonUserRelativeKey,
      projectSpecificExtensionsSummaryJson,
      projectSpecificExtensionsSummaryJsonUserRelativeKey,
      sceneName,
      eventsDescription,
      extensionNamesList,
      objectsList,
      existingEventsAsText,
      existingEventsJson,
      existingEventsJsonUserRelativeKey,
      placementHint,
      relatedAiRequestId,
      estimatedComplexity,
    },
    {
      params: {
        userId,
      },
      headers: {
        Authorization: authorizationHeader,
      },
      validateStatus: status => true,
    }
  );

  if (response.status === 200) {
    const data = ensureObjectHasProperty({
      data: response.data,
      propertyName: 'id',
      endpointName: '/ai-generated-event of Generation API',
    });
    return {
      creationSucceeded: true,
      aiGeneratedEvent: data,
    };
  } else if (response.status === 400) {
    // Report the failure to give a chance to the caller to save this message
    // and retry the generation in a different way.
    return {
      creationSucceeded: false,
      errorMessage: JSON.stringify(response.data),
    };
  }

  // Unexpected error: throw an exception as this can be something like a network error
  // or a server error.
  throw new Error(
    `Error while running AI event generation: ${response.statusText}`
  );
};

export const getAiGeneratedEvent = async (
  getAuthorizationHeader: () => Promise<string>,
  {
    userId,
    aiGeneratedEventId,
  }: {|
    userId: string,
    aiGeneratedEventId: string,
  |}
): Promise<AiGeneratedEvent> => {
  const authorizationHeader = await getAuthorizationHeader();
  const response = await apiClient.get(
    `/ai-generated-event/${aiGeneratedEventId}`,
    {
      params: {
        userId,
      },
      headers: {
        Authorization: authorizationHeader,
      },
    }
  );
  return ensureObjectHasProperty({
    data: response.data,
    propertyName: 'id',
    endpointName: '/ai-generated-event/{id} of Generation API',
  });
};

export const createAssetSearch = async (
  getAuthorizationHeader: () => Promise<string>,
  {
    userId,
    searchTerms,
    description,
    objectType,
    twoDimensionalViewKind,
    exactOrPartialAssetId,
    relatedAiRequestId,
    lastUserMessage,
    lastAssistantMessages,
  }: {|
    userId: string,
    searchTerms: string,
    description: string,
    objectType: string | null,
    twoDimensionalViewKind: string,
    exactOrPartialAssetId?: string | null,
    relatedAiRequestId?: string | null,
    lastUserMessage?: string | null,
    lastAssistantMessages?: string[],
  |}
): Promise<AssetSearch> => {
  const authorizationHeader = await getAuthorizationHeader();
  const response = await apiClient.post(
    `/asset-search`,
    {
      gdevelopVersionWithHash: getIDEVersionWithHash(),
      searchTerms,
      description,
      objectType,
      twoDimensionalViewKind,
      exactOrPartialAssetId,
      relatedAiRequestId,
      lastUserMessage,
      lastAssistantMessages,
    },
    {
      params: {
        userId,
      },
      headers: {
        Authorization: authorizationHeader,
      },
    }
  );
  return ensureObjectHasProperty({
    data: response.data,
    propertyName: 'id',
    endpointName: '/asset-search of Generation API',
  });
};

export const createResourceSearch = async (
  getAuthorizationHeader: () => Promise<string>,
  {
    userId,
    searchTerms,
    resourceKind,
  }: {|
    userId: string,
    searchTerms: string,
    resourceKind: string,
  |}
): Promise<ResourceSearch> => {
  const authorizationHeader = await getAuthorizationHeader();
  const response = await apiClient.post(
    `/resource-search`,
    {
      gdevelopVersionWithHash: getIDEVersionWithHash(),
      searchTerms,
      resourceKind,
    },
    {
      params: {
        userId,
      },
      headers: {
        Authorization: authorizationHeader,
      },
    }
  );
  return ensureObjectHasProperty({
    data: response.data,
    propertyName: 'id',
    endpointName: '/resource-search of Generation API',
  });
};

export type AiUserContentPresignedUrlsResult = {
  gameProjectJsonSignedUrl?: string,
  gameProjectJsonUserRelativeKey?: string,
  projectSpecificExtensionsSummaryJsonSignedUrl?: string,
  projectSpecificExtensionsSummaryJsonUserRelativeKey?: string,
  eventsJsonSignedUrl?: string,
  eventsJsonUserRelativeKey?: string,
};

export const createAiUserContentPresignedUrls = async (
  getAuthorizationHeader: () => Promise<string>,
  {
    userId,
    gameProjectJsonHash,
    projectSpecificExtensionsSummaryJsonHash,
    eventsJsonHash,
  }: {|
    userId: string,
    gameProjectJsonHash: string | null,
    projectSpecificExtensionsSummaryJsonHash: string | null,
    eventsJsonHash: string | null,
  |}
): Promise<AiUserContentPresignedUrlsResult> => {
  const authorizationHeader = await getAuthorizationHeader();
  const response = await apiClient.post(
    `/ai-user-content/action/create-presigned-urls`,
    {
      gdevelopVersionWithHash: getIDEVersionWithHash(),
      gameProjectJsonHash,
      projectSpecificExtensionsSummaryJsonHash,
      eventsJsonHash,
    },
    {
      params: {
        userId,
      },
      headers: {
        Authorization: authorizationHeader,
      },
    }
  );
  return ensureIsObject({
    data: response.data,
    endpointName:
      '/ai-user-content/action/create-presigned-urls of Generation API',
  });
};

export type AiConfigurationPreset = {|
  mode: 'chat' | 'agent' | 'orchestrator',
  id: string,
  nameByLocale: MessageByLocale,
  disabled: boolean,
  isDefault?: boolean,
|};

export type AiSettings = {
  aiRequest: {
    presets: Array<AiConfigurationPreset>,
  },
};

export const forkAiRequest = async (
  getAuthorizationHeader: () => Promise<string>,
  {
    userId,
    aiRequestId,
    upToMessageId,
  }: {|
    userId: string,
    aiRequestId: string,
    upToMessageId?: string,
  |}
): Promise<AiRequest> => {
  const authorizationHeader = await getAuthorizationHeader();
  const response = await apiClient.post(
    `/ai-request/${aiRequestId}/action/fork`,
    {
      upToMessageId,
    },
    {
      params: {
        userId,
      },
      headers: {
        Authorization: authorizationHeader,
      },
    }
  );
  return ensureObjectHasProperty({
    data: response.data,
    propertyName: 'id',
    endpointName: '/ai-request/{id}/action/fork of Generation API',
  });
};

export const fetchAiSettings = async ({
  environment,
}: {|
  environment: Environment,
|}): Promise<AiSettings> => {
  // $FlowFixMe[underconstrained-implicit-instantiation]
  const response = await axios.get(
    `${GDevelopAiCdn.baseUrl[environment]}/ai-settings.json`
  );
  return ensureObjectHasProperty({
    data: response.data,
    propertyName: 'aiRequest',
    endpointName: '/ai-settings.json of Generation API',
  });
};
