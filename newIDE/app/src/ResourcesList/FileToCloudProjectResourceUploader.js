// @flow
import { Trans } from '@lingui/macro';
import * as React from 'react';
import path from 'path-browserify';
import {
  allResourceKindsAndMetadata,
  type ChooseResourceOptions,
  type ResourceKind,
} from './ResourceSource';
import AuthenticatedUserContext from '../Profile/AuthenticatedUserContext';
import AlertMessage from '../UI/AlertMessage';
import { ColumnStackLayout, LineStackLayout } from '../UI/Layout';
import {
  type UploadedProjectResourceFiles,
  uploadProjectResourceFiles,
  PROJECT_RESOURCE_MAX_SIZE_IN_BYTES,
} from '../Utils/GDevelopServices/Project';
import { type StorageProvider, type FileMetadata } from '../ProjectsStorage';
import { Line, Column } from '../UI/Grid';
import LinearProgress from '../UI/LinearProgress';
import Paper from '../UI/Paper';
import GDevelopThemeContext from '../UI/Theme/GDevelopThemeContext';
import RaisedButton from '../UI/RaisedButton';

type FileToCloudProjectResourceUploaderProps = {|
  options: ChooseResourceOptions,
  fileMetadata: ?FileMetadata,
  getStorageProvider: () => StorageProvider,
  onChooseResources: (resources: Array<gdResource>) => void,
  createNewResource: () => gdResource,
  automaticallyOpenInput: boolean,
|};

