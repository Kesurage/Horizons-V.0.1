// @flow
import * as React from 'react';

type Props = {|
  onStartNewChat: () => void,
  canStartNewChat: boolean,
  onOpenHistory: () => void,
  onOpenAiSettings?: () => void,
|};

/**
 * V0.3.1: the built-in AI team (BYOK chat with GLM/Gemini keys) was removed
 * — its toolbar (new chat, history, provider settings, status chip) went
 * with it. The Agent Bridge panel needs no toolbar: everything lives in the
 * panel itself. This renders nothing so the container stays unchanged.
 */
export const Toolbar = (props: Props): React.Node => null;
