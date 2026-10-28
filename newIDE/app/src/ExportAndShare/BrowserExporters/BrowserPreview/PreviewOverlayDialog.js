// @flow
import * as React from 'react';
import IconButton from '../../../UI/IconButton';
import CloseIcon from '../../../UI/CustomSvgIcons/Cross';
import RefreshIcon from '../../../UI/CustomSvgIcons/Refresh';
import Text from '../../../UI/Text';

type Props = {|
  previewIndexHtmlLocation: string,
  reloadKey: number,
  onClose: () => void,
  onIframeAvailable: (contentWindow: any) => void,
|};

const styles = {
  overlay: {
    position: 'fixed',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 2100,
    backgroundColor: '#171717',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '2px 6px',
    backgroundColor: '#1f1f1f',
    borderBottom: '1px solid #333',
    flexShrink: 0,
    minHeight: 44,
  },
  iframe: {
    flex: 1,
    width: '100%',
    border: 'none',
    backgroundColor: '#000',
  },
};

/**
 * Full-screen, in-app preview surface. Used by the Horizons app shell
 * (Capacitor WebView) where popup preview windows cannot work, and as a
 * fallback when the browser blocks popup windows.
 */
class PreviewOverlayDialog extends React.Component<Props> {
  _iframe: ?HTMLIFrameElement;

  componentWillUnmount() {
    window.removeEventListener('keydown', this._onKeyDown);
  }

  _onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      this.props.onClose();
    }
  };

  _handleIframeRef = (iframe: ?HTMLIFrameElement) => {
    this._iframe = iframe;
  };

  _handleIframeLoad = () => {
    window.addEventListener('keydown', this._onKeyDown);
    const contentWindow = this._iframe ? this._iframe.contentWindow : null;
    if (contentWindow) {
      this.props.onIframeAvailable(contentWindow);
    }
  };

  render() {
    const { previewIndexHtmlLocation, reloadKey, onClose } = this.props;

    return (
      <div style={styles.overlay}>
        <div style={styles.header}>
          <Text
            displayInlineAsSpan
            size="body-small"
            style={{ color: '#f5f5f5', paddingLeft: 8 }}
          >
            Game preview
          </Text>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <IconButton
              onClick={() => {
                // Force a fresh load of the preview.
                if (this._iframe) {
                  const location = this._iframe.src;
                  this._iframe.src = 'about:blank';
                  setTimeout(() => {
                    if (this._iframe) this._iframe.src = location;
                  }, 50);
                }
              }}
              size="small"
            >
              <RefreshIcon style={{ color: '#f5f5f5' }} />
            </IconButton>
            <IconButton onClick={onClose} size="small">
              <CloseIcon style={{ color: '#f5f5f5' }} />
            </IconButton>
          </div>
        </div>
        <iframe
          key={reloadKey}
          ref={this._handleIframeRef}
          title="Horizons game preview"
          src={previewIndexHtmlLocation}
          onLoad={this._handleIframeLoad}
          style={styles.iframe}
          allow="autoplay; fullscreen; accelerometer; gyroscope; gamepad *"
        />
      </div>
    );
  }
}

export default PreviewOverlayDialog;
