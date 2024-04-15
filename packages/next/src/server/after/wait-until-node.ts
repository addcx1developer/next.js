import { AsyncLocalStorage } from 'async_hooks'
import type { WaitUntilFn } from './shared'
import { getTracer } from '../lib/trace/tracer'
import { NextNodeServerSpan } from '../lib/trace/constants'

/** A polyfill of waitUntil for non-serverless environments */
export function createNodeWaitUntil() {
  const promises = new Set<Promise<unknown>>()

  const waitUntil = (promise: Promise<unknown>) => {
    promises.add(promise.catch(() => {}))
  }

  const finish = async () => {
    await Promise.allSettled([...promises.values()])
  }

  return { waitUntil, finish }
}

export const waitUntilStorage = new AsyncLocalStorage<WaitUntilFn>()

export async function runWithNodeWaitUntil<T>(callback: () => T): Promise<T> {
  const ctx = createNodeWaitUntil()
  try {
    return await waitUntilStorage.run(ctx.waitUntil, callback)
  } finally {
    // TODO(after): requestAsyncStorage, cache()
    await getTracer().trace(NextNodeServerSpan.runAfterCallbacks, () =>
      ctx.finish()
    )
  }
}

export function getWaitUntilForNode(): WaitUntilFn {
  const waitUntilImpl = waitUntilStorage.getStore()
  if (!waitUntilImpl) {
    throw new Error('waitUntil is not available in the current environment')
  }
  return waitUntilImpl
}
