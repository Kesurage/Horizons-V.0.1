// @flow
import * as React from 'react';
import { setAgentBridgeContext } from './AgentBridgeServer';

/**
 * Mounted once in the MainFrame render tree. Keeps the Agent Bridge API
 * context fresh: the current project, the save routine and the editor
 * refresh callbacks — so an external agent always works on the project
 * that is actually opened, and the UI reacts to its changes.
 */
type Props = {|
  project: any | null,
  onSave: ?(() => Promise<any>),
  openLayout: ?(name: string, options?: any) => void,
  onSceneEventsModifiedOutsideEditor: ?(changes: any) => void,
  onInstancesModifiedOutsideEditor: ?(changes: any) => void,
  onObjectsModifiedOutsideEditor: ?(changes: any) => void,
  onObjectGroupsModifiedOutsideEditor: ?(changes: any) => void,
  onExtensionInstalled: ?(extensionNames: Array<string>) => void,
|};

const AgentBridgeContextSync = (props: Props) => {
  React.useEffect(() => {
    setAgentBridgeContext({
      project: props.project,
      onSave: props.onSave,
      openLayout: props.openLayout,
      onSceneEventsModifiedOutsideEditor: props.onSceneEventsModifiedOutsideEditor,
      onInstancesModifiedOutsideEditor: props.onInstancesModifiedOutsideEditor,
      onObjectsModifiedOutsideEditor: props.onObjectsModifiedOutsideEditor,
      onObjectGroupsModifiedOutsideEditor: props.onObjectGroupsModifiedOutsideEditor,
      onExtensionInstalled: props.onExtensionInstalled,
    });
  }, [
    props.project,
    props.onSave,
    props.openLayout,
    props.onSceneEventsModifiedOutsideEditor,
    props.onInstancesModifiedOutsideEditor,
    props.onObjectsModifiedOutsideEditor,
    props.onObjectGroupsModifiedOutsideEditor,
    props.onExtensionInstalled,
  ]);
  return null;
};

export default AgentBridgeContextSync;
