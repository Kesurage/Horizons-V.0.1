let electron = null;
let remote = null;
let electronWindow = null;
let ipcRenderer = null;

if (typeof require === 'function') {
  electron = require('electron');
  remote = require('@electron/remote');
  electronWindow = remote.getCurrentWindow();
  ipcRenderer = electron.ipcRenderer;
}

export const setTitle = title => {
  if (electronWindow) electronWindow.setTitle(title);
  else document.title = title;
};

export const closeWindow = () => {
  if (remote) remote.getCurrentWindow().close();
  else {
    sendMessageToParentEditor('close');
  }
};

export const sendMessageToParentEditor = (id, payload) => {
  if (ipcRenderer) {
    if (payload) ipcRenderer.send(id, payload);
    else ipcRenderer.send(id);
  } else {
    // In a browser, the editor runs in a popup window opened by the IDE, so
    // the IDE is `window.opener`. In the Horizons app shell (Android APK),
    // the editor runs in an embedded iframe, so the IDE is `window.parent`.
    const targetWindow =
      window.opener ||
      (window.parent && window.parent !== window ? window.parent : null);
    if (targetWindow) {
      targetWindow.postMessage(
        {
          id,
          payload,
        },
        '*'
      );
    } else {
      console.error(`Unable to send message ${id} to the main editor.`);
    }
  }
};

export const onMessageFromParentEditor = (id, callback) => {
  if (ipcRenderer) {
    ipcRenderer.on(id, (event, payload) => {
      callback(payload);
    });
  } else {
    window.addEventListener('message', event => {
      if (event.data.id === id) {
        callback(event.data.payload);
      }
    });
  }
};
