// @flow
import { t } from '@lingui/macro';
import * as React from 'react';
import { type StorageProvider, type SaveAsLocation } from '../index';
import { type MessageDescriptor } from '../../Utils/i18n/MessageDescriptor.flow';
import {
  type ShowAlertFunction,
  type ShowConfirmFunction,
} from '../../UI/Alert/AlertContext';
import { type FileMetadata } from '../index';
import { type SaveProjectOptions } from '../index';
import Smartphone from '../../UI/CustomSvgIcons/Smartphone';
import { serializeToJSON } from '../../Utils/Serializer';
import { serializeToJSONInBackground } from '../../Utils/BackgroundSerializer';
import {
  type LocalProjectRecord,
  generateLocalProjectId,
  AUTOSAVE_SUFFIX,
  listProjects,
  getProject,
  putProject,
  putAutosave,
  getAutosave,
} from './LocalProjectsIndexedDB';
import {
  LocalProjectsPickerDialog,
  LocalProjectSaveAsDialog,
} from './LocalProjectsPickerDialog';
import { convertBlobToDataURL } from '../../Utils/BlobDownloader';

/**
 * Horizons: resources created/edited during the session (Piskel, Jfxr, Yarn
 * editors, imported images) are stored as transient `blob:` URLs. Those die
 * as soon as the app closes — convert them to self-contained `data:` URLs
 * before saving so the project works after it is re-opened.
 */
const persistBlobUrlResources = async (project: gdProject): Promise<void> => {
  try {
    const resourcesManager = project.getResourcesManager();
    const resourcesNames = resourcesManager.getAllResourceNames().toJSArray();
    await Promise.all(
      resourcesNames.map(async resourceName => {
        try {
          const resource = resourcesManager.getResource(resourceName);
          const file = resource.getFile();
          if (!file || file.indexOf('blob:') !== 0) return;
          const response = await fetch(file);
          const blob = await response.blob();
          const dataUrl = await convertBlobToDataURL(blob);
          resource.setFile(dataUrl);
        } catch (error) {
          console.error(
            `Unable to persist the resource "${resourceName}" (blob URL could not be read). It will be lost after the app restarts.`,
            error
          );
        }
      })
    );
  } catch (error) {
    console.error('Unable to persist blob URL resources.', error);
  }
};

const serializeProject = async (project: gdProject): Promise<string> => {
  try {
    // Serializes in a background worker: avoids freezing the editor UI
    // while big projects are saved.
    return await serializeToJSONInBackground(project);
  } catch (error) {
    console.warn(
      'Background serialization failed, falling back to regular serialization.',
      error
    );
  }
  return serializeToJSON(project);
};

const saveRecordToMetadata = (record: LocalProjectRecord): FileMetadata => ({
  fileIdentifier: record.id,
  name: record.name,
  lastModifiedDate: record.lastModifiedDate,
});

/**
 * Storage provider saving projects in the browser/device IndexedDB storage.
 * Perfect for offline usage: no account needed, no limit on the number
 * of projects, and everything stays on the device.
 */
