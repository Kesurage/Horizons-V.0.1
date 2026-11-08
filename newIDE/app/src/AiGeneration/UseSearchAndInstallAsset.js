// @flow
import * as React from 'react';
import {
  type AssetSearchAndInstallOptions,
  type AssetSearchAndInstallResult,
} from '../EditorFunctions';
import {
  type AssetShortHeader,
  listAllPublicAssets,
} from '../Utils/GDevelopServices/Asset';
import { useInstallAsset } from '../AssetStore/NewObjectDialog';
import { type ResourceManagementProps } from '../ResourcesList/ResourceSource';
import { AssetStoreContext } from '../AssetStore/AssetStoreContext';
import { OFFLINE_ASSET_SHORT_HEADERS } from '../AssetStore/OfflineAssetsCatalog';

type _FuncReturnType = {
  searchAndInstallAsset: AssetSearchAndInstallOptions => Promise<AssetSearchAndInstallResult>,
};

const normalize = (text: string): string =>
  (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'for',
  'with',
  'and',
  'or',
  'to',
  'in',
  'on',
  'some',
  'please',
  'find',
  'me',
  'my',
  'want',
  'need',
  'like',
  'looks',
  'looking',
  'object',
  'sprite',
  'asset',
  'game',
  'add',
  'create',
  'get',
  'that',
  'this',
  'it',
  'its',
  'as',
  'is',
  'are',
  'be',
  'best',
  'nice',
  'good',
  'cool',
  'new',
]);

/**
 * Score an asset against the search keywords using its name, tags and
 * description. This is a fully local, dependency-free matcher that replaces
 * the GDevelop cloud asset search (which required an authenticated account):
 * the public asset catalog is fetched anonymously (and cached offline by
 * `listAllPublicAssets`), so searching/installing works with no GDevelop
 * account and degrades gracefully to the offline catalog when there is no
 * internet connection at all.
 */
const scoreAssetAgainstKeywords = (
  asset: AssetShortHeader,
  keywords: Array<string>
): number => {
  if (keywords.length === 0) return 0;
  const name = normalize(asset.name);
  const nameWords = new Set(name.split(' '));
  const tags = (asset.tags || []).map(tag => normalize(tag));
  const description = normalize(asset.shortDescription);
  const descriptionWords = new Set(description.split(' '));

  let score = 0;
  keywords.forEach(keyword => {
    if (name === keyword) score += 12;
    else if (nameWords.has(keyword)) score += 6;
    if (tags.some(tag => tag === keyword)) score += 4;
    else if (tags.some(tag => tag.includes(keyword) || keyword.includes(tag)))
      score += 2;
    if (descriptionWords.has(keyword)) score += 1;
  });
  return score;
};

const extractKeywords = ({
  searchTerms,
  description,
}: {|
  searchTerms: string,
  description: string,
|}): Array<string> => {
  const rawWords = normalize(`${searchTerms} ${description}`).split(' ');
  const keywords = rawWords.filter(
    word => word.length > 1 && !STOP_WORDS.has(word)
  );
  // De-duplicate while keeping the order (earlier = more important).
  return Array.from(new Set(keywords));
};

/**
 * Search & install an asset for the AI agent, 100% without the GDevelop
 * Generation cloud service (no account needed):
 * 1. If an exact/partial asset id is given, install it directly (it may
 *    come from the asset store catalog already loaded in the editor).
 * 2. Otherwise, load the public asset catalog (anonymous request, cached in
 *    localStorage for subsequent/offline usage) and pick the best match
 *    with local keyword scoring.
 * 3. Install the chosen asset in the project with the regular installer.
 */
