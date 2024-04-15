import type { WaitUntilFn } from './shared'
import { getWaitUntilForNode } from './wait-until-node'

type Env = 'node' | 'minimal' | 'edge'

export function getWaitUntil(env: Env): WaitUntilFn {
  switch (env) {
    case 'minimal':
    case 'edge':
      return getWaitUntilForMinimalOrEdge()
    case 'node':
      return getWaitUntilForNode()
    default:
      throw new Error(`Cannot get waitUntil for unknown environent '${env}'`)
  }
}

const INTERNAL_REQUEST_CONTEXT_SYMBOL = Symbol.for('@vercel/request-context')

type GlobalThisWithRequestContext = typeof globalThis & {
  [INTERNAL_REQUEST_CONTEXT_SYMBOL]?: MinimalModeRequestContext
}

type MinimalModeRequestContext = {
  get(): { waitUntil: WaitUntilFn } | undefined
}

function getWaitUntilForMinimalOrEdge(): WaitUntilFn {
  const _globalThis = globalThis as GlobalThisWithRequestContext
  const ctx = _globalThis[INTERNAL_REQUEST_CONTEXT_SYMBOL]
  const waitUntilImpl = ctx?.get()?.waitUntil
  if (!waitUntilImpl) {
    throw new Error(`Could not access waitUntil from '@vercel/request-context'`)
  }
  return waitUntilImpl
}