export default ({
  internalName: 'LocalDevice',
  name: t`Save on this device`,
  renderIcon: props => <Smartphone fontSize={props.size} />,
  getProjectLocation: ({
    projectName,
  }: {|
    projectName: string,
    saveAsLocation: ?SaveAsLocation,
    newProjectsDefaultFolder?: string,
  |}) => ({
    fileIdentifier: generateLocalProjectId(),
    name: projectName,
  }),
  renderNewProjectSaveAsLocationChooser: ({
    projectName,
    saveAsLocation,
    setSaveAsLocation,
  }: {|
    projectName: string,
    saveAsLocation: ?SaveAsLocation,
    setSaveAsLocation: (?SaveAsLocation) => void,
    newProjectsDefaultFolder?: string,
  |}): React.Node => null, // The default project name input is enough for device storage.
  createOperations: ({ setDialog, closeDialog }) => ({
    onOpenWithPicker: (): Promise<?FileMetadata> => {
      return new Promise(resolve => {
        setDialog(() => (
          <LocalProjectsPickerDialog
            onOpen={record => {
              closeDialog();
              resolve(saveRecordToMetadata(record));
            }}
            onClose={() => {
              closeDialog();
              resolve(null);
            }}
          />
        ));
      });
    },
    onOpen: async (
      fileMetadata: FileMetadata,
      onProgress?: (progress: number, message: MessageDescriptor) => void
    ) => {
      const isAutosave = fileMetadata.fileIdentifier.endsWith(AUTOSAVE_SUFFIX);
      const id = isAutosave
        ? fileMetadata.fileIdentifier.slice(
            0,
            fileMetadata.fileIdentifier.length - AUTOSAVE_SUFFIX.length
          )
        : fileMetadata.fileIdentifier;
      const record = isAutosave ? await getAutosave(id) : await getProject(id);
      if (!record) {
        throw new Error(
          'Could not find the project on this device: ' +
            fileMetadata.fileIdentifier
        );
      }
      return { content: JSON.parse(record.content) };
    },
    getOpenErrorMessage: (error: Error): MessageDescriptor =>
      t`Check that the project is still saved on this device and that your browser did not erase its storage (this can happen if the device is out of space).`,
    getWriteErrorMessage: (error: Error): MessageDescriptor => {
      const message = error && error.message ? error.message : '';
      if (message.indexOf('quota') !== -1) {
        return t`Not enough space left on this device to save the project. Free some space (or delete old projects) and try again.`;
      }
      return t`Could not save the project on this device. Check that your browser storage is not full or private (incognito) and try again.`;
    },
    onSaveProject: async (
      project: gdProject,
      fileMetadata: FileMetadata,
      options?: SaveProjectOptions,
      actions: {|
        showAlert: ShowAlertFunction,
        showConfirmation: ShowConfirmFunction,
      |}
    ) => {
      await persistBlobUrlResources(project);
      const content = await serializeProject(project);
      const now = Date.now();
      const record: LocalProjectRecord = {
        id: fileMetadata.fileIdentifier,
        name: project.getName(),
        lastModifiedDate: now,
        content,
      };
      await putProject(record);
      return {
        wasSaved: true,
        fileMetadata: {
          ...fileMetadata,
          name: record.name,
          lastModifiedDate: now,
        },
      };
    },
    onChooseSaveProjectAsLocation: (options: {|
      project: gdProject,
      fileMetadata: ?FileMetadata,
      displayOptionToGenerateNewProjectUuid: boolean,
    |}) => {
      const { project } = options;
      return new Promise(resolve => {
        setDialog(() => (
          <LocalProjectSaveAsDialog
            initialName={project.getName()}
            onCancel={() => {
              closeDialog();
              resolve({ saveAsLocation: null, saveAsOptions: null });
            }}
            onDone={name => {
              closeDialog();
              resolve({
                saveAsLocation: {
                  fileIdentifier: generateLocalProjectId(),
                  name,
                },
                saveAsOptions: {
                  generateNewProjectUuid: true,
                  setProjectNameFromLocation: false,
                },
              });
            }}
          />
        ));
      });
    },
    onSaveProjectAs: async (
      project: gdProject,
      saveAsLocation: ?SaveAsLocation,
      options: {|
        onStartSaving: () => void,
        onMoveResources: ({|
          newFileMetadata: FileMetadata,
        |}) => Promise<void>,
      |}
    ) => {
      let name =
        saveAsLocation && saveAsLocation.name
          ? saveAsLocation.name
          : project.getName();
      let fileIdentifier =
        saveAsLocation && saveAsLocation.fileIdentifier
          ? saveAsLocation.fileIdentifier
          : generateLocalProjectId();

      options.onStartSaving();
      const newFileMetadata: FileMetadata = {
        fileIdentifier,
        name,
      };
      try {
        await options.onMoveResources({ newFileMetadata });
      } catch (error) {
        // Resources are mostly public URLs on the web - do not block saving
        // if moving them is not possible.
        console.error('Unable to move resources to the device storage:', error);
      }
      await persistBlobUrlResources(project);
      if (name !== project.getName()) {
        project.setName(name);
      }
      const content = await serializeProject(project);
      const now = Date.now();
      const record: LocalProjectRecord = {
        id: fileIdentifier,
        name: project.getName(),
        lastModifiedDate: now,
        content,
      };
      await putProject(record);
      return {
        wasSaved: true,
        fileMetadata: {
          fileIdentifier,
          name: record.name,
          lastModifiedDate: now,
        },
      };
    },
    canFileMetadataBeSafelySavedAs: async () => true,
    onChangeProjectProperty: async (
      project: gdProject,
      fileMetadata: FileMetadata,
      properties: {| name?: string, gameId?: string |}
    ) => {
      // Keep the name shown in the projects list in sync with the project.
      if (properties.name) {
        const existingRecord = await getProject(fileMetadata.fileIdentifier);
        if (existingRecord) {
          await putProject({
            ...existingRecord,
            name: properties.name,
          });
        }
      }
      return null;
    },
    onAutoSaveProject: async (
      project: gdProject,
      fileMetadata: FileMetadata
    ) => {
      const content = await serializeProject(project);
      await putAutosave({
        id: fileMetadata.fileIdentifier,
        name: project.getName(),
        lastModifiedDate: Date.now(),
        content,
      });
    },
    getAutoSaveCreationDate: async (
      fileMetadata: FileMetadata,
      compareLastModified: boolean
    ): Promise<?number> => {
      try {
        const autosave = await getAutosave(fileMetadata.fileIdentifier);
        if (!autosave) return null;
        if (!compareLastModified) return autosave.lastModifiedDate;
        const savedRecord = await getProject(fileMetadata.fileIdentifier);
        const savedTime = savedRecord ? savedRecord.lastModifiedDate : 0;
        // Same 5 seconds margin as the desktop version to avoid showing
        // the warning just after a regular save.
        return autosave.lastModifiedDate > savedTime + 5000
          ? autosave.lastModifiedDate
          : null;
      } catch (error) {
        console.error('Unable to read the autosave on this device:', error);
        return null;
      }
    },
    onGetAutoSave: (fileMetadata: FileMetadata): Promise<FileMetadata> => {
      return Promise.resolve({
        ...fileMetadata,
        fileIdentifier: fileMetadata.fileIdentifier + AUTOSAVE_SUFFIX,
      });
    },
  }),
}: StorageProvider);

/** Exported for tests or advanced tooling (e.g. extra AI panels). */
export { listProjects as listLocalProjects };
