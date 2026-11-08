// @flow
import * as React from 'react';
import {
  type ResourceSearchAndInstallOptions,
  type ResourceSearchAndInstallResult,
  type SingleResourceSearchAndInstallResult,
} from '../EditorFunctions';
import { type ResourceManagementProps } from '../ResourcesList/ResourceSource';

import PromisePool from '@supercharge/promise-pool';

type _UseSearchAndInstallResourceReturnType = {
  searchAndInstallResources: ResourceSearchAndInstallOptions => Promise<ResourceSearchAndInstallResult>,
};

/**
 * Search & install resources for the AI agent — offline-first.
 *
 * The previous implementation called the GDevelop cloud resource search
 * (`/resource-search`), which required a logged-in account and made the AI
 * fail with "User should be authenticated." There is no public equivalent
 * for arbitrary web resource search, so instead of throwing we return a
 * clear, actionable result per resource that the agent can read and adapt
 * to (e.g. create the asset from scratch, use an installed asset resource,
 * or ask the user to import the file manually).
 */
export const useSearchAndInstallResource = ({
  project,
  resourceManagementProps,
}: {|
  project: ?gdProject,
  resourceManagementProps: ResourceManagementProps,
|}): _UseSearchAndInstallResourceReturnType => {
  return {
    searchAndInstallResources: React.useCallback(
      async ({
        resources,
      }: ResourceSearchAndInstallOptions): Promise<ResourceSearchAndInstallResult> => {
        if (!project) throw new Error('Project should be opened.');

        const { results } = await PromisePool.withConcurrency(5)
          .for(resources)
          .process<SingleResourceSearchAndInstallResult>(
            async resourceToSearch => {
              return {
                resourceName: resourceToSearch.resourceName,
                resourceKind: resourceToSearch.resourceKind,
                status: 'nothing-found',
                error:
                  `Automatic web search for resources is disabled in this offline build. ` +
                  `For the resource "${resourceToSearch.resourceName}" (${
                    resourceToSearch.resourceKind
                  }), ` +
                  `either reuse an existing resource of the project, install an asset from the public asset library ` +
                  `(create_or_replace_object with a description), or draw it with PrimitiveDrawing / ShapePainter. ` +
                  `Do not retry the same search.`,
              };
            }
          );

        return { results };
      },
      [project, resourceManagementProps]
    ),
  };
};
