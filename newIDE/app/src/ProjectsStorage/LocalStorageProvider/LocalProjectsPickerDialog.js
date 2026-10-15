// @flow
import { Trans, t } from '@lingui/macro';
import { I18n } from '@lingui/react';
import * as React from 'react';
import Dialog from '../../UI/Dialog';
import FlatButton from '../../UI/FlatButton';
import Text from '../../UI/Text';
import { List, ListItem } from '../../UI/List';
import ListItemIcon from '@material-ui/core/ListItemIcon';
import TextField from '../../UI/TextField';
import EmptyMessage from '../../UI/EmptyMessage';
import AlertMessage from '../../UI/AlertMessage';
import LinearProgress from '../../UI/LinearProgress';
import Smartphone from '../../UI/CustomSvgIcons/Smartphone';
import Trash from '../../UI/CustomSvgIcons/Trash';
import {
  type LocalProjectRecord,
  listProjects,
  deleteProject,
  estimateUsage,
} from './LocalProjectsIndexedDB';
import { type MenuItemTemplate } from '../../UI/Menu/Menu.flow';

const formatBytes = (bytes: number): string => {
  if (!bytes) return '0 MB';
  if (bytes < 1000 * 1000) return `${Math.round(bytes / 1000)} KB`;
  return `${Math.round(bytes / (1000 * 100) / 10)} MB`;
};

/**
 * Dialog listing the projects saved on the device (IndexedDB),
 * allowing to open or delete them.
 */
export const LocalProjectsPickerDialog = ({
  onOpen,
  onClose,
}: {|
  onOpen: LocalProjectRecord => void,
  onClose: () => void,
|}): React.Node => {
  const [isLoading, setIsLoading] = React.useState<boolean>(true);
  const [projects, setProjects] = React.useState<Array<LocalProjectRecord>>(
    []
  );
  const [usage, setUsage] = React.useState<?{|
    usage: number,
    quota: number,
  |}>(null);

  const refreshProjects = React.useCallback(async () => {
    setIsLoading(true);
    try {
      const [records, usageEstimate] = await Promise.all([
        listProjects(),
        estimateUsage(),
      ]);
      setProjects(
        records
          .slice()
          .sort((a, b) => b.lastModifiedDate - a.lastModifiedDate)
      );
      setUsage(usageEstimate);
    } catch (error) {
      console.error('Unable to list projects saved on the device:', error);
      setProjects([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  return (
    <I18n>
      {({ i18n }) => (
        <Dialog
          title={
            <Trans>Projects saved on this device</Trans>
          }
          actions={[
            <FlatButton
              label={<Trans>Cancel</Trans>}
              key="close"
              primary={false}
              onClick={onClose}
            />,
          ]}
          onRequestClose={onClose}
          open
          maxWidth="sm"
          fullHeight
        >
          {isLoading && <LinearProgress />}
          {!isLoading && projects.length === 0 && (
            <EmptyMessage>
              <Trans>
                No project is saved on this device yet. Create a new project,
                or use Save as to save an opened project on this device.
                Projects saved here work completely offline.
              </Trans>
            </EmptyMessage>
          )}
          <List useGap>
            {projects.map(project => (
              <ListItem
                key={project.id}
                leftIcon={
                  <ListItemIcon>
                    <Smartphone />
                  </ListItemIcon>
                }
                primaryText={project.name}
                secondaryText={i18n.date(project.lastModifiedDate, {
                  format: 'long',
                })}
                onClick={() => onOpen(project)}
                displayMenuButton
                buildMenuTemplate={(menuI18n): Array<MenuItemTemplate> => [
                  {
                    label: menuI18n._(t`Open`),
                    click: () => onOpen(project),
                  },
                  {
                    label: menuI18n._(t`Delete from this device`),
                    click: () => {
                      if (
                        window.confirm(
                          menuI18n._(
                            t`Delete ${project.name} from this device? This cannot be undone.`
                          )
                        )
                      ) {
                        deleteProject(project.id).then(() => refreshProjects());
                      }
                    },
                  },
                ]}
              />
            ))}
          </List>
          {usage && (
            <AlertMessage kind="info">
              <Trans>
                {formatBytes(usage.usage)} used on this device
                {usage.quota
                  ? ` (out of ${formatBytes(usage.quota)} available)`
                  : ''}
                . Projects are stored in your browser and stay available
                offline.
              </Trans>
            </AlertMessage>
          )}
        </Dialog>
      )}
    </I18n>
  );
};

/**
 * Dialog asking for the name under which to save the project
 * on the device (used for Save as / new projects).
 */
export const LocalProjectSaveAsDialog = ({
  initialName,
  onDone,
  onCancel,
}: {|
  initialName: string,
  onDone: string => void,
  onCancel: () => void,
|}): React.Node => {
  const [name, setName] = React.useState<string>(initialName || 'New game');

  return (
    <Dialog
      title={<Trans>Save on this device</Trans>}
      actions={[
        <FlatButton
          label={<Trans>Cancel</Trans>}
          key="cancel"
          primary={false}
          onClick={onCancel}
        />,
        <FlatButton
          label={<Trans>Save</Trans>}
          key="save"
          primary
          onClick={() => {
            const trimmedName = name.trim();
            onDone(trimmedName || 'New game');
          }}
        />,
      ]}
      onRequestClose={onCancel}
      open
      maxWidth="xs"
    >
      <TextField
        value={name}
        onChange={(event, value) => setName(value)}
        floatingLabelText={<Trans>Project name</Trans>}
        floatingLabelFixed
        fullWidth
        autoFocus
        onKeyUp={(event: KeyboardEvent) => {
          if (event.key === 'Enter') {
            const trimmedName = name.trim();
            onDone(trimmedName || 'New game');
          }
        }}
      />
      <Text size="body-small">
        <Trans>
          The project will be saved in this device storage and will remain
          available offline, with no limit on the number of projects.
        </Trans>
      </Text>
    </Dialog>
  );
};
