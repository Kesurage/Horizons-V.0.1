// @flow
import * as React from 'react';
import RouterContext from '../MainFrame/RouterContext';
import { SubscriptionContext } from '../Profile/Subscription/SubscriptionContext';
import { FLING_GAME_IN_APP_TUTORIAL_ID } from './GDevelopServices/InAppTutorial';
import AuthenticatedUserContext from '../Profile/AuthenticatedUserContext';
import { t } from '@lingui/macro';
import { getListedBundle } from './GDevelopServices/Shop';
import useAlertDialog from '../UI/Alert/useAlertDialog';
import GDevelopThemeContext from '../UI/Theme/GDevelopThemeContext';
import { type OpenAskAiOptions } from '../AiGeneration/Utils';
import { CreditsPackageStoreContext } from '../AssetStore/CreditsPackages/CreditsPackageStoreContext';

type Props = {|
  openInAppTutorialDialog: (tutorialId: string) => void,
  openProfileDialog: () => void,
  openAskAi: (?OpenAskAiOptions) => void,
  openStandaloneDialog: () => void,
|};

/**
 * Helper for Mainframe to open a dialog when the component is mounted.
 * This corresponds to when a user opens the app on web, with a parameter in the URL.
 */
const useOpenInitialDialog = ({
  openInAppTutorialDialog,
  openProfileDialog,
  openAskAi,
  openStandaloneDialog,
}: Props) => {
  const { routeArguments, removeRouteArguments } = React.useContext(
    RouterContext
  );
  const { openSubscriptionDialog } = React.useContext(SubscriptionContext);
  const { openCreditsPackageDialog } = React.useContext(
    CreditsPackageStoreContext
  );
  const {
    onOpenCreateAccountDialog,
    onOpenCreateAccountWithPurchaseClaimDialog,
    onOpenPurchaseClaimDialog,
    onOpenLoginDialog,
    authenticated,
    loginState,
  } = React.useContext(AuthenticatedUserContext);
  const { showAlert } = useAlertDialog();
  const gdevelopTheme = React.useContext(GDevelopThemeContext);

  React.useEffect(
    () => {
      async function openCorrespondingDialog() {
        switch (routeArguments['initial-dialog']) {
          // Horizons: 'subscription', 'signup', 'standalone' and
          // 'credits-purchase' cases were removed — no GDevelop services.
          case 'profile':
            // Horizons: the profile dialog was removed. Just consume the
            // route argument so the effect settles.
            removeRouteArguments(['initial-dialog']);
            break;
          case 'onboarding':
          case 'guided-lesson':
            const tutorialId = routeArguments['tutorial-id'];
            if (tutorialId) {
              openInAppTutorialDialog(tutorialId);
            } else {
              // backward compatibility, open the fling game tutorial.
              openInAppTutorialDialog(FLING_GAME_IN_APP_TUTORIAL_ID);
            }
            removeRouteArguments(['initial-dialog', 'tutorial-id']);
            break;
          case 'games-dashboard':
            // Do nothing as it should open the games dashboard on the homepage
            // in the manage tab. So the homepage handles the route arguments itself.
            break;
          case 'ask-ai':
            openAskAi({
              aiRequestId: null,
            });
            removeRouteArguments(['initial-dialog']);
            break;
          default:
            break;
        }
      }

      openCorrespondingDialog();
    },
    [
      routeArguments,
      openInAppTutorialDialog,
      openProfileDialog,
      openStandaloneDialog,
      removeRouteArguments,
      openAskAi,
    ]
  );
};

export default useOpenInitialDialog;
