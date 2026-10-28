// @flow
import * as React from 'react';
import { I18n } from '@lingui/react';
import { t, Trans } from '@lingui/macro';
import TranslateIcon from '@material-ui/icons/Translate';
import FlatButton from '../../../UI/FlatButton';
import { Column, Line } from '../../../UI/Grid';
import { LineStackLayout } from '../../../UI/Layout';
import TextButton from '../../../UI/TextButton';
import IconButton from '../../../UI/IconButton';
import { useResponsiveWindowSize } from '../../../UI/Responsive/ResponsiveWindowMeasurer';
import SaveProjectIcon from '../../SaveProjectIcon';
import HistoryIcon from '../../../UI/CustomSvgIcons/History';
import { type FileMetadata } from '../../../ProjectsStorage';

type Props = {|
  hasProject: boolean,
  onOpenVersionHistory: () => void,
  onOpenProfile: () => void,
  onOpenLanguageDialog: () => void,
  onSave: (options?: {|
    skipNewVersionWarning: boolean,
  |}) => Promise<?FileMetadata>,
  canSave: boolean,
|};

export const HomePageHeader = ({
  hasProject,
  onOpenVersionHistory,
  onOpenProfile,
  onOpenLanguageDialog,
  onSave,
  canSave,
}: Props): React.Node => {
  const { isMobile } = useResponsiveWindowSize();

  return (
    <I18n>
      {({ i18n }) => (
        <LineStackLayout
          justifyContent="space-between"
          alignItems="center"
          noMargin
          expand
        >
          <Column noMargin>
            <Line noMargin>
              {!!hasProject && (
                <>
                  <IconButton
                    size="small"
                    id="main-toolbar-history-button"
                    onClick={onOpenVersionHistory}
                    tooltip={t`Open version history`}
                    color="default"
                  >
                    <HistoryIcon />
                  </IconButton>
                  <SaveProjectIcon
                    id="main-toolbar-save-button"
                    onSave={onSave}
                    canSave={canSave}
                  />
                </>
              )}
            </Line>
          </Column>
          <Column>
            <LineStackLayout noMargin alignItems="center">
              {/* Horizons: account/profile/notification chips removed —
                  the editor runs fully locally. */}
              {isMobile ? (
                <IconButton size="small" onClick={onOpenLanguageDialog}>
                  <TranslateIcon fontSize="small" />
                </IconButton>
              ) : (
                <TextButton
                  label={i18n.language.toUpperCase()}
                  onClick={onOpenLanguageDialog}
                  icon={<TranslateIcon fontSize="small" />}
                />
              )}
            </LineStackLayout>
          </Column>
        </LineStackLayout>
      )}
    </I18n>
  );
};
