import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

test('artifact review server renders an empty keyframes placeholder when KEYFRAMES.json is missing', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/keyframes', server.url))
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).toContain('No keyframes yet.')
      expect(html).toContain('Keyframes')
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server renders the shots tab with prompt metadata and a missing-video placeholder', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/SHOTS.json',
      `${JSON.stringify(
        [
          {
            shotId: 'SHOT-01',
            status: 'planned',
            videoPath: 'workspace/SHOTS/SHOT-01.mp4',
            keyframeIds: ['SHOT-01-START', 'SHOT-01-END'],
            durationSeconds: 4,
            incomingTransition: {
              type: 'opening',
              notes: 'Open the sequence.',
            },
          },
        ],
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(
      rootDir,
      'workspace/SHOTS/SHOT-01.json',
      `${JSON.stringify(
        {
          shotId: 'SHOT-01',
          model: 'video-test',
          prompt: 'The camera glides from the start frame into the end frame.',
          status: 'ready',
        },
        null,
        2,
      )}\n`,
    )

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/shots', server.url))
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).toContain('Shots')
      expect(html).toContain('SHOT-01')
      expect(html).toContain('The camera glides from the start frame into the end frame.')
      expect(html).toContain('SHOT-01-START -&gt; SHOT-01-END')
      expect(html).toContain('No video yet')
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

test('artifact review server serves the canonical shot video', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/SHOTS.json',
      `${JSON.stringify(
        [
          {
            shotId: 'SHOT-01',
            status: 'planned',
            videoPath: 'workspace/SHOTS/SHOT-01.mp4',
            keyframeIds: ['SHOT-01-START', 'SHOT-01-END'],
            durationSeconds: 4,
            incomingTransition: {
              type: 'opening',
              notes: 'Open the sequence.',
            },
          },
        ],
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(rootDir, 'workspace/SHOTS/SHOT-01.mp4', new Uint8Array([9, 8, 7, 6]))

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/workspace/SHOTS/SHOT-01.mp4', server.url))
      const bytes = new Uint8Array(await response.arrayBuffer())

      expect(response.status).toBe(200)
      expect([...bytes]).toEqual([9, 8, 7, 6])
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server boots retained history for an existing character and saves reference edits', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/CHARACTERS/hero.json',
      `${JSON.stringify(
        {
          characterId: 'hero',
          displayName: 'Hero',
          model: 'image-test',
          prompt: 'A clean character reference.',
          status: 'ready',
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(rootDir, 'workspace/CHARACTERS/hero.png', 'hero-image')

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const detailResponse = await fetch(new URL('/characters/hero', server.url))
      const detailHtml = await detailResponse.text()

      expect(detailResponse.status).toBe(200)
      expect(detailHtml).toContain('Retained History')
      expect(detailHtml).toContain('v1')

      const saveResponse = await fetch(new URL('/characters/hero/references', server.url), {
        method: 'POST',
        body: new URLSearchParams({
          referencesJson: JSON.stringify([
            {
              path: 'workspace/REFERENCES/pose.png',
              label: 'Pose',
              role: 'composition',
            },
          ]),
        }),
      })

      expect(saveResponse.status).toBe(200)

      const sidecar = JSON.parse(
        await readFile(path.resolve(rootDir, 'workspace/CHARACTERS/hero.json'), 'utf8'),
      )
      expect(sidecar.references).toEqual([
        {
          path: 'workspace/REFERENCES/pose.png',
          label: 'Pose',
          role: 'composition',
        },
      ])
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server renders an approval preview for storyboard edits', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD.md',
      '# STORYBOARD\n\n## SHOT-01\n\n- Purpose: Establish the dog.\n',
    )
    await writeRepoFile(rootDir, 'workspace/STORYBOARD.png', 'storyboard-image')

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/storyboard/approve', server.url), {
        method: 'POST',
        body: new URLSearchParams({
          baseVersionId: 'v1',
          editInstruction: 'Tighten the panel spacing and simplify the captions.',
        }),
      })
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).toContain('Approve storyboard edit')
      expect(html).toContain('Tighten the panel spacing and simplify the captions.')
      expect(html).toContain('Storyboard template')
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
