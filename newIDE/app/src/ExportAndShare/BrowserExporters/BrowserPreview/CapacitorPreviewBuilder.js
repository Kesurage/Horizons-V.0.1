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

// Path prefix used by the service-worker based preview storage.
const SW_PREVIEW_PATH_PREFIX = '/browser_sw_preview/';

const normalizePath = (path: string): string => path.replace(/^\/+/, '');

export const buildOverlayPreviewHtml = ({
  files,
  additionalFiles,
}: {
  files: Array<WrittenPreviewFile>,
  // Files that were written straight to IndexedDB outside of the export
  // (events-functions extension code) — read back so the overlay can
  // reference them too.
  additionalFiles?: Array<WrittenPreviewFile>,
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

  // Create a blob URL for every file, keyed by its full path (relative to
  // the preview instance root, e.g. "1/preview/data.js") AND by its
  // basename. The generated index.html references the game data and events
  // code with ABSOLUTE same-origin urls
  // ("https://localhost/browser_sw_preview/1/preview/data.js") and the
  // engine runtime with absolute "/Runtime/..." urls — so absolute
  // browser_sw_preview urls must be rewritten to blobs, or the preview
  // would depend on the service worker (a 404 in the app shell = black
  // screen). Runtime urls are left untouched: the app shell serves them.
  // Files written during this export ("files") win over files read back
  // from IndexedDB ("additionalFiles").
  const blobUrlsByPath = new Map<string, string>();
  const blobUrlsByName = new Map<string, string>();
  [...files, ...(additionalFiles || [])].forEach(file => {
    if (file === indexFile) return;
    const normalizedPath = normalizePath(file.path);
    if (blobUrlsByPath.has(normalizedPath)) return;
    try {
      const blobUrl = URL.createObjectURL(
        new Blob([file.content], { type: file.contentType })
      );
      blobUrlsByPath.set(normalizedPath, blobUrl);
      const basename = file.path.split('/').pop();
      if (basename && !blobUrlsByName.has(basename)) {
        blobUrlsByName.set(basename, blobUrl);
      }
    } catch (error) {
      console.warn(
        '[CapacitorPreviewBuilder] Could not create a blob URL for',
        file.path,
        error
      );
    }
  });

  // Resolve a url used by the generated index.html to a blob URL (or null).
  const resolveToBlobUrl = (rawUrl: string): ?string => {
    if (rawUrl.startsWith('#') || rawUrl.startsWith('data:')) return null;
    if (/^https?:/i.test(rawUrl)) {
      // Absolute url: rewrite only same-origin service-worker preview files.
      try {
        const parsedUrl = new URL(rawUrl, window.location.origin);
        if (
          parsedUrl.origin !== window.location.origin ||
          !parsedUrl.pathname.startsWith(SW_PREVIEW_PATH_PREFIX)
        ) {
          return null;
        }
        const relativePath = decodeURIComponent(
          parsedUrl.pathname.slice(SW_PREVIEW_PATH_PREFIX.length)
        );
        return blobUrlsByPath.get(relativePath) || null;
      } catch (error) {
        return null;
      }
    }
    if (rawUrl.startsWith('//')) return null;

    // Relative url: match by full path then by basename.
    const pathPart = rawUrl.split('?')[0].split('#')[0];
    const relativePath = normalizePath(pathPart);
    return (
      blobUrlsByPath.get(relativePath) ||
      blobUrlsByName.get(pathPart.split('/').pop() || '') ||
      null
    );
  };

  // Rewrite relative AND absolute service-worker preview src/href attributes
  // to the blob URLs.
  let html = indexFile.content;
  html = html.replace(
    /(src|href)="([^"]+)"/g,
    (match: string, attribute: string, url: string) => {
      if (isAbsoluteUrl(url) && url.startsWith('blob:')) return match;
      const blobUrl = resolveToBlobUrl(url);
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
