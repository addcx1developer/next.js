import { DetachedPromise } from '../../lib/detached-promise'

import {
  requestAsyncStorage,
  type RequestStore,
} from '../../client/components/request-async-storage.external'
import { staticGenerationAsyncStorage } from '../../client/components/static-generation-async-storage.external'

import { BaseServerSpan } from '../lib/trace/constants'
import { getTracer } from '../lib/trace/tracer'
import type { CacheScope } from './react-cache'
import { ResponseCookies } from '../web/spec-extension/cookies'

type AfterTask<T = unknown> = Promise<T> | AfterCallback<T>
type AfterCallback<T = unknown> = () => T | Promise<T>

type WaitUntilFn = <T>(promise: Promise<T>) => void

export function after<T>(task: AfterTask<T>) {
  const requestStore = requestAsyncStorage.getStore()
  if (!requestStore) {
    throw new Error(
      'Invalid after() call. after() can only be called:\n' +
        '  - from within a server component\n' +
        '  - in a route handler\n' + // TODO(after): not implemented
        '  - in a server action\n' + // TODO(after): not implemented
        '  - in middleware\n' // TODO(after): not implemented
    )
  }
  const { afterContext } = requestStore
  if (!afterContext) {
    throw new Error('Invariant: No afterContext in requestStore')
  }
  return afterContext.after(task)
}

export type AfterContext = ReturnType<typeof createAfter>

export function createAfter({
  waitUntil,
  cacheScope,
}: {
  waitUntil: WaitUntilFn
  cacheScope: CacheScope
}) {
  let isStaticGeneration: boolean | undefined = undefined
  let didWarnAboutAfterInStatic = false

  const keepaliveLock = createKeepaliveLock(waitUntil)
  const afterCallbacks: AfterCallback[] = []

  const afterImpl = (task: AfterTask) => {
    if (isStaticGeneration === undefined) {
      isStaticGeneration =
        staticGenerationAsyncStorage.getStore()?.isStaticGeneration ?? false
    }

    if (isStaticGeneration) {
      // do not run after() for prerenders and static generation.
      // TODO(after): how do we make this log only if no bailout happened?
      // capture the store and check if the page became fully static, maybe in app-render
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

  const runCallbacks = (requestStore: RequestStore) => {
    if (!afterCallbacks.length) return

    const runCallbacksImpl = () => {
      // callbacks can call after() again and schedule more callbacks,
      // so this can get mutated as we iterate.
      // TODO(after): might not work if after() is called after an await (and we don't await the callbacks here.)
      // when we start this loop, we should do something like patch .push to auto-run anything that gets added later
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
    }

    const readonlyRequestStore: RequestStore = {
      get headers() {
        return requestStore.headers
      },
      get cookies() {
        return requestStore.cookies
      },
      get draftMode() {
        return requestStore.draftMode
      },
      assetPrefix: requestStore.assetPrefix,
      reactLoadableManifest: requestStore.reactLoadableManifest,
      // make cookie writes go nowhere
      mutableCookies: new ResponseCookies(new Headers()),
      afterContext: {
        after: () => {
          throw new Error('Cannot call after() from within after()')
        },
        run: () => {
          throw new Error('Cannot call run() from within an after() callback')
        },
      },
    }

    requestAsyncStorage.run(readonlyRequestStore, () =>
      cacheScope.run(runCallbacksImpl)
    )
  }

  return {
    after: afterImpl,
    run: async <T>(requestStore: RequestStore, callback: () => T) => {
      try {
        const res = await cacheScope.run(() => callback())
        if (!isStaticGeneration) {
          runCallbacks(requestStore)
        }
        return res
      } finally {
        // if something failed, make sure we don't stay open forever.
        keepaliveLock.release()
      }
    },
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

function isPromise(p: unknown): p is Promise<unknown> {
  return (
    p !== null &&
    typeof p === 'object' &&
    'then' in p &&
    typeof p.then === 'function'
  )
}
