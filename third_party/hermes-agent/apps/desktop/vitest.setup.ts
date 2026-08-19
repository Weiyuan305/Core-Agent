import { configure } from '@testing-library/react'

// Node 25+ defines its own `localStorage` accessor on the global object. With
// no valid --localstorage-file it may resolve to undefined or to an empty
// object whose Storage methods are all missing. In the jsdom environment
// `globalThis` IS the window, so that accessor shadows jsdom's Storage. Install
// a real in-memory Storage before any test module reads the broken global.
const currentLocalStorage = (globalThis as any).localStorage
const hasUsableLocalStorage =
  currentLocalStorage !== null &&
  typeof currentLocalStorage === 'object' &&
  ['getItem', 'setItem', 'removeItem', 'clear', 'key'].every(
    (method) => typeof currentLocalStorage[method] === 'function',
  )

if (!hasUsableLocalStorage) {
  const store = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return store.size
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(String(k)) ?? null,
    setItem: (k: string, v: string) => void store.set(String(k), String(v)),
    removeItem: (k: string) => void store.delete(String(k)),
    clear: () => store.clear(),
  }
  for (const target of [globalThis, (globalThis as any).window].filter(Boolean)) {
    Object.defineProperty(target, 'localStorage', {
      value: storage,
      configurable: true,
      writable: true,
    })
  }
}

// React 19 + Testing Library 16: opt into the act environment so render(),
// fireEvent(), and findBy* queries automatically flush state updates without
// spurious "not wrapped in act(...)" warnings.
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// findBy*/waitFor default to a 1000ms deadline — too tight for async-heavy
// panels (radix menus, refetch chains) when the full suite runs under xdist
// CPU contention in CI. Success still resolves the instant the node appears;
// the wider deadline only absorbs a starved runner, killing timing flakes.
configure({ asyncUtilTimeout: 5000 })
