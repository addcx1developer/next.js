import fs from 'fs'
import { nextTestSetup } from 'e2e-utils'
import { join } from 'path'

describe('app-dir client-components-tree-shaking', () => {
  const { next, skipped } = nextTestSetup({
    files: __dirname,
    skipDeployment: true,
  })

  if (skipped) {
    return
  }

  it('should only include imported relative components in browser bundle with direct imports', async () => {
    const clientChunksDir = join(
      next.testDir,
      '.next',
      'static',
      'chunks',
      'app',
      'relative-dep'
    )
    const staticChunksDirents = fs.readdirSync(clientChunksDir, {
      withFileTypes: true,
    })
    const chunkContents = staticChunksDirents
      .filter((dirent) => dirent.isFile())
      .map((chunkDirent) =>
        fs.readFileSync(join(chunkDirent.path, chunkDirent.name), 'utf8')
      )
    expect(
      chunkContents.some((content) => content.includes('client-comp-imported'))
    ).toBe(true)
    expect(
      chunkContents.every((content) => content.includes('client-comp-unused'))
    ).toBe(false)
    expect(
      chunkContents.every((content) => content.includes('client-comp-default'))
    ).toBe(false)
  })

  it('should only include imported components 3rd party package in browser bundle with direct imports', async () => {
    const clientChunksDir = join(
      next.testDir,
      '.next',
      'static',
      'chunks',
      'app',
      'third-party-dep'
    )
    const staticChunksDirents = fs.readdirSync(clientChunksDir, {
      withFileTypes: true,
    })
    const chunkContents = staticChunksDirents
      .filter((dirent) => dirent.isFile())
      .map((chunkDirent) =>
        fs.readFileSync(join(chunkDirent.path, chunkDirent.name), 'utf8')
      )
    expect(
      chunkContents.some((content) => content.includes('client-dep-bar:esm'))
    ).toBe(true)
    expect(
      chunkContents.every((content) => content.includes('client-dep-foo:esm'))
    ).toBe(false)
    expect(
      chunkContents.every((content) =>
        content.includes('client-dep-default:esm')
      )
    ).toBe(false)
  })

  it('should only include the imported identifier of CJS module in browser bundle', async () => {
    const clientChunksDir = join(
      next.testDir,
      '.next',
      'static',
      'chunks',
      'app',
      'cjs-dep'
    )

    const chunkContents = fs
      .readdirSync(clientChunksDir, {
        withFileTypes: true,
      })
      .filter((dirent) => dirent.isFile())
      .map((chunkDirent) =>
        fs.readFileSync(join(chunkDirent.path, chunkDirent.name), 'utf8')
      )

    expect(
      chunkContents.some((content) => content.includes('cjs-client:default'))
    ).toBe(true)
    expect(
      chunkContents.every((content) => content.includes('cjs-client:foo'))
    ).toBe(false)
  })

  it('should able to resolve the client module entry with mixing rexports', async () => {
    const $ = await next.render$('/client-reexport-index')

    expect($('p').text()).toContain('client:mod-export-default')
  })
})
