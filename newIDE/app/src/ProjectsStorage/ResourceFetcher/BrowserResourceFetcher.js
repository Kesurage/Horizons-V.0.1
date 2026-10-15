// @flow
import {
  type ResourceFetcher,
  type FetchAllProjectResourcesOptions,
  type FetchAllProjectResourcesResult,
  type FetchAllProjectResourcesFunction,
} from './index';
import CloudStorageProvider from '../CloudStorageProvider';
import { moveUrlResourcesToCloudFilesIfPrivate } from '../CloudStorageProvider/CloudResourceFetcher';
import UrlStorageProvider from '../UrlStorageProvider';
import LocalStorageProvider from '../LocalStorageProvider';
import { fetchRelativeResourcesToFullUrls } from '../UrlStorageProvider/UrlResourceFetcher';

const fetchNothing = async () => ({
  erroredResources: [],
});

const fetchers: {
  [string]: FetchAllProjectResourcesFunction,
} = {
  // The Cloud file storage provider fetches the resources that are
  // private URLs by downloading them and reuploading them to the cloud.
  // $FlowFixMe[incompatible-type]
  [CloudStorageProvider.internalName]: moveUrlResourcesToCloudFilesIfPrivate,
  // The URL storage consider relative resources to be relative to the project
  // URL. This allows to open local projects uploaded to GitHub for example.
  // $FlowFixMe[incompatible-type]
  [UrlStorageProvider.internalName]: fetchRelativeResourcesToFullUrls,
  // Local device storage projects embed/retain resources locally, no remote fetch needed.
  // $FlowFixMe[incompatible-type]
  [LocalStorageProvider.internalName]: fetchNothing,
};

const BrowserResourceFetcher: ResourceFetcher = {
  fetchAllProjectResources: async (
    options: FetchAllProjectResourcesOptions
  ): Promise<FetchAllProjectResourcesResult> => {
    const { storageProvider } = options;
    const fetcher = fetchers[storageProvider.internalName];
    if (!fetcher) {
      // Graceful fallback for any offline/local storage provider
      return { erroredResources: [] };
    }
    return fetcher(options);
  },
};

export default BrowserResourceFetcher;
