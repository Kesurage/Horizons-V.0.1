// @flow
import {
  type ResourceMover,
  type MoveAllProjectResourcesOptions,
  type MoveAllProjectResourcesResult,
  type MoveAllProjectResourcesFunction,
} from './index';
import CloudStorageProvider from '../CloudStorageProvider';
import UrlStorageProvider from '../UrlStorageProvider';
import DownloadFileStorageProvider from '../DownloadFileStorageProvider';
import LocalStorageProvider from '../LocalStorageProvider';
import { moveUrlResourcesToCloudProject } from '../CloudStorageProvider/CloudResourceMover';

const moveNothing = async () => {
  return {
    erroredResources: [],
  };
};

const movers: {
  [string]: MoveAllProjectResourcesFunction,
} = {
  // Moving to GDevelop "Cloud" storage:

  // From a Cloud project to another, resources need to be copied
  // (unless they are public URLs).
  [`${CloudStorageProvider.internalName}=>${
    CloudStorageProvider.internalName
  }`]: moveUrlResourcesToCloudProject,
  // On the web-app, most resources are public URLs, so nothing to do.
  // But if some resources are coming from a private game template,
  // they need to be copied.
  [`${UrlStorageProvider.internalName}=>${
    CloudStorageProvider.internalName
  }`]: moveUrlResourcesToCloudProject,

  // Moving to "DownloadFile":

  // Saving to "DownloadFile" will *not* change any resources, as it's a
  // "temporary save" that is made and given to the user.
  // $FlowFixMe[incompatible-type]
  [`${CloudStorageProvider.internalName}=>${
    DownloadFileStorageProvider.internalName
  }`]: moveNothing,
  // $FlowFixMe[incompatible-type]
  [`${UrlStorageProvider.internalName}=>${
    DownloadFileStorageProvider.internalName
  }`]: moveNothing,

  // Moving to "LocalDevice" (projects saved in the browser/device storage):

  // Projects saved on the device keep their resources as they are (public
  // URLs or data embedded in the project), so that they can work offline.
  // $FlowFixMe[incompatible-type]
  [`${CloudStorageProvider.internalName}=>${
    LocalStorageProvider.internalName
  }`]: moveNothing,
  // $FlowFixMe[incompatible-type]
  [`${UrlStorageProvider.internalName}=>${
    LocalStorageProvider.internalName
  }`]: moveNothing,
  // $FlowFixMe[incompatible-type]
  [`${LocalStorageProvider.internalName}=>${
    LocalStorageProvider.internalName
  }`]: moveNothing,
  // $FlowFixMe[incompatible-type]
  [`${LocalStorageProvider.internalName}=>${
    DownloadFileStorageProvider.internalName
  }`]: moveNothing,
  // $FlowFixMe[incompatible-type]
  [`${LocalStorageProvider.internalName}=>${
    CloudStorageProvider.internalName
  }`]: moveUrlResourcesToCloudProject,
};

const BrowserResourceMover: ResourceMover = {
  moveAllProjectResources: async (
    options: MoveAllProjectResourcesOptions
  ): Promise<MoveAllProjectResourcesResult> => {
    const { oldStorageProvider, newStorageProvider } = options;
    const mover =
      movers[
        `${oldStorageProvider.internalName}=>${newStorageProvider.internalName}`
      ];
    // $FlowFixMe[constant-condition]
    if (!mover)
      throw new Error(
        `Can't find a ResourceMover for ${oldStorageProvider.internalName} to ${
          newStorageProvider.internalName
        }.`
      );

    return mover(options);
  },
};

export default BrowserResourceMover;
