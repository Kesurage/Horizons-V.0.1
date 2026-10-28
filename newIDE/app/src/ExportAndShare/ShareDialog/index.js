// @flow
import { Trans, t } from '@lingui/macro';
import * as React from 'react';
import Dialog from '../../UI/Dialog';
import HelpButton from '../../UI/HelpButton';
import FlatButton from '../../UI/FlatButton';
import PublishHome from './PublishHome';
import { type ExportPipeline } from '../ExportPipeline.flow';
import { Tabs } from '../../UI/Tabs';
import { useResponsiveWindowSize } from '../../UI/Responsive/ResponsiveWindowMeasurer';
import PreferencesContext from '../../MainFrame/Preferences/PreferencesContext';
import { type FileMetadata, type StorageProvider } from '../../ProjectsStorage';
import { useOnlineStatus } from '../../Utils/OnlineStatus';
import ErrorBoundary from '../../UI/ErrorBoundary';
import type { GamesList } from '../../GameDashboard/UseGamesList';
import { useGameAndBuildsManager } from '../../Utils/UseGameAndBuildsManager';

export type ShareTab = 'invite' | 'publish';
export type ExporterSection = 'browser' | 'desktop' | 'android' | 'ios';
export type ExporterSubSection = 'online' | 'offline' | 'facebook';
export type ExporterKey =
  | 'onlinewebexport'
  | 'onlineelectronexport'
  | 'onlinecordovaexport'
  | 'onlinecordovaiosexport'
  | 'webexport'
  | 'facebookinstantgamesexport'
  | 'electronexport'
  | 'cordovaexport';

// Horizons: the online build services (gd.games publishing, cloud packaging
// of Android/iOS/Windows/Linux, Facebook Instant Games) were removed — only
// local/offline exporters remain reachable from this mapping.
const exporterSectionMapping: {
  [key: ExporterSection]: { [key: ExporterSubSection]: ?ExporterKey },
} = {
  browser: {
    online: null,
    offline: 'webexport',
    facebook: null,
  },
  desktop: {
    online: null,
    offline: 'electronexport',
    facebook: null,
  },
  android: {
    online: null,
    offline: 'cordovaexport',
    facebook: null,
  },
  ios: {
    online: null,
    offline: 'cordovaexport',
    facebook: null,
  },
};

export type Exporter = {|
  name: React.Node,
  tabName: React.Node,
  helpPage: string,
  disabled?: boolean,
  key: ExporterKey,
  exportPipeline: ExportPipeline<any, any, any, any, any>,
|};

export type ShareDialogWithoutExportsProps = {|
  project: ?gdProject,
  onSaveProject: () => Promise<?FileMetadata>,
  isSavingProject: boolean,
  onClose: () => void,
  onChangeSubscription: () => void,
  initialTab: ?ShareTab,
  fileMetadata: ?FileMetadata,
  storageProvider: StorageProvider,
  gamesList: GamesList,
|};

type Props = {|
  ...ShareDialogWithoutExportsProps,
  /**
   * Use `null` to hide automated exporters.
   * It should be used with manualExporters set to `null` as well.
   */
  automatedExporters: ?Array<Exporter>,
  /**
   * Use `null` to hide manual exporters.
   * It should be used with automatedExporters set to `null` as well.
   */
  manualExporters: ?Array<Exporter>,
  // GDevelop's game platform exporter.
  onlineWebExporter: Exporter,
  /**
   * If true, all exporters will be disabled if the user is offline.
   * This is mainly helpful on browser, where we need to download resources
   * before exporting.
   */
  allExportersRequireOnline?: boolean,
|};

