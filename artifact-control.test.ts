import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  ensureArtifactHistoryInitialized,
  getCharacterArtifactDescriptor,
  prepareStagedArtifactVersion,
  promoteArtifactVersion,
  recordArtifactVersionFromStage,
} from './artifact-control'

async function writeRepoFile(rootDir: string, relativePath: string, content: string | Uint8Array) {
  const filePath = path.resolve(rootDir, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content)
}

test('artifact history bootstraps from an existing public artifact and supports reselection', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-control-'))

  try {
    const descriptor = getCharacterArtifactDescriptor('hero')

    await writeRepoFile(rootDir, 'workspace/CHARACTERS/hero.png', 'v1-image')

    const bootstrapped = await ensureArtifactHistoryInitialized(descriptor, rootDir)

    expect(bootstrapped?.selectedVersionId).toBe('v1')
    expect(bootstrapped?.latestVersionId).toBe('v1')
    expect(await readFile(path.resolve(rootDir, descriptor.historyDir, 'v1.png'), 'utf8')).toBe(
      'v1-image',
    )

    const staged = await prepareStagedArtifactVersion(descriptor, rootDir)
    await writeRepoFile(rootDir, staged.stagedPath, 'v2-image')

    await recordArtifactVersionFromStage({
      descriptor,
      stagedPath: staged.stagedPath,
      baseVersionId: 'v1',
      generationId: 'gen-v2',
      editInstruction: 'Refresh the silhouette.',
      approvedActionSummary: 'Refresh the silhouette.',
      references: [],
      cwd: rootDir,
    })

    expect(await readFile(path.resolve(rootDir, 'workspace/CHARACTERS/hero.png'), 'utf8')).toBe(
      'v2-image',
    )

    await promoteArtifactVersion(descriptor, 'v1', rootDir)

    expect(await readFile(path.resolve(rootDir, 'workspace/CHARACTERS/hero.png'), 'utf8')).toBe(
      'v1-image',
    )

    const history = JSON.parse(
      await readFile(path.resolve(rootDir, descriptor.artifactControlPath), 'utf8'),
    )
    expect(history.latestVersionId).toBe('v2')
    expect(history.selectedVersionId).toBe('v1')
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
