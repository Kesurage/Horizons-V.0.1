// @flow
import { openBlobDownloadUrl } from './BlobDownloadUrlHolder';

/**
 * Horizons: save files wherever the user actually wants, using the File
 * System Access API when available (real "Save as…" dialog with a chosen
 * folder), falling back to the classic browser download.
 */

const EXTENSION_TO_MIME: { [string]: string } = {
  zip: 'application/zip',
  json: 'application/json',
  txt: 'text/plain',
  html: 'text/html',
  csv: 'text/csv',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webm: 'video/webm',
  mp4: 'video/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
};

const buildPickerTypes = (filename: string): Array<any> => {
  const extension = filename.includes('.')
    ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
    : '';
  const mime = EXTENSION_TO_MIME[extension];
  if (!mime) return [];
  return [
    {
      description: `${extension.toUpperCase()} file`,
      accept: { [mime]: [`.${extension}`] },
    },
  ];
};

export const supportsSaveFilePicker = (): boolean =>
  typeof window !== 'undefined' &&
  typeof ((window: any).showSaveFilePicker) === 'function';

/**
 * Save a blob to a location chosen by the user.
 * Returns the filename that was used (useful for feedback messages) and
 * whether it went through the File System Access API (true) or a plain
 * download (false).
 */
export const saveBlobToUserChosenPath = async (
  blob: Blob,
  defaultFilename: string
): Promise<{| savedToUserPath: boolean, filename: string |}> => {
  if (supportsSaveFilePicker()) {
    try {
      // $FlowFixMe[not-a-function]
      const handle = await (window: any).showSaveFilePicker({
        suggestedName: defaultFilename,
        types: buildPickerTypes(defaultFilename),
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return {
        savedToUserPath: true,
        filename: handle.name || defaultFilename,
      };
    } catch (error) {
      if (error && error.name === 'AbortError') {
        // The user cancelled the save dialog — do not download anything.
        return { savedToUserPath: false, filename: '' };
      }
      // Otherwise (unsupported type, security error, …) fall back to a
      // regular download below.
      console.warn(
        'Could not save to the chosen location, falling back to a download.',
        error
      );
    }
  }

  const blobDownloadUrl = URL.createObjectURL(blob);
  try {
    openBlobDownloadUrl(blobDownloadUrl, defaultFilename);
  } finally {
    setTimeout(() => {
      try {
        URL.revokeObjectURL(blobDownloadUrl);
      } catch (ignored) {}
    }, 10000);
  }
  return { savedToUserPath: false, filename: defaultFilename };
};

/**
 * Save text content to a location chosen by the user.
 */
export const saveTextToUserChosenPath = (
  text: string,
  defaultFilename: string
): Promise<{| savedToUserPath: boolean, filename: string |}> =>
  saveBlobToUserChosenPath(
    new Blob([text], { type: 'text/plain;charset=utf-8' }),
    defaultFilename
  );