const ShareDialog = ({
  project,
  onSaveProject,
  isSavingProject,
  onClose,
  allExportersRequireOnline,
  onChangeSubscription,
  automatedExporters,
  manualExporters,
  onlineWebExporter,
  initialTab,
  fileMetadata,
  storageProvider,
  gamesList,
}: Props) => {
  const { isMobile } = useResponsiveWindowSize();
  const {
    setShareDialogDefaultTab,
    getShareDialogDefaultTab,
  } = React.useContext(PreferencesContext);
  const [currentTab, setCurrentTab] = React.useState<ShareTab>(
    initialTab || getShareDialogDefaultTab()
  );
  const showOnlineWebExporterOnly = !automatedExporters && !manualExporters;
  const [
    chosenExporterSection,
    setChosenExporterSection,
  ] = React.useState<?ExporterSection>(
    showOnlineWebExporterOnly ? 'browser' : null
  );
  const [
    chosenExporterSubSection,
    setChosenExporterSubSection,
  ] = React.useState<?ExporterSubSection>(
    showOnlineWebExporterOnly ? 'online' : null
  );

  React.useEffect(() => setShareDialogDefaultTab(currentTab), [
    setShareDialogDefaultTab,
    currentTab,
  ]);
  const isOnline = useOnlineStatus();

  const gameAndBuildsManager = useGameAndBuildsManager({
    project,
    onGameRegistered: gamesList.fetchGames,
  });

  const [
    isNavigationDisabled,
    setIsNavigationDisabled,
  ] = React.useState<boolean>(false);

  const exporters = React.useMemo(
    () => [
      ...(automatedExporters || []),
      ...(manualExporters || []),
      onlineWebExporter,
    ],
    [automatedExporters, manualExporters, onlineWebExporter]
  );

  const exporter: ?Exporter = React.useMemo(
    () => {
      if (!chosenExporterSection) return null;
      if (!chosenExporterSubSection) return null;

      const exporterKey =
        exporterSectionMapping[chosenExporterSection][chosenExporterSubSection];
      const chosenExporter = exporters.find(
        exporter => exporter.key === exporterKey
      );

      return chosenExporter || null;
    },
    [chosenExporterSection, chosenExporterSubSection, exporters]
  );

  if (!project) return null;

  const mainActions = [
    <FlatButton
      label={<Trans>Close</Trans>}
      key="close"
      primary={false}
      onClick={onClose}
      disabled={isNavigationDisabled}
    />,
  ];

  const secondaryActions =
    currentTab === 'publish'
      ? [
          exporter ? (
            <HelpButton key="help" helpPagePath={exporter.helpPage} />
          ) : null,
        ].filter(Boolean)
      : [];

  return (
    <Dialog
      // Keep ID for backward compatibility with guided lessons.
      id="export-dialog"
      maxWidth={'md'}
      minHeight={'lg'}
      title={<Trans>Share</Trans>}
      // $FlowFixMe[incompatible-type]
      actions={mainActions}
      // $FlowFixMe[incompatible-type]
      secondaryActions={secondaryActions}
      onRequestClose={onClose}
      open
      fixedContent={
        <Tabs
          value={'publish'}
          onChange={() => {}}
          options={[
            {
              value: 'publish',
              label: <Trans>Publish</Trans>,
              id: 'publish-tab',
              disabled: isNavigationDisabled,
            },
          ]}
        />
      }
      flexColumnBody
    >
      {/* Horizons: the "Invite" (collaboration) tab was removed —
          it requires GDevelop cloud accounts. */}
      {currentTab === 'publish' && (
        <PublishHome
          project={project}
          gameAndBuildsManager={gameAndBuildsManager}
          onSaveProject={onSaveProject}
          isSavingProject={isSavingProject}
          onChangeSubscription={onChangeSubscription}
          isNavigationDisabled={isNavigationDisabled}
          setIsNavigationDisabled={setIsNavigationDisabled}
          selectedExporter={exporter}
          onChooseSection={setChosenExporterSection}
          onChooseSubSection={setChosenExporterSubSection}
          chosenSection={chosenExporterSection}
          chosenSubSection={chosenExporterSubSection}
          allExportersRequireOnline={allExportersRequireOnline}
          showOnlineWebExporterOnly={showOnlineWebExporterOnly}
        />
      )}
    </Dialog>
  );
};

const ShareDialogWithErrorBoundary = (props: Props): React.Node => (
  <ErrorBoundary
    componentTitle={<Trans>Share dialog</Trans>}
    scope="export-and-share"
    onClose={props.onClose}
  >
    <ShareDialog {...props} />
  </ErrorBoundary>
);

export default ShareDialogWithErrorBoundary;
