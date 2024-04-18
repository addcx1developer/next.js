import { AsyncLocalStorage } from 'async_hooks'
import { DetachedPromise } from '../../lib/detached-promise'

import {
  requestAsyncStorage,
  type RequestStore,
} from '../../client/components/request-async-storage.external'
import { staticGenerationAsyncStorage } from '../../client/components/static-generation-async-storage.external'

import { BaseServerSpan } from '../lib/trace/constants'
import { getTracer } from '../lib/trace/tracer'
import {
  CacheDispatcherCacheStorage,
  createCacheMap,
  runWithReactCacheDispatcher,
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
  let outerStore = afterAsyncStorage.getStore()
  if (outerStore) {
    return callback(outerStore)
  }

  let isStaticGeneration: boolean | undefined = undefined
  let didWarnAboutAfterInStatic = false

  const keepaliveLock = createKeepaliveLock(waitUntil)
  const afterCallbacks: AfterCallback[] = []

  const cache = createCacheMap()

  type CapturedContext = {
    requestStore: RequestStore
  }

  let context: CapturedContext | undefined = undefined

  const captureContext = (): CapturedContext => {
    const requestStore = requestAsyncStorage.getStore()
    if (!requestStore) {
      throw new Error('Invariant: requestAsyncStorage not found')
    }

    return {
      requestStore,
    }
  }

  const afterImpl = (task: AfterTask) => {
    if (isStaticGeneration === undefined) {
      isStaticGeneration =
        staticGenerationAsyncStorage.getStore()?.isStaticGeneration ?? false
    }

    if (isStaticGeneration) {
      // do not run after() for prerenders and static generation.
      // TODO(after): how do we make this log only if no bailout happened?
      if (!didWarnAboutAfterInStatic) {
        const Log = require('../../build/output/log')
        const { yellow } = require('../../lib/picocolors')
        Log.warn(
          yellow(
            'A statically rendered page is using after(), which will not be executed for prerendered pages.'
          )
        )
        didWarnAboutAfterInStatic = true
      }
      return
    }

    if (!context) {
      context = captureContext()
    }

    if (isPromise(task)) {
      task.catch(() => {}) // avoid unhandled rejection crashes
      waitUntil(task)
    } else if (typeof task === 'function') {
      keepaliveLock.acquire()

      // TODO(after): will this trace correctly?
      afterCallbacks.push(() =>
        getTracer().trace(BaseServerSpan.after, () => task())
      )
    } else {
      throw new Error('after() must receive a promise or a function')
    }
  }

  const store: AfterStore = {
    after: afterImpl,
  }

  const runCallbacks = () => {
    if (!afterCallbacks.length) return

    if (!context) {
      throw new Error(
        // TODO(after): how do we do error messages like this?
        'Invariant: did not capture request context for after() callbacks'
      )
    }
    const { requestStore } = context

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

      keepaliveLock.release()
    }

    afterAsyncStorage.run(store, () =>
      requestAsyncStorage.run(requestStore, () =>
        runWithReactCacheDispatcher(cache, getReact(), runCallbacksImpl)
      )
    )
  }

  try {
    const res = await CacheDispatcherCacheStorage.run(cache, () =>
      afterAsyncStorage.run(store, callback, store)
    )
    if (!isStaticGeneration) {
      runCallbacks()
    }
    return res
  } finally {
    // if something failed, make sure we don't stay open forever.
    keepaliveLock.release()
  }
}

function createKeepaliveLock(waitUntil: WaitUntilFn) {
  // callbacks can't go directly into waitUntil,
  // and we don't want a function invocation to get stopped *before* we execute the callbacks,
  // so block with a dummy promise that we'll resolve when we're done.
  let keepalivePromise: DetachedPromise<void> | undefined
  return {
    isLocked() {
      return !!keepalivePromise
    },
    acquire() {
      if (!keepalivePromise) {
        keepalivePromise = new DetachedPromise<void>()
        waitUntil(keepalivePromise.promise)
      }
    },
    release() {
      if (keepalivePromise) {
        keepalivePromise.resolve(undefined)
        keepalivePromise = undefined
      }
    },
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
