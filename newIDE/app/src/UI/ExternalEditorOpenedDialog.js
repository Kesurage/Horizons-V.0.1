import { Trans } from '@lingui/macro';
import optionalRequire from '../Utils/OptionalRequire';
import Dialog from './Dialog';
import Text from './Text';
import FlatButton from './FlatButton';
import { isRunningInCapacitor } from '../Utils/Platform';

const electron = optionalRequire('electron');

export const ExternalEditorOpenedDialog = ({
  onClose,
}: {|
  onClose?: () => Promise<void>,
|}) => {
  if (!!electron) return null;

  // In the Horizons app shell (Android APK), the external editor is shown in
  // a full-screen in-app overlay with its own Close button — and rendering
  // this dialog on top of it would trap the focus, preventing the Android
  // keyboard from working in the embedded editor (Yarn, Piskel, ...).
  if (isRunningInCapacitor()) return null;

  return (
    <Dialog
      title={<Trans>An external editor is opened.</Trans>}
      cannotBeDismissed
      fullscreen="never-even-on-mobile"
      open
      maxWidth="sm"
      id="external-editor-opened-dialog"
      actions={
        onClose
          ? [
              <FlatButton
                label={<Trans>Cancel</Trans>}
                onClick={onClose}
                key="close"
              />,
            ]
          : null
      }
    >
      <Text>
        <Trans>
          Save your changes or close the external editor to continue.
        </Trans>
      </Text>
    </Dialog>
  );
};
