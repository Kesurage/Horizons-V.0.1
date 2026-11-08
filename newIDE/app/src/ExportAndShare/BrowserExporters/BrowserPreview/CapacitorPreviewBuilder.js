// @flow

/**
 * Builds a fully self-contained preview page (for an in-app overlay iframe)
 * from the files written by a preview export — WITHOUT depending on the
 * service worker to serve them.
 *
 * Used in the Horizons app shell (Android APK), where previews must work
 * even if the service worker is unavailable:
 *  - every generated file (data.js, events code, ...) becomes a blob: URL;
 *  - the index.html template is rewritten so its relative <script src>/href
 *    point to those blob URLs;
 *  - engine runtime files are referenced with absolute same-origin URLs
 *    (/Runtime/...), served locally by the app shell (WebViewAssetLoader).
 */
export type WrittenPreviewFile = {|
  path: string,
  content: string,
  contentType: string,
|};

const isAbsoluteUrl = (url: string): boolean =>
  /^(https?:|data:|blob:|\/\/)/i.test(url);

export const buildOverlayPreviewHtml = ({
  files,
}: {
  files: Array<WrittenPreviewFile>,
}): string => {
  const indexFile =
    files.find(file => file.path === 'preview/index.html') ||
    files.find(
      file => file.path.endsWith('/preview/index.html') && file.content
    ) ||
    files.find(file => file.path.endsWith('index.html') && file.content);

  if (!indexFile) {
    throw new Error('No index.html found in the exported preview files.');
  }

  // Create a blob URL for every generated file, keyed by its basename
  // (the generated index.html references them as bare filenames).
  const blobUrlsByName = new Map<string, string>();
  files.forEach(file => {
    if (file === indexFile) return;
    const basename = file.path.split('/').pop();
    if (!basename || blobUrlsByName.has(basename)) return;
    try {
      blobUrlsByName.set(
        basename,
        URL.createObjectURL(
          new Blob([file.content], { type: file.contentType })
        )
      );
    } catch (error) {
      console.warn(
        '[CapacitorPreviewBuilder] Could not create blob URL for',
        file.path,
        error
      );
    }
  });

  // Rewrite relative src/href attributes to the blob URLs.
  let html = indexFile.content;
  html = html.replace(
    /(src|href)="([^"]+)"/g,
    (match: string, attribute: string, url: string) => {
      if (isAbsoluteUrl(url) || url.startsWith('#')) return match;
      const basename = url.split('?')[0].split('#')[0].split('/').pop();
      const blobUrl = basename ? blobUrlsByName.get(basename) : null;
      return blobUrl ? `${attribute}="${blobUrl}"` : match;
    }
  );

  // The manifest link is useless in an overlay preview and would 404.
  html = html.replace(
    /<link\s+rel="manifest"[^>]*>/gi,
    ''
  );

  return html;
};

/**
 * Revoke the blob URLs created by a previously built preview page
 * (extracted from its html) so memory is reclaimed.
 */
export const revokeOverlayPreviewBlobUrls = (html: string) => {
  const regex = /(?:src|href)="(blob:[^"]+)"/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      URL.revokeObjectURL(match[1]);
    } catch (ignored) {
      // Ignore invalid URLs.
    }
  }
};