export const useSearchAndInstallAsset = ({
  project,
  resourceManagementProps,
  onWillInstallExtension,
  onExtensionInstalled,
}: {|
  project: ?gdProject,
  resourceManagementProps: ResourceManagementProps,
  onWillInstallExtension: (extensionNames: Array<string>) => void,
  onExtensionInstalled: (extensionNames: Array<string>) => void,
|}): _FuncReturnType => {
  const { getAssetShortHeaderFromId } = React.useContext(AssetStoreContext);
  const installAsset = useInstallAsset({
    project,
    resourceManagementProps,
    onWillInstallExtension,
    onExtensionInstalled,
  });

  return {
    searchAndInstallAsset: React.useCallback(
      async ({
        objectsContainer,
        objectName,
        objectType,
        exactOrPartialAssetId,
        searchTerms,
        description,
        ...restAssetSearchOptions
      }: AssetSearchAndInstallOptions): Promise<AssetSearchAndInstallResult> => {
        const makeNothingFound = (message: string) => ({
          status: 'nothing-found',
          message,
          createdObjects: [],
          assetShortHeader: null,
          isTheFirstOfItsTypeInProject: false,
        });

        let assetShortHeader: AssetShortHeader | null = null;
        if (exactOrPartialAssetId) {
          // If an exact or partial asset id is provided, first try to
          // fetch the asset directly by its id.
          const foundAssetShortHeader = getAssetShortHeaderFromId(
            exactOrPartialAssetId
          );
          if (foundAssetShortHeader) {
            if (objectType && foundAssetShortHeader.objectType !== objectType) {
              return {
                status: 'nothing-found',
                message: `Asset with id "${exactOrPartialAssetId}" has type "${
                  foundAssetShortHeader.objectType
                }", which does not match the requested type "${objectType}".`,
                createdObjects: [],
                assetShortHeader: null,
                isTheFirstOfItsTypeInProject: false,
              };
            }
            assetShortHeader = foundAssetShortHeader;
          }
          // If not found by id, fall through to the search below.
        }

        if (!assetShortHeader) {
          if (
            !objectType &&
            !exactOrPartialAssetId &&
            !searchTerms &&
            !description
          ) {
            return {
              status: 'error',
              message:
                'Cannot search for an asset without an object type, an asset id or search terms. Specify either `object_type`, `asset_id` or a `description` of the wanted asset.',
              createdObjects: [],
              assetShortHeader: null,
              isTheFirstOfItsTypeInProject: false,
            };
          }

          // Fast path: when a type is given but nothing describes WHAT to
          // search, skip the catalog entirely — the caller will create the
          // object from scratch (much faster than scanning the library).
          if (objectType && !searchTerms && !description) {
            return makeNothingFound(
              `No asset search needed for type "${objectType}" — create the object from scratch.`
            );
          }

          // Load the public catalog: works without any account. If the
          // network is unavailable, fall back to the bundled offline catalog
          // (and the copy cached in localStorage by listAllPublicAssets).
          let publicAssetShortHeaders: ?Array<AssetShortHeader> = null;
          try {
            const publicAssets = await listAllPublicAssets({
              environment: 'live',
            });
            publicAssetShortHeaders = publicAssets.publicAssetShortHeaders;
          } catch (error) {
            console.warn(
              'Could not load the public asset catalog, using the offline one:',
              error
            );
            publicAssetShortHeaders = OFFLINE_ASSET_SHORT_HEADERS;
          }

          if (
            !publicAssetShortHeaders ||
            publicAssetShortHeaders.length === 0
          ) {
            return makeNothingFound(
              'No asset catalog is available (no internet connection and the catalog cache is empty). Create the object from scratch instead, or use simple objects like "Sprite" or "Text".'
            );
          }

          const keywords = extractKeywords({ searchTerms, description });
          const candidates = objectType
            ? publicAssetShortHeaders.filter(
                assetShortHeader => assetShortHeader.objectType === objectType
              )
            : publicAssetShortHeaders;
          const searchableCandidates = candidates.length
            ? candidates
            : publicAssetShortHeaders;

          let bestAsset: AssetShortHeader | null = null;
          let bestScore = 0;
          searchableCandidates.forEach(asset => {
            const score = scoreAssetAgainstKeywords(asset, keywords);
            if (score > bestScore) {
              bestScore = score;
              bestAsset = asset;
            }
          });

          if (!bestAsset || bestScore <= 0) {
            const searchedText = searchTerms || description || objectType || '';
            return makeNothingFound(
              `No asset in the public library matches "${searchedText}". Try different search terms, or create the object from scratch with \`object_type\` "Sprite" (for images), "TextObject::Text", "PanelSpriteObject::PanelSprite", etc.`
            );
          }
          assetShortHeader = bestAsset;
        }

        // `installAsset` computes `isTheFirstOfItsTypeInProject` before
        // actually inserting the objects into the project, so it reflects
        // the state right before installation.
        const installOutput = await installAsset({
          assetShortHeader,
          objectsContainer,
          requestedObjectName: objectName,
          setIsAssetBeingInstalled: () => {},
        });

        if (!installOutput) {
          return {
            status: 'error',
            message: 'Asset found but failed to install asset.',
            createdObjects: [],
            assetShortHeader: null,
            isTheFirstOfItsTypeInProject: false,
          };
        }

        return {
          status: 'asset-installed',
          message: `Asset "${assetShortHeader.name}" installed successfully.`,
          createdObjects: installOutput.createdObjects,
          assetShortHeader,
          isTheFirstOfItsTypeInProject:
            installOutput.isTheFirstOfItsTypeInProject,
        };
      },
      [installAsset, getAssetShortHeaderFromId]
    ),
  };
};
