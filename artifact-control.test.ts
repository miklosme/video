import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  getCharacterArtifactDescriptor,
  loadArtifactHistory,
  prepareStagedArtifactVersion,
  promoteArtifactVersion,
  recordArtifactVersionFromStage,
} from './artifact-control'

async function writeRepoFile(rootDir: string, relativePath: string, content: string | Uint8Array) {
  const filePath = path.resolve(rootDir, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content)
}

test('artifact history archives prior public artifacts and supports reselection', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-control-'))

  try {
    const descriptor = getCharacterArtifactDescriptor('hero')

    await writeRepoFile(rootDir, 'workspace/CHARACTERS/hero.png', 'v1-image')

    const staged = await prepareStagedArtifactVersion(descriptor, rootDir)
    expect(staged.versionId).toBe('v1')
    await writeRepoFile(rootDir, staged.stagedPath, 'v2-image')

    const recorded = await recordArtifactVersionFromStage({
      descriptor,
      stagedPath: staged.stagedPath,
      cwd: rootDir,
    })

    expect(recorded.versionId).toBe('v1')
    expect(await readFile(path.resolve(rootDir, descriptor.historyDir, 'v1.png'), 'utf8')).toBe(
      'v1-image',
    )
    expect(await readFile(path.resolve(rootDir, 'workspace/CHARACTERS/hero.png'), 'utf8')).toBe(
      'v2-image',
    )

    const historyAfterGeneration = await loadArtifactHistory(descriptor, rootDir)
    expect(historyAfterGeneration.versions.map((entry) => entry.versionId)).toEqual(['v1'])

    await promoteArtifactVersion(descriptor, 'v1', rootDir)

    expect(await readFile(path.resolve(rootDir, 'workspace/CHARACTERS/hero.png'), 'utf8')).toBe(
      'v1-image',
    )
    expect(await readFile(path.resolve(rootDir, descriptor.historyDir, 'v2.png'), 'utf8')).toBe(
      'v2-image',
    )

    const historyAfterPromotion = await loadArtifactHistory(descriptor, rootDir)
    expect(historyAfterPromotion.versions.map((entry) => entry.versionId)).toEqual(['v1', 'v2'])
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact history ignores legacy metadata json files', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-control-'))

  try {
    const descriptor = getCharacterArtifactDescriptor('hero')

    await writeRepoFile(
      rootDir,
      path.join(descriptor.historyDir, 'artifact.json'),
      '{"legacy":true}',
    )
    await writeRepoFile(rootDir, path.join(descriptor.historyDir, 'v1.json'), '{"seed":1}')
    await writeRepoFile(rootDir, path.join(descriptor.historyDir, 'v1.png'), 'v1-image')

    const history = await loadArtifactHistory(descriptor, rootDir)
    expect(history.versions.map((entry) => entry.versionId)).toEqual(['v1'])
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
