import { AsyncLocalStorage } from 'async_hooks'
import { DetachedPromise } from '../../lib/detached-promise'
import {
  type RequestStore,
  requestAsyncStorage,
} from '../../client/components/request-async-storage.external'
import {
  runWithReactCacheDispatcher,
  type CacheDispatcher,
  getReactCacheDispatcher,
  createCacheMap,
  CacheDispatcherCacheStorage,
} from './react-cache'

type AfterStore = {
  after: AfterFn
}

type AfterTask<T = unknown> = Promise<T> | AfterCallback<T>
type AfterCallback<T = unknown> = () => T | Promise<T>

type WaitUntilFn = <T>(promise: Promise<T>) => void
type AfterFn = <T>(promiseOrCallback: AfterTask<T>) => void

const STORAGE_SYMBOL = Symbol.for('next.afterAsyncStorage')
const _globalThis = globalThis as typeof globalThis & {
  [STORAGE_SYMBOL]?: AsyncLocalStorage<AfterStore>
}

const afterAsyncStorage =
  _globalThis[STORAGE_SYMBOL] ||
  (_globalThis[STORAGE_SYMBOL] = new AsyncLocalStorage<AfterStore>())

export function after<T>(task: AfterTask<T>) {
  const store = afterAsyncStorage.getStore()
  if (!store) {
    throw new Error(
      'Invalid after() call. after() can only be called:\n' +
        '  - from within a server component\n' +
        '  - in a route handler\n' + // TODO(after): not implemented
        '  - in a server action\n' + // TODO(after): not implemented
        '  - in middleware\n' // TODO(after): not implemented
    )
  }
  store.after(task)
}

// TODO(after): maybe we factor out the waitUntil and just return a combined promise here? not sure
export async function runWithAfter<T>(
  waitUntil: WaitUntilFn,
  callback: (store: AfterStore) => T
) {
  // console.error('runWithAfter', { waitUntil })
  let outerStore = afterAsyncStorage.getStore()
  if (outerStore) {
    return callback(outerStore)
  }

  const afterCallbacks: AfterCallback[] = []
  let callbacksExecutedPromise: DetachedPromise | undefined

  let capturedRequestStore: RequestStore | undefined = undefined
  let capturedCacheDispatcher: CacheDispatcher | null | undefined = undefined
  const cache = createCacheMap()

  const afterImpl = (task: AfterTask) => {
    // console.trace('after()', task)
    if (capturedRequestStore === undefined) {
      capturedRequestStore = requestAsyncStorage.getStore()
      // console.debug(
      //   'after :: Captured requestAsyncStorage',
      //   capturedRequestStore
      // )
    }
    if (capturedCacheDispatcher === undefined) {
      const React = getReact()
      capturedCacheDispatcher = getReactCacheDispatcher(React)
      if (capturedCacheDispatcher) {
        // patchReactCache(capturedCacheDispatcher)
        // console.debug(
        //   'after :: Captured requestAsyncStorage',
        //   capturedRequestStore
        // )
      } else {
        console.error('Internal error in after(): no cache dispatcher found')
      }
    }

    if (isPromise(task)) {
      task.catch(() => {}) // avoid unhandled rejection crashes
      waitUntil(task)
    } else if (typeof task === 'function') {
      if (!callbacksExecutedPromise) {
        // we don't want a worker/lambda to get stopped after the request closes but *before* we execute callbacks,
        // so block with a dummy promise that we'll resolve when we're done.
        callbacksExecutedPromise = new DetachedPromise<void>()
        waitUntil(callbacksExecutedPromise.promise)
      }
      afterCallbacks.push(task)
    } else {
      throw new Error('after() must receive a promise or a function')
    }
  }

  const store: AfterStore = {
    after: afterImpl,
  }

  const runCallbacks = () => {
    if (!afterCallbacks.length) return

    const requestStore = capturedRequestStore
    const cacheDispatcher = capturedCacheDispatcher

    // console.log('running after() callbacks', {
    //   requestStore,
    //   cacheDispatcher,
    // })

    if (requestStore === undefined) {
      throw new Error(
        // TODO(after): how do we do error messages like this?
        'Internal error: did not capture request context for after() callbacks'
      )
    }

    if (cacheDispatcher === undefined) {
      throw new Error(
        // TODO(after): how do we do error messages like this?
        'Internal error: did not capture cache dispatcher request context for after() callbacks'
      )
    }

    // TODO(after): warn for cache() too when that's fixed

    const runCallbacksImpl = () => {
      // callbacks can call after() again and schedule more callbacks,
      // so this can get mutated as we iterate.
      while (afterCallbacks.length) {
        const afterCallback = afterCallbacks.shift()!

        // catch errors in case the callback throws synchronously or does not return a promise.
        // promise rejections will be handled by waitUntil.
        try {
          const ret = afterCallback()

          if (isPromise(ret)) {
            waitUntil(ret)
          }
        } catch (err) {
          // TODO(after): how do we report errors here?
          console.error(
            'An error occurred in a function passed to after()',
            err
          )
        }
      }

      if (callbacksExecutedPromise) {
        callbacksExecutedPromise.resolve(undefined)
      }
    }

    afterAsyncStorage.run(store, () =>
      requestAsyncStorage.run(requestStore, () =>
        runWithReactCacheDispatcher(cache, getReact(), runCallbacksImpl)
      )
    )
  }

  try {
    return await CacheDispatcherCacheStorage.run(cache, () =>
      afterAsyncStorage.run(store, callback, store)
    )
    // TODO(after): it'd be idea to patch the dispatcher at the beginning of the render to capture everything,
    // but in practice getCacheForType is only called with one argument, so any call we capture should be fine
    // return await runWithReactCache(cache, () =>
    //   afterAsyncStorage.run(store, callback, store)
    // )
  } finally {
    runCallbacks()
  }
}

function getReact() {
  // TODO(after): it kinda sucks to inject React via RAS...
  // @ts-expect-error
  return requestAsyncStorage.getStore()['React'] as typeof import('react')
}

// TODO(after): factor out?
function isPromise(p: unknown): p is Promise<unknown> {
  return (
    p !== null &&
    typeof p === 'object' &&
    'then' in p &&
    typeof p.then === 'function'
  )
}
