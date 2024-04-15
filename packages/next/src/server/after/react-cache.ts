import { AsyncLocalStorage } from 'async_hooks'
import { requestAsyncStorage } from '../../client/components/request-async-storage.external'

export type CacheDispatcher = {
  __nextPatched?: boolean
  getCacheForType: <T>(create: () => T) => T
}

type ReactWithServerInternals = typeof import('react') &
  ReactServerInternalProperties

type ReactServerInternalProperties =
  | ReactServerSharedInternalsOld
  | ReactServerSharedInternalsNew

type ReactServerSharedInternalsOld = {
  __SECRET_SERVER_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
    ReactCurrentCache: {
      current: CacheDispatcher | null
    }
  }
}

type ReactServerSharedInternalsNew = {
  __SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
    C: {
      current: CacheDispatcher | null
    }
  }
}

function getReactCurrentCacheRef(React: typeof import('react')) {
  const _React = React as ReactWithServerInternals

  const keyOld = '__SECRET_SERVER_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED'
  if (keyOld in _React) {
    return _React[keyOld].ReactCurrentCache
  }
  const keyNew =
    '__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE'
  if (keyNew in _React) {
    return _React[keyNew].C
  }

  throw new Error('Internal error: Unable to access react cache internals')
}

export function patchCacheDispatcherWhenSet(React: typeof import('react')) {
  const ReactCurrentCache = getReactCurrentCacheRef(React)
  if (ReactCurrentCache.current) {
    patchReactCache(ReactCurrentCache.current)
  } else {
    let current: (typeof ReactCurrentCache)['current'] = null
    Object.defineProperty(ReactCurrentCache, 'current', {
      get: () => current,
      set: (maybeDispatcher) => {
        try {
          if (maybeDispatcher) {
            patchReactCache(maybeDispatcher)
          }
        } catch (err) {
          console.error('Internal error: could not patch cache the dispatcher')
        }
        current = maybeDispatcher
      },
    })
  }
}

export function getReactCacheDispatcher(
  React: typeof import('react')
): CacheDispatcher | null {
  const ReactCurrentCache = getReactCurrentCacheRef(React)
  return ReactCurrentCache.current
}

export function patchReactCache(dispatcher: CacheDispatcher) {
  if (dispatcher.__nextPatched) {
    return
  }
  const { getCacheForType: originalGetCacheForType } = dispatcher

  dispatcher.getCacheForType = function <T>(create: () => T) {
    if (shouldInterceptCache()) {
      return PatchedCacheDispatcher.getCacheForType(create)
    }
    return originalGetCacheForType.call(dispatcher, create) as T
  }
  dispatcher.__nextPatched = true
}

//==================================

type CacheMap = Map<Function, unknown>

export function createCacheMap(): CacheMap {
  return new Map()
}

function shouldInterceptCache() {
  return !!CacheDispatcherCacheStorage.getStore()
}

const CACHE_STORAGE_SYMBOL = Symbol.for('next.CacheDispatcherCacheStorage')

export const CacheDispatcherCacheStorage: AsyncLocalStorage<CacheMap> =
  // @ts-expect-error
  globalThis[CACHE_STORAGE_SYMBOL] ||
  // @ts-expect-error
  (globalThis[CACHE_STORAGE_SYMBOL] = new AsyncLocalStorage<CacheMap>())

/** forked from packages/react-server/src/flight/ReactFlightServerCache.js */
function resolveCache(): CacheMap {
  const store = CacheDispatcherCacheStorage.getStore()
  if (store) {
    return store
  }
  return createCacheMap()
}

/** forked from packages/react-server/src/flight/ReactFlightServerCache.js */
export const PatchedCacheDispatcher: CacheDispatcher = {
  getCacheForType<T>(resourceType: () => T): T {
    if (!shouldInterceptCache()) {
      throw new Error(
        'Internal error: Expected patched cache dispatcher to run within CacheDispatcherCacheStorage'
      )
    }
    const cache = resolveCache()
    let entry: T | undefined = cache.get(resourceType) as any
    if (entry === undefined) {
      entry = resourceType()
      // TODO: Warn if undefined?
      cache.set(resourceType, entry)
    }
    return entry
  },
}

//=====================================

export async function runWithReactCacheDispatcher<T>(
  cache: CacheMap,
  React: typeof import('react'),
  callback: () => T
): Promise<T> {
  const ReactCurrentCache = getReactCurrentCacheRef(React)
  if (!ReactCurrentCache) return callback()

  const prev = ReactCurrentCache.current
  ReactCurrentCache.current = PatchedCacheDispatcher
  try {
    return await CacheDispatcherCacheStorage.run(cache, callback)
  } finally {
    ReactCurrentCache.current = prev
  }
}
