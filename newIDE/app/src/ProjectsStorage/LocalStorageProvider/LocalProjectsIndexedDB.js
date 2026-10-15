// @flow

/**
 * IndexedDB storage for projects saved directly on the device (browser).
 * Used by the "Save on this device" storage provider, so that projects can
 * be worked on and saved offline, with no limit on the number of projects.
 */

const DATABASE_NAME = 'gdevelop-local-projects';
const DATABASE_VERSION = 1;
const PROJECTS_STORE = 'projects';
const AUTOSAVES_STORE = 'autosaves';

export type LocalProjectRecord = {|
  id: string,
  name: string,
  lastModifiedDate: number,
  /** The serialized project, as a JSON string. */
  content: string,
|};

export const AUTOSAVE_SUFFIX = '|autosave';

export const isAvailable = (): boolean => {
  return typeof window !== 'undefined' && 'indexedDB' in window;
};

const openDatabase = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = event => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
        db.createObjectStore(PROJECTS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(AUTOSAVES_STORE)) {
        db.createObjectStore(AUTOSAVES_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = event => resolve(event.target.result);
    request.onerror = event =>
      reject(
        new Error(
          'Unable to open the local projects database: ' +
            (request.error ? request.error.message : 'unknown error')
        )
      );
  });
};

const withStore = async <T>(
  storeName: string,
  mode: 'readonly' | 'readwrite',
  callback: IDBObjectStore => Promise<T> | T
): Promise<T> => {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let result: ?T = null;
    try {
      const callbackResult = callback(store);
      if (callbackResult instanceof Promise) {
        callbackResult.then(callbackValue => {
          result = callbackValue;
        });
      } else {
        result = callbackResult;
      }
    } catch (error) {
      db.close();
      reject(error);
      return;
    }
    transaction.oncomplete = () => {
      db.close();
      resolve(result);
    };
    transaction.onerror = () => {
      db.close();
      reject(
        transaction.error ||
          new Error('Error while accessing the local projects database.')
      );
    };
  });
};

/** Generate a short, unique-enough id for a locally stored project. */
export const generateLocalProjectId = (): string => {
  return (
    'local-' +
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 10)
  );
};

export const listProjects = (): Promise<Array<LocalProjectRecord>> => {
  return withStore(PROJECTS_STORE, 'readonly', store => {
    return new Promise(resolve => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => resolve([]);
    });
  });
};

export const getProject = (id: string): Promise<?LocalProjectRecord> => {
  return withStore(PROJECTS_STORE, 'readonly', store => {
    return new Promise(resolve => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  });
};

export const putProject = (record: LocalProjectRecord): Promise<void> => {
  return withStore(PROJECTS_STORE, 'readwrite', store => {
    store.put(record);
  });
};

export const deleteProject = (id: string): Promise<void> => {
  return withStore(PROJECTS_STORE, 'readwrite', store => {
    store.delete(id);
  });
};

export const putAutosave = (record: LocalProjectRecord): Promise<void> => {
  return withStore(AUTOSAVES_STORE, 'readwrite', store => {
    store.put(record);
  });
};

export const getAutosave = (id: string): Promise<?LocalProjectRecord> => {
  return withStore(AUTOSAVES_STORE, 'readonly', store => {
    return new Promise(resolve => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  });
};

export const estimateUsage = async (): Promise<?{|
  usage: number,
  quota: number,
|}> => {
  if (
    typeof navigator === 'undefined' ||
    !navigator.storage ||
    !navigator.storage.estimate
  ) {
    return null;
  }
  try {
    const estimate = await navigator.storage.estimate();
    return { usage: estimate.usage || 0, quota: estimate.quota || 0 };
  } catch (error) {
    return null;
  }
};