const resourceKindToInputAcceptedMimes = {
  audio: ['audio/aac', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/ogg'],
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'],
  font: ['font/ttf', 'font/otf'],
  video: ['video/mp4', 'video/webm'],
  json: ['application/json'],
  tilemap: ['application/json'],
  tileset: ['application/json'],
  bitmapFont: [],
  model3D: [
    'file',
  ],
  atlas: [],
  spine: ['application/json'],
  javascript: ['text/javascript'],
};

const getAcceptedExtensions = (
  resourceKind: ResourceKind,
  withLeadingDot: boolean = true
): string[] => {
  const resourceKindMetadata =
    allResourceKindsAndMetadata.find(({ kind }) => kind === resourceKind) ||
    null;
  if (!resourceKindMetadata) return [];
  return withLeadingDot
    ? resourceKindMetadata.fileExtensions.map(extension => '.' + extension)
    : resourceKindMetadata.fileExtensions;
};

const getAcceptedMimeTypes = (resourceKind: ResourceKind): string[] => {
  // $FlowFixMe[incompatible-type]
  return resourceKindToInputAcceptedMimes[resourceKind] || [];
};

export const getInputAcceptedMimesAndExtensions = (
  resourceKind: ResourceKind
): string => {
  const acceptedExtensions = getAcceptedExtensions(resourceKind);
  const acceptedMimes = getAcceptedMimeTypes(resourceKind);
  return [...acceptedMimes, ...acceptedExtensions].join(',');
};

export const FileToCloudProjectResourceUploader = ({
  options,
  fileMetadata,
  getStorageProvider,
  onChooseResources,
  createNewResource,
  automaticallyOpenInput,
}: FileToCloudProjectResourceUploaderProps): React.Node => {
  const inputRef = React.useRef<?HTMLInputElement>(null);
  const hasAutomaticallyOpenedInput = React.useRef(false);
  const gdevelopTheme = React.useContext(GDevelopThemeContext);
  const authenticatedUser = React.useContext(AuthenticatedUserContext);
  const [error, setError] = React.useState<?Error>(null);
  const [isUploading, setIsUploading] = React.useState(false);
  const [selectedFiles, setSelectedFiles] = React.useState<File[]>([]);
  const [filteredOutFiles, setFilteredOutFiles] = React.useState<File[]>([]);
  const hasSelectedFiles = selectedFiles.length > 0;
  const storageProvider = React.useMemo(getStorageProvider, [
    getStorageProvider,
  ]);
  const cloudProjectId = fileMetadata ? fileMetadata.fileIdentifier : null;
  const [uploadProgress, setUploadProgress] = React.useState(0);

  const isCloudUpload =
    storageProvider.internalName === 'Cloud' &&
    !!cloudProjectId &&
    !!authenticatedUser.authenticated &&
    authenticatedUser.profile?.id !== 'local-horizons-user';

  const onUpload = React.useCallback(
    async () => {
      const input = inputRef.current;
      if (!input) return;
      if (selectedFiles.length === 0) return;

      if (isCloudUpload && cloudProjectId) {
        try {
          setIsUploading(true);
          setError(null);
          setUploadProgress(0);
          const results: UploadedProjectResourceFiles = await uploadProjectResourceFiles(
            authenticatedUser,
            cloudProjectId,
            selectedFiles,
            (current: number, total: number) => {
              setUploadProgress((current / total) * 100);
            }
          );

          const erroredResults = results.filter(({ error }) => !!error);
          const okResults = results.filter(({ url }) => !!url);
          if (erroredResults.length) {
            throw erroredResults[0];
          } else if (okResults.length) {
            onChooseResources(
              okResults.map(({ url, resourceFile }) => {
                const newResource = createNewResource();
                newResource.setFile(url || '');
                newResource.setName(resourceFile.name);
                newResource.setOrigin('cloud-project-resource', url || '');
                return newResource;
              })
            );
          }
        } catch (error) {
          setError(error);
        } finally {
          setIsUploading(false);
        }
      } else {
        // Offline / Local Device / No Account file loading via Data URL:
        try {
          setIsUploading(true);
          setError(null);
          setUploadProgress(0);
          const resources = await Promise.all(
            selectedFiles.map((file, index) => {
              return new Promise<gdResource>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                  const dataUrl = ((reader.result: any): string);
                  const newResource = createNewResource();
                  newResource.setFile(dataUrl);
                  newResource.setName(file.name);
                  newResource.setOrigin('local-file', file.name);
                  setUploadProgress(((index + 1) / selectedFiles.length) * 100);
                  resolve(newResource);
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
              });
            })
          );
          onChooseResources(resources);
        } catch (err) {
          setError(err);
        } finally {
          setIsUploading(false);
        }
      }
    },
    [
      selectedFiles,
      authenticatedUser,
      onChooseResources,
      createNewResource,
      cloudProjectId,
      isCloudUpload,
    ]
  );

  const invalidFiles = selectedFiles
    .map(file => {
      if (file.size > PROJECT_RESOURCE_MAX_SIZE_IN_BYTES) {
        return {
          filename: file.name,
          error: 'too-large',
        };
      }
      return null;
    })
    .filter(Boolean);

  const canChooseFiles = !isUploading;

  // Automatically open the input once, at the first render, if asked.
  React.useLayoutEffect(
    () => {
      if (automaticallyOpenInput && !hasAutomaticallyOpenedInput.current) {
        hasAutomaticallyOpenedInput.current = true;
        if (inputRef.current) inputRef.current.click();
      }
    },
    [automaticallyOpenInput]
  );

  // Start uploading/loading after choosing some files.
  const canUploadFiles =
    !isUploading &&
    canChooseFiles &&
    hasSelectedFiles &&
    invalidFiles.length === 0;

  React.useEffect(
    () => {
      if (canUploadFiles && !error) {
        onUpload();
      }
    },
    [canUploadFiles, onUpload, error]
  );

  const shouldValidateFilePostPicking = React.useMemo(
    () => {
      const acceptedMimeTypes = getAcceptedMimeTypes(options.resourceKind);
      return acceptedMimeTypes.length === 1 && acceptedMimeTypes[0] === 'file';
    },
    [options.resourceKind]
  );

  const validateFilePostPicking = React.useCallback(
    (file: File) => {
      const acceptedExtensions = getAcceptedExtensions(
        options.resourceKind,
        false
      );
      return acceptedExtensions.includes(
        path.extname(file.name).replace(/^\./, '')
      );
    },
    [options.resourceKind]
  );

  return (
    <ColumnStackLayout noMargin>
      {!isCloudUpload && (
        <AlertMessage kind="info">
          <Trans>
            Local device storage: files are embedded directly in your project. No account or upload required.
          </Trans>
        </AlertMessage>
      )}
      <Paper variant="outlined" background="medium">
        <Line expand>
          <Column expand>
            <input
              accept={getInputAcceptedMimesAndExtensions(options.resourceKind)}
              style={{
                color: gdevelopTheme.text.color.primary,
              }}
              multiple={options.multiSelection}
              type="file"
              ref={inputRef}
              disabled={!canChooseFiles}
              onChange={event => {
                const files = [];
                const newFilteredOutFiles = [];
                for (let i = 0; i < event.currentTarget.files.length; i++) {
                  const selectedFile = event.currentTarget.files[i];
                  if (
                    !shouldValidateFilePostPicking ||
                    validateFilePostPicking(selectedFile)
                  ) {
                    files.push(selectedFile);
                  } else {
                    newFilteredOutFiles.push(selectedFile);
                  }
                }
                setFilteredOutFiles(newFilteredOutFiles);
                setSelectedFiles(files);
                setError(null);
              }}
            />
            {filteredOutFiles.length > 0 && (
              <AlertMessage kind="warning">
                <Trans>
                  The following file(s) cannot be used for this kind of object:{' '}
                  {filteredOutFiles.map(file => file.name).join(', ')}
                </Trans>
              </AlertMessage>
            )}
          </Column>
        </Line>
      </Paper>
      {invalidFiles.map(erroredFile => {
        if (erroredFile.error === 'too-large')
          return (
            <AlertMessage kind="error">
              <Trans>
                The file {erroredFile.filename} is too large. Use files that are
                smaller for your game: each must be less than{' '}
                {PROJECT_RESOURCE_MAX_SIZE_IN_BYTES / 1000 / 1000} MB.
              </Trans>
            </AlertMessage>
          );
        return (
          <AlertMessage kind="error">
            <Trans>The file {erroredFile.filename} is invalid.</Trans>
          </AlertMessage>
        );
      })}
      {error && (
        <AlertMessage kind="error">
          <Trans>
            There was an error while loading resources: {error.message || 'Unknown error'}
          </Trans>
        </AlertMessage>
      )}
      <LineStackLayout alignItems="center" justifyContent="stretch" expand>
        {isUploading ? (
          <LinearProgress value={uploadProgress} variant="determinate" />
        ) : null}
      </LineStackLayout>
      {error && (
        <Line noMargin expand justifyContent="flex-end">
          <RaisedButton
            primary
            label={<Trans>Retry</Trans>}
            onClick={onUpload}
          />
        </Line>
      )}
    </ColumnStackLayout>
  );
};
export default FileToCloudProjectResourceUploader;
