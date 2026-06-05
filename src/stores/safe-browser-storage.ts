import type { StateStorage } from 'zustand/middleware';

const OBSOLETE_BULKY_KEYS = [
  'ec9v3-chat',
  'ec9v3-chat-store',
  'chat-store',
  'conversation-store',
];

function isQuotaExceeded(error: unknown): boolean {
  return error instanceof DOMException && (
    error.name === 'QuotaExceededError' ||
    error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    error.code === 22 ||
    error.code === 1014
  );
}

export function pruneObsoleteBrowserStateStorage(currentKey = ''): void {
  if (typeof window === 'undefined') return;

  for (const key of OBSOLETE_BULKY_KEYS) {
    if (key !== currentKey) window.localStorage.removeItem(key);
  }

  for (let i = window.localStorage.length - 1; i >= 0; i--) {
    const key = window.localStorage.key(i);
    if (!key || key === currentKey) continue;
    if (/^ec9v3-(?:conversation|payload|message|tool|autoprompt)/i.test(key)) {
      window.localStorage.removeItem(key);
    }
  }
}

export function createQuotaSafeLocalStorage(): StateStorage {
  return {
    getItem: (name) => {
      if (typeof window === 'undefined') return null;
      return window.localStorage.getItem(name);
    },
    setItem: (name, value) => {
      if (typeof window === 'undefined') return;
      try {
        window.localStorage.setItem(name, value);
      } catch (error) {
        if (!isQuotaExceeded(error)) throw error;
        pruneObsoleteBrowserStateStorage(name);
        try {
          window.localStorage.setItem(name, value);
        } catch (retryError) {
          if (!isQuotaExceeded(retryError)) throw retryError;
          console.warn(`Could not persist ${name}: browser localStorage quota is full.`);
        }
      }
    },
    removeItem: (name) => {
      if (typeof window === 'undefined') return;
      window.localStorage.removeItem(name);
    },
  };
}
