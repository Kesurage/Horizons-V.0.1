// @flow
import { Trans, t } from '@lingui/macro';
import * as React from 'react';
import Dialog, { DialogPrimaryButton } from '../UI/Dialog';
import FlatButton from '../UI/FlatButton';
import RaisedButton from '../UI/RaisedButton';
import Text from '../UI/Text';
import AlertMessage from '../UI/AlertMessage';
import { ColumnStackLayout, LineStackLayout } from '../UI/Layout';
import { Column, Line } from '../UI/Grid';
import { Tabs } from '../UI/Tabs';
import {
  listProjects,
  deleteProject,
  type LocalProjectRecord,
} from './LocalStorageProvider/LocalProjectsIndexedDB';
import { saveBlobToUserChosenPath } from '../Utils/SaveFilePicker';

/**
 * Save a blob to the location the user chooses (File System Access API when
 * available), falling back to a browser download.
 */
const saveBlobAsFile = async (blob: Blob, filename: string) => {
  await saveBlobToUserChosenPath(blob, filename);
};

const WORKSPACE_IDB_NAME = 'horizons-workspace';
const WORKSPACE_IDB_STORE = 'handles';

const openWorkspaceDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(WORKSPACE_IDB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(WORKSPACE_IDB_STORE)) {
        db.createObjectStore(WORKSPACE_IDB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const saveWorkspaceHandle = async (handle: any): Promise<void> => {
  const db = await openWorkspaceDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(WORKSPACE_IDB_STORE, 'readwrite');
    tx.objectStore(WORKSPACE_IDB_STORE).put(handle, 'workspace');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

const loadWorkspaceHandle = async (): Promise<any> => {
  try {
    const db = await openWorkspaceDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(WORKSPACE_IDB_STORE, 'readonly');
      const request = tx.objectStore(WORKSPACE_IDB_STORE).get('workspace');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    return null;
  }
};

const clearWorkspaceHandle = async (): Promise<void> => {
  try {
    const db = await openWorkspaceDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(WORKSPACE_IDB_STORE, 'readwrite');
      tx.objectStore(WORKSPACE_IDB_STORE).delete('workspace');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    // Ignore
  }
};

const supportsFileSystemAccess = (): boolean =>
  typeof window !== 'undefined' &&
  // $FlowFixMe[cannot-resolve-name]
  typeof window.showDirectoryPicker === 'function';

const formatBytes = (bytes: number): string => {
  if (!bytes && bytes !== 0) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

type WorkspaceEntry = {|
  name: string,
  path: string,
  kind: 'file' | 'directory',
  size: ?number,
|};

const WorkspaceSection = ({
  project,
}: {|
  project: ?gdProject,
|}): React.Node => {
  const [supported] = React.useState(supportsFileSystemAccess);
  const [handle, setHandle] = React.useState<any>(null);
  const [entries, setEntries] = React.useState<Array<WorkspaceEntry>>([]);
  const [error, setError] = React.useState<?string>(null);
  const [busy, setBusy] = React.useState<boolean>(false);

  const refreshEntries = React.useCallback(async (dirHandle: any) => {
    if (!dirHandle) {
      setEntries([]);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const found: Array<WorkspaceEntry> = [];
      let count = 0;
      // $FlowFixMe[unsupported-syntax]
      for await (const entry of dirHandle.values()) {
        if (count >= 200) break;
        let size = null;
        if (entry.kind === 'file') {
          try {
            const file = await entry.getFile();
            size = file.size;
          } catch (ignored) {}
        }
        found.push({
          name: entry.name,
          path: `${dirHandle.name}/${entry.name}`,
          kind: entry.kind,
          size,
        });
        count += 1;
      }
      found.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
      setEntries(found);
    } catch (dirError) {
      setError(
        (dirError && dirError.message) || 'Could not read the folder contents.'
      );
    }
    setBusy(false);
  }, []);

  React.useEffect(() => {
    (async () => {
      if (!supported) return;
      const storedHandle = await loadWorkspaceHandle();
      if (storedHandle) {
        try {
          const permission = await storedHandle.queryPermission({
            mode: 'readwrite',
          });
          setHandle(storedHandle);
          if (permission === 'granted') refreshEntries(storedHandle);
        } catch (ignored) {
          // Handle no longer valid (folder moved/deleted)
        }
      }
    })();
  }, [refreshEntries, supported]);

  const handleChooseFolder = async () => {
    setError(null);
    try {
      // $FlowFixMe[cannot-resolve-name]
      const dirHandle = await window.showDirectoryPicker({
        mode: 'readwrite',
        id: 'horizons-workspace',
        startIn: 'documents',
      });
      await saveWorkspaceHandle(dirHandle);
      setHandle(dirHandle);
      await refreshEntries(dirHandle);
    } catch (pickError) {
      if (pickError && pickError.name !== 'AbortError') {
        setError(
          (pickError && pickError.message) || 'Could not open the folder.'
        );
      }
    }
  };

  const handleGrantAndRefresh = async () => {
    if (!handle) return;
    try {
      const permission = await handle.requestPermission({ mode: 'readwrite' });
      if (permission === 'granted') refreshEntries(handle);
      else setError('Permission to read the folder was denied.');
    } catch (permissionError) {
      setError(
        (permissionError && permissionError.message) || 'Permission error.'
      );
    }
  };

  const handleForget = async () => {
    await clearWorkspaceHandle();
    setHandle(null);
    setEntries([]);
  };

  const handleSaveProjectCopy = async (project: ?gdProject) => {
    if (!project || !handle) return;
    setBusy(true);
    try {
      const serialized = JSON.stringify(project.serializeToJson());
      const safeName =
        (project.getName() || 'game').replace(/[^a-z0-9_\- ]/gi, '_') || 'game';
      const fileName = `${safeName}.json`;
      const fileHandle = await handle.getFileHandle(fileName, {
        create: true,
      });
      const writable = await fileHandle.createWritable();
      await writable.write(serialized);
      await writable.close();
      await refreshEntries(handle);
    } catch (saveError) {
      setError(
        (saveError && saveError.message) || 'Could not write the project copy.'
      );
    }
    setBusy(false);
  };

  return (
    <ColumnStackLayout noMargin>
      {!supported ? (
        <AlertMessage kind="info">
          <Trans>
            This device/browser does not support choosing a working folder
            (File System Access API). You can still export files with the
            download buttons — they land in your Downloads folder. In the
            Horizons Android app on Chrome-based WebViews, use "Save project
            copy" to download the .json, or use the desktop browser for full
            folder access.
          </Trans>
        </AlertMessage>
      ) : !handle ? (
        <AlertMessage kind="info">
          <Trans>
            Choose a working folder — Horizons will keep project copies and
            exported files there, so you control where your work lives.
          </Trans>
        </AlertMessage>
      ) : (
        <AlertMessage kind="success">
          <Trans>
            Working folder: <b>{handle.name}</b>
          </Trans>
        </AlertMessage>
      )}

      <LineStackLayout noMargin>
        {supported && (
          <RaisedButton
            primary
            label={handle ? <Trans>Change folder…</Trans> : <Trans>Choose folder…</Trans>}
            onClick={handleChooseFolder}
            disabled={busy}
          />
        )}
        {supported && handle && (
          <>
            <FlatButton
              label={<Trans>Refresh</Trans>}
              onClick={handleGrantAndRefresh}
              disabled={busy}
            />
            <FlatButton
              label={<Trans>Forget folder</Trans>}
              onClick={handleForget}
              disabled={busy}
            />
          </>
        )}
      </LineStackLayout>

      {handle && project && (
        <RaisedButton
          primary
          label={<Trans>Save project copy to folder</Trans>}
          onClick={() => handleSaveProjectCopy(project)}
          disabled={busy}
        />
      )}

      {error && <AlertMessage kind="error">{error}</AlertMessage>}

      {handle && (
        <ColumnStackLayout noMargin>
          <Text size="sub-title">
            <Trans>Folder contents (top level)</Trans>
          </Text>
          {entries.length === 0 ? (
            <Text size="body-small">
              <Trans>{busy ? 'Reading folder…' : 'Empty folder.'}</Trans>
            </Text>
          ) : (
            <div
              style={{
                maxHeight: 260,
                overflowY: 'auto',
                border: '1px solid rgba(0,0,0,0.12)',
                borderRadius: 8,
                padding: 8,
              }}
            >
              {entries.map(entry => (
                <Line key={entry.path} noMargin>
                  <Text displayInlineAsSpan size="body-small" noMargin>
                    {entry.kind === 'directory' ? '📁' : '📄'} {entry.name}
                    {entry.kind === 'file' && entry.size != null
                      ? ` — ${formatBytes(entry.size)}`
                      : ''}
                  </Text>
                </Line>
              ))}
            </div>
          )}
        </ColumnStackLayout>
      )}
    </ColumnStackLayout>
  );
};

const LocalProjectsSection = (): React.Node => {
  const [projects, setProjects] = React.useState<Array<LocalProjectRecord>>([]);
  const [loading, setLoading] = React.useState<boolean>(true);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const records = await listProjects();
      records.sort((a, b) => b.lastModifiedDate - a.lastModifiedDate);
      setProjects(records.slice(0, 50));
    } catch (error) {
      setProjects([]);
    }
    setLoading(false);
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const handleDownload = (record: LocalProjectRecord) => {
    try {
      const blob = new Blob([record.content], {
        type: 'application/json',
      });
      saveBlobAsFile(blob, `${record.name || 'project'}.json`);
    } catch (error) {
      // Ignore
    }
  };

  const handleDelete = async (record: LocalProjectRecord) => {
    // eslint-disable-next-line no-alert
    const confirmed = window.confirm(
      `Delete the local copy of "${record.name}"? This cannot be undone.`
    );
    if (!confirmed) return;
    await deleteProject(record.id);
    refresh();
  };

  return (
    <ColumnStackLayout noMargin>
      <Text size="body-small">
        <Trans>
          Game projects saved on this device (offline local saves). Download
          them as .json backups, or delete old copies to free space.
        </Trans>
      </Text>
      {loading ? (
        <Text size="body-small">
          <Trans>Loading local projects…</Trans>
        </Text>
      ) : projects.length === 0 ? (
        <Text size="body-small">
          <Trans>No local projects yet. Save a project with "Save to this device" to see it here.</Trans>
        </Text>
      ) : (
        <div
          style={{
            maxHeight: 300,
            overflowY: 'auto',
            border: '1px solid rgba(0,0,0,0.12)',
            borderRadius: 8,
            padding: 8,
          }}
        >
          {projects.map(record => (
            <Line key={record.id} noMargin alignItems="center">
              <Column expand noMargin>
                <Text displayInlineAsSpan size="body-small" noMargin>
                  🎮 {record.name} — {formatBytes(record.content.length)} —{' '}
                  {new Date(record.lastModifiedDate).toLocaleString()}
                </Text>
              </Column>
              <FlatButton
                label={<Trans>Download</Trans>}
                onClick={() => handleDownload(record)}
              />
              <FlatButton
                label={<Trans>Delete</Trans>}
                onClick={() => handleDelete(record)}
              />
            </Line>
          ))}
        </div>
      )}
    </ColumnStackLayout>
  );
};

const ResourcesSection = ({ project }: {| project: ?gdProject |}): React.Node => {
  const [resourceNames, setResourceNames] = React.useState<Array<string>>([]);

  React.useEffect(() => {
    try {
      if (!project) {
        setResourceNames([]);
        return;
      }
      const names = project
        .getResourcesManager()
        .getAllResourceNames()
        .toJSArray();
      setResourceNames(names.slice(0, 150));
    } catch (error) {
      setResourceNames([]);
    }
  }, [project]);

  const handleDownload = async (resourceName: string) => {
    try {
      if (!project) return;
      const resource = project.getResourcesManager().getResource(resourceName);
      const fileMetadata = resource.getFile();
      if (!fileMetadata) return;
      if (/^https?:\/\//i.test(fileMetadata)) {
        const response = await fetch(fileMetadata);
        const blob = await response.blob();
        const extension = (fileMetadata.split('.').pop() || 'bin').split('?')[0];
        saveBlobAsFile(blob, `${resourceName}.${extension}`);
      } else {
        // Local/embedded resource: cannot be downloaded as a standalone file.
        window.alert(
          `Resource "${resourceName}" is embedded in the project (${fileMetadata}). Export the game to get the packaged file.`
        );
      }
    } catch (error) {
      window.alert(
        `Could not download resource: ${(error && error.message) || 'unknown error'}`
      );
    }
  };

  return (
    <ColumnStackLayout noMargin>
      <Text size="body-small">
        <Trans>
          Assets used by the current project (images, sounds, fonts, videos…).
          Download any online asset to inspect or back it up.
        </Trans>
      </Text>
      {!project ? (
        <Text size="body-small">
          <Trans>Open a project to see its assets.</Trans>
        </Text>
      ) : resourceNames.length === 0 ? (
        <Text size="body-small">
          <Trans>This project does not use any external asset yet.</Trans>
        </Text>
      ) : (
        <div
          style={{
            maxHeight: 300,
            overflowY: 'auto',
            border: '1px solid rgba(0,0,0,0.12)',
            borderRadius: 8,
            padding: 8,
          }}
        >
          {resourceNames.map(name => {
            let info = '';
            try {
              const resource = project.getResourcesManager().getResource(name);
              info = resource.getFile() || '';
            } catch (ignored) {}
            return (
              <Line key={name} noMargin alignItems="center">
                <Column expand noMargin>
                  <Text displayInlineAsSpan size="body-small" noMargin>
                    🖼 {name}
                    {info ? ` — ${info.slice(0, 70)}` : ''}
                  </Text>
                </Column>
                <FlatButton
                  label={<Trans>Download</Trans>}
                  onClick={() => handleDownload(name)}
                />
              </Line>
            );
          })}
        </div>
      )}
    </ColumnStackLayout>
  );
};

type Props = {|
  open: boolean,
  onClose: () => void,
  project: ?gdProject,
|};

/**
 * Horizons file manager: working folder picker (File System Access API),
 * local project saves browser, and current project assets browser.
 */
export const FileManagerDialog = ({
  open,
  onClose,
  project,
}: Props): React.Node => {
  const [currentTab, setCurrentTab] = React.useState('workspace');
  const [storageEstimate, setStorageEstimate] = React.useState<?{
    usage: number,
    quota: number,
  }>(null);

  React.useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        if (navigator.storage && navigator.storage.estimate) {
          const estimate = await navigator.storage.estimate();
          setStorageEstimate({
            usage: estimate.usage || 0,
            quota: estimate.quota || 0,
          });
        }
      } catch (ignored) {}
    })();
  }, [open]);

  return (
    <Dialog
      title={<Trans>Files & Workspace</Trans>}
      open={open}
      onRequestClose={onClose}
      maxWidth="md"
      actions={[
        <DialogPrimaryButton
          key="done"
          label={<Trans>Done</Trans>}
          primary
          onClick={onClose}
        />,
      ]}
    >
      <ColumnStackLayout noMargin>
        {storageEstimate && storageEstimate.quota > 0 && (
          <AlertMessage kind="info">
            <Trans>
              Device storage used by Horizons: {formatBytes(storageEstimate.usage)}{' '}
              of {formatBytes(storageEstimate.quota)} available quota.
            </Trans>
          </AlertMessage>
        )}

        <Tabs
          value={currentTab}
          onChange={setCurrentTab}
          options={[
            { label: <Trans>Working folder</Trans>, value: 'workspace' },
            { label: <Trans>Local projects</Trans>, value: 'projects' },
            { label: <Trans>Project assets</Trans>, value: 'resources' },
          ]}
        />

        {currentTab === 'workspace' && <WorkspaceSection project={project} />}
        {currentTab === 'projects' && <LocalProjectsSection />}
        {currentTab === 'resources' && <ResourcesSection project={project} />}
      </ColumnStackLayout>
    </Dialog>
  );
};

export default FileManagerDialog;
