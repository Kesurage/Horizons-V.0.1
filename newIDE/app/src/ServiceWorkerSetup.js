// @flow
import optionalRequire from './Utils/OptionalRequire';
import { isNativeMobileApp } from './Utils/Platform';

// $FlowFixMe[cannot-resolve-name]
const PUBLIC_URL: string = process.env.PUBLIC_URL || '';
// $FlowFixMe[cannot-resolve-name]
const isDev = process.env.NODE_ENV !== 'production';

const electron = optionalRequire('electron');
const serviceWorker =
  typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;

export function isServiceWorkerSupported(): boolean {
  return !!serviceWorker;
}

export function registerServiceWorker() {
  if (isNativeMobileApp() || !!electron) {
    return;
  }

  if (!serviceWorker) {
    console.warn(
      'Service Worker not supported on this deployment (probably: not HTTPS and not localhost).'
    );
    return;
  }

  window.addEventListener('load', () => {
    // Use a cache-buster for development so that the service worker is
    // always reloaded when the app is reloaded.
    const swUrl = isDev
      ? `${PUBLIC_URL}/service-worker.js?dev=${Date.now()}`
      : `${PUBLIC_URL}/service-worker.js`;

    serviceWorker
      .register(swUrl)
      .then(registration => {
        registration.onupdatefound = () => {
          const installingWorker = registration.installing;
          if (installingWorker == null) {
            return;
          }
          installingWorker.onstatechange = () => {
            if (installingWorker.state === 'installed') {
              const alreadyHasAServiceWorker = !!serviceWorker.controller;
              if (!isDev) {
                if (alreadyHasAServiceWorker) {
                  // At this point, the updated precached content has been fetched,
                  // but the previous service worker will still serve the older
                  // content until all client tabs are closed.
                  console.log(
                    'A new version is available and will be used when all tabs for this page are closed.'
                  );
                } else {
                  // Service worker has been installed for the first time.
                  console.log('Content is cached for offline use.');
                }
              }
            }
          };
        };
      })
      .catch(error => {
        console.error('Error during service worker registration:', error);
      });

    if (!isDev) {
      // Forces a check right now for a newer service worker script.
      // If there is one, it will be installed (see the service worker script to verify how in development
      // a new service worker script does a `self.skipWaiting()` and `self.clients.claim()`).
      // In development, the Date.now() cache-buster in the SW URL already ensures a fresh
      // script on every load — calling update() on top of it causes a Firefox error because
      // the ready registration's scriptURL no longer matches the newly registered URL.
      serviceWorker.ready.then(registration => {
        registration.update();
      });
    }
  });
}

/**
 * Ask the browser to make the storage (projects saved on the device,
 * service worker cache) persistent, i.e. not evictable automatically
 * when the device is low on space. Especially important on Android,
 * where browsers can otherwise wipe IndexedDB data.
 */
export function ensurePersistentStorage() {
  if (
    typeof navigator === 'undefined' ||
    !navigator.storage ||
    !navigator.storage.persist
  ) {
    return;
  }
  navigator.storage
    .persisted()
    .then(isAlreadyPersistent => {
      if (isAlreadyPersistent) return null;
      return navigator.storage.persist().then(isPersistent => {
        console.info(
          isPersistent
            ? 'Storage marked as persistent: projects saved on the device are protected from eviction.'
            : 'Storage persistence was not granted: projects on the device could be evicted if the device runs out of space.'
        );
        return null;
      });
    })
    .catch(error => {
      console.warn('Unable to request persistent storage:', error);
    });
}

