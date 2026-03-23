import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { startArtifactReviewServer } from './artifact-review-server'

async function writeRepoFile(rootDir: string, relativePath: string, content: string | Uint8Array) {
  const filePath = path.resolve(rootDir, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content)
}

test('artifact review server renders the storyboard tab with a placeholder and raw markdown', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD.md',
      '# STORYBOARD\n\n## SHOT-01\n\n- Purpose: Establish the dog.\n',
    )

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/storyboard', server.url))
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).toContain('No storyboard image yet')
      expect(html).toContain('# STORYBOARD')
      expect(html).toContain('Source Storyboard')
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server serves the canonical storyboard image', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    await writeRepoFile(rootDir, 'workspace/STORYBOARD.png', new Uint8Array([1, 2, 3, 4]))

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/workspace/STORYBOARD.png', server.url))
      const bytes = new Uint8Array(await response.arrayBuffer())

      expect(response.status).toBe(200)
      expect([...bytes]).toEqual([1, 2, 3, 4])
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
