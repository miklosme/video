import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runApprovedRegenerateAction, startArtifactReviewServer } from './artifact-review-server'

async function writeRepoFile(rootDir: string, relativePath: string, content: string | Uint8Array) {
  const filePath = path.resolve(rootDir, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content)
}

async function writeCharacterArtifactFixture(rootDir: string) {
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
  await writeRepoFile(rootDir, 'workspace/CHARACTERS/hero.png', 'hero-current-image')
  await writeRepoFile(rootDir, 'workspace/CHARACTERS/HISTORY/hero/v1.png', 'hero-v1-image')
  await writeRepoFile(rootDir, 'workspace/CHARACTERS/HISTORY/hero/v2.png', 'hero-v2-image')
}

async function writeConfigFixture(
  rootDir: string,
  overrides: Partial<{
    agentModel: string
    imageModel: string
    videoModel: string
    variantCount: number
  }> = {},
) {
  await writeRepoFile(
    rootDir,
    'workspace/CONFIG.json',
    `${JSON.stringify(
      {
        agentModel: 'agent-test',
        imageModel: 'image-test',
        videoModel: 'video-test',
        variantCount: 1,
        ...overrides,
      },
      null,
      2,
    )}\n`,
  )
}

async function waitFor(check: () => Promise<void>, timeoutMs = 2000) {
  const startedAt = Date.now()
  let lastError: unknown = null

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await check()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  throw lastError ?? new Error('Timed out waiting for async artifact review work to finish.')
}

function createPlannedKeyframes(keyframeIds: string[]) {
  return keyframeIds.map((keyframeId) => ({
    keyframeId,
    frameType: keyframeId.endsWith('-END') ? ('end' as const) : ('start' as const),
    imagePath: `workspace/KEYFRAMES/${keyframeId.slice(0, 7)}/${keyframeId}.png`,
  }))
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

test('artifact review server renders a neutral placeholder for an omitted keyframe anchor', async () => {
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
            durationSeconds: 4,
            incomingTransition: {
              type: 'opening',
              notes: 'Open directly on the closing pose.',
            },
            keyframes: createPlannedKeyframes(['SHOT-01-END']),
          },
        ],
        null,
        2,
      )}\n`,
    )

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/keyframes', server.url))
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).toContain('SHOT-01-END')
      expect(html).toContain('No start keyframe planned')
      expect(html).toContain('href="/keyframes/SHOT-01-START"')
      expect(html).not.toContain('Missing start frame')
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server renders an omitted keyframe detail page with a create action', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    await writeConfigFixture(rootDir)
    await writeRepoFile(
      rootDir,
      'workspace/SHOTS.json',
      `${JSON.stringify(
        [
          {
            shotId: 'SHOT-01',
            status: 'planned',
            videoPath: 'workspace/SHOTS/SHOT-01.mp4',
            durationSeconds: 4,
            incomingTransition: {
              type: 'opening',
              notes: 'Open the sequence.',
            },
            keyframes: createPlannedKeyframes(['SHOT-01-START']),
          },
        ],
        null,
        2,
      )}\n`,
    )

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/keyframes/SHOT-01-END', server.url))
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).toContain('SHOT-01-END')
      expect(html).toContain('No end keyframe planned')
      expect(html).toContain('action="/keyframes/SHOT-01-END/create"')
      expect(html).toContain('Create keyframe')
      expect(html).toContain('No source prompt available for this artifact.')
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server creates an omitted keyframe, saves the prompt sidecar, and generates a single image variant', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))
  const seeds: number[] = []

  try {
    await writeConfigFixture(rootDir, { variantCount: 3 })
    await writeRepoFile(
      rootDir,
      'workspace/SHOTS.json',
      `${JSON.stringify(
        [
          {
            shotId: 'SHOT-01',
            status: 'planned',
            videoPath: 'workspace/SHOTS/SHOT-01.mp4',
            durationSeconds: 4,
            incomingTransition: {
              type: 'opening',
              notes: 'Open the sequence.',
            },
            keyframes: createPlannedKeyframes(['SHOT-01-START']),
          },
        ],
        null,
        2,
      )}\n`,
    )

    const server = startArtifactReviewServer({
      cwd: rootDir,
      preferredPort: 0,
      imageGenerator: async (input) => {
        seeds.push(input.seed ?? -1)

        if (!input.outputPath) {
          throw new Error('Expected outputPath for created keyframe generation test.')
        }

        await writeRepoFile(rootDir, input.outputPath, 'generated-end')

        return {
          generationId: 'gen-keyframe-create',
          model: input.model ?? 'image-test',
          outputPaths: [path.resolve(rootDir, input.outputPath)],
        }
      },
    })

    try {
      const response = await fetch(new URL('/keyframes/SHOT-01-END/create', server.url), {
        method: 'POST',
        redirect: 'manual',
        body: new URLSearchParams({
          prompt: 'A fully distinct closing frame with the rider turning toward camera.',
        }),
      })

      expect(response.status).toBe(303)
      expect(response.headers.get('location')).toBe('/keyframes/SHOT-01-END')

      await waitFor(async () => {
        expect(
          await readFile(
            path.resolve(rootDir, 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png'),
            'utf8',
          ),
        ).toBe('generated-end')
      })

      const shots = JSON.parse(
        await readFile(path.resolve(rootDir, 'workspace/SHOTS.json'), 'utf8'),
      )
      const createdSidecar = JSON.parse(
        await readFile(
          path.resolve(rootDir, 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.json'),
          'utf8',
        ),
      )

      expect(shots[0].keyframes).toEqual([
        {
          keyframeId: 'SHOT-01-START',
          frameType: 'start',
          imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
        },
        {
          keyframeId: 'SHOT-01-END',
          frameType: 'end',
          imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png',
        },
      ])
      expect(createdSidecar).toEqual({
        keyframeId: 'SHOT-01-END',
        shotId: 'SHOT-01',
        frameType: 'end',
        model: 'image-test',
        prompt: 'A fully distinct closing frame with the rider turning toward camera.',
        status: 'draft',
      })
      expect(seeds).toEqual([1])
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server removes an end keyframe and leaves the shot start-only', async () => {
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
            durationSeconds: 4,
            incomingTransition: {
              type: 'opening',
              notes: 'Open the sequence.',
            },
            keyframes: createPlannedKeyframes(['SHOT-01-START', 'SHOT-01-END']),
          },
        ],
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(
      rootDir,
      'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.json',
      `${JSON.stringify(
        {
          keyframeId: 'SHOT-01-END',
          shotId: 'SHOT-01',
          frameType: 'end',
          model: 'image-test',
          prompt: 'A distinct closing frame.',
          status: 'draft',
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(rootDir, 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png', 'end-image')
    await writeRepoFile(
      rootDir,
      'workspace/KEYFRAMES/SHOT-01/HISTORY/SHOT-01-END/v1.png',
      'end-v1-image',
    )

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/keyframes/SHOT-01-END/remove', server.url), {
        method: 'POST',
        redirect: 'manual',
      })

      expect(response.status).toBe(303)
      expect(response.headers.get('location')).toBe('/keyframes/SHOT-01-END')

      const shots = JSON.parse(
        await readFile(path.resolve(rootDir, 'workspace/SHOTS.json'), 'utf8'),
      )
      expect(shots[0].keyframes).toEqual([
        {
          keyframeId: 'SHOT-01-START',
          frameType: 'start',
          imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
        },
      ])

      await expect(
        readFile(path.resolve(rootDir, 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.json'), 'utf8'),
      ).rejects.toThrow()
      await expect(
        readFile(path.resolve(rootDir, 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png'), 'utf8'),
      ).rejects.toThrow()
      await expect(
        readFile(
          path.resolve(rootDir, 'workspace/KEYFRAMES/SHOT-01/HISTORY/SHOT-01-END/v1.png'),
          'utf8',
        ),
      ).rejects.toThrow()

      const detailResponse = await fetch(new URL('/keyframes/SHOT-01-END', server.url))
      const html = await detailResponse.text()

      expect(detailResponse.status).toBe(200)
      expect(html).toContain('No end keyframe planned')
      expect(html).toContain('action="/keyframes/SHOT-01-END/create"')
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server removes a start keyframe and leaves the shot end-only', async () => {
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
            durationSeconds: 4,
            incomingTransition: {
              type: 'opening',
              notes: 'Open directly on the closing pose.',
            },
            keyframes: createPlannedKeyframes(['SHOT-01-START', 'SHOT-01-END']),
          },
        ],
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(
      rootDir,
      'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.json',
      `${JSON.stringify(
        {
          keyframeId: 'SHOT-01-START',
          shotId: 'SHOT-01',
          frameType: 'start',
          model: 'image-test',
          prompt: 'An opening frame.',
          status: 'draft',
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(rootDir, 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png', 'start-image')

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/keyframes/SHOT-01-START/remove', server.url), {
        method: 'POST',
        redirect: 'manual',
      })

      expect(response.status).toBe(303)
      expect(response.headers.get('location')).toBe('/keyframes/SHOT-01-START')

      const shots = JSON.parse(
        await readFile(path.resolve(rootDir, 'workspace/SHOTS.json'), 'utf8'),
      )
      expect(shots[0].keyframes).toEqual([
        {
          keyframeId: 'SHOT-01-END',
          frameType: 'end',
          imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png',
        },
      ])
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server rejects removing the last remaining anchor', async () => {
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
            durationSeconds: 4,
            incomingTransition: {
              type: 'opening',
              notes: 'Open the sequence.',
            },
            keyframes: createPlannedKeyframes(['SHOT-01-START']),
          },
        ],
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(
      rootDir,
      'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.json',
      `${JSON.stringify(
        {
          keyframeId: 'SHOT-01-START',
          shotId: 'SHOT-01',
          frameType: 'start',
          model: 'image-test',
          prompt: 'An opening frame.',
          status: 'draft',
        },
        null,
        2,
      )}\n`,
    )

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/keyframes/SHOT-01-START/remove', server.url), {
        method: 'POST',
      })
      const html = await response.text()

      expect(response.status).toBe(400)
      expect(html).toContain('Shot &quot;SHOT-01&quot; must keep at least one planned anchor.')
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
            durationSeconds: 4,
            incomingTransition: {
              type: 'opening',
              notes: 'Open the sequence.',
            },
            keyframes: createPlannedKeyframes(['SHOT-01-START', 'SHOT-01-END']),
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
            durationSeconds: 4,
            incomingTransition: {
              type: 'opening',
              notes: 'Open the sequence.',
            },
            keyframes: createPlannedKeyframes(['SHOT-01-START', 'SHOT-01-END']),
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

test('artifact review server shows version history for an existing character and saves reference edits', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    await writeCharacterArtifactFixture(rootDir)

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const detailResponse = await fetch(new URL('/characters/hero', server.url))
      const detailHtml = await detailResponse.text()

      expect(detailResponse.status).toBe(200)
      expect(detailHtml).toContain('class="version-badges"')
      expect(detailHtml).not.toContain('Version History')
      expect(detailHtml).toContain('data-version-id="current"')
      expect(detailHtml).toContain('data-version-id="v2"')
      expect(detailHtml).toContain('data-version-id="v1"')

      const saveResponse = await fetch(new URL('/characters/hero/references', server.url), {
        method: 'POST',
        body: new URLSearchParams({
          referencesJson: JSON.stringify([
            {
              path: 'workspace/REFERENCES/pose.png',
              kind: 'user-reference',
              label: 'Pose',
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
          kind: 'user-reference',
          label: 'Pose',
        },
      ])
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server renders the version rail current first, then retained versions newest first, with direct regenerate controls', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    await writeCharacterArtifactFixture(rootDir)

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/characters/hero', server.url))
      const html = await response.text()

      expect(response.status).toBe(200)
      const currentIndex = html.indexOf('data-version-id="current"')
      const v2Index = html.indexOf('data-version-id="v2"')
      const v1Index = html.indexOf('data-version-id="v1"')

      expect(currentIndex).toBeGreaterThan(-1)
      expect(v2Index).toBeGreaterThan(-1)
      expect(v1Index).toBeGreaterThan(-1)
      expect(currentIndex).toBeLessThan(v2Index)
      expect(v2Index).toBeLessThan(v1Index)
      expect(html).toContain('class="version-badges"')
      expect(html).not.toContain('Version History')
      expect(html).not.toContain(
        'Current artifact first, then retained versions in descending order.',
      )
      expect(html).not.toContain('Public artifact')
      expect(html).not.toContain('Retained version')
      expect(html).not.toContain('version-tile-copy')
      expect(html).toContain('Regenerate')
      expect(html).not.toContain('Edit Request')
      expect(html).toContain('action="/characters/hero/regenerate"')
      expect(html).not.toContain('/characters/hero/approve')
      expect(html).toContain('name="baseVersionId" value="current"')
      expect(html).toContain('name="regenerateRequest"')
      expect(html).not.toContain(
        'Regeneration starts immediately from the version you are viewing. The raw edit text is passed through as written.',
      )
      expect(html).not.toContain('Go to current')

      const detailVisualIndex = html.indexOf('<div class="detail-visual">')
      const subtitleIndex = html.indexOf(
        'Review the current artifact, browse retained versions, update the source reference stack, and request targeted edits.',
      )
      const detailSideIndex = html.indexOf('<div class="detail-side">')
      const backActionIndex = html.indexOf('Back to characters')

      expect(detailVisualIndex).toBeGreaterThan(-1)
      expect(subtitleIndex).toBeGreaterThan(detailVisualIndex)
      expect(detailSideIndex).toBeGreaterThan(subtitleIndex)
      expect(backActionIndex).toBeGreaterThan(detailSideIndex)
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server shows historical actions, including confirmed delete, and regenerates from the viewed retained version', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    await writeCharacterArtifactFixture(rootDir)

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/characters/hero?version=v2', server.url))
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).toContain('Historical Version')
      expect(html).toContain('Make current')
      expect(html).toContain('Go to current')
      expect(html).toContain('Delete')
      expect(html).toContain('action="/characters/hero/delete"')
      expect(html).toContain(
        'window.confirm(&quot;Delete retained version v2? This cannot be undone.&quot;)',
      )
      expect(html).toContain('name="baseVersionId" value="v2"')
      expect(html).toContain('data-version-id="v2"')
      expect(html).toContain('Viewing')
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server deletes a retained version and redirects back to current detail view', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    await writeCharacterArtifactFixture(rootDir)
    await writeRepoFile(rootDir, 'workspace/CHARACTERS/HISTORY/hero/v2.json', '{"seed":2}')

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/characters/hero/delete', server.url), {
        method: 'POST',
        redirect: 'manual',
        body: new URLSearchParams({
          versionId: 'v2',
        }),
      })

      expect(response.status).toBe(303)
      expect(response.headers.get('location')).toBe('/characters/hero')

      const detailResponse = await fetch(new URL('/characters/hero', server.url))
      const html = await detailResponse.text()

      expect(detailResponse.status).toBe(200)
      expect(html).not.toContain('data-version-id="v2"')
      expect(html).toContain('data-version-id="v1"')
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server no longer exposes the approval preview route', async () => {
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
          baseVersionId: 'current',
          regenerateRequest: 'Tighten the panel spacing.',
        }),
      })

      expect(response.status).toBe(404)
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server uses silent video thumbnails in the version rail while keeping controls on the main shot viewer', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/SHOTS.json',
      `${JSON.stringify(
        [
          {
            shotId: 'SHOT-01',
            status: 'ready',
            videoPath: 'workspace/SHOTS/SHOT-01.mp4',
            durationSeconds: 4,
            incomingTransition: {
              type: 'opening',
              notes: 'Open the sequence.',
            },
            keyframes: createPlannedKeyframes(['SHOT-01-START', 'SHOT-01-END']),
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
    await writeRepoFile(rootDir, 'workspace/SHOTS/SHOT-01.mp4', 'current-shot-video')
    await writeRepoFile(rootDir, 'workspace/SHOTS/HISTORY/SHOT-01/v1.mp4', 'retained-shot-video')

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/shots/SHOT-01', server.url))
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).toContain(
        'class="version-media" src="/workspace/SHOTS/SHOT-01.mp4" muted autoplay loop playsinline preload="metadata"></video>',
      )
      expect(html).toContain(
        'class="version-media" src="/shots/SHOT-01/versions/v1/media" muted autoplay loop playsinline preload="metadata"></video>',
      )
      expect(html).toContain('class="version-badges"')
      expect(html).not.toContain('version-tile-copy')
      expect(html).toContain(
        '<video class="" src="/workspace/SHOTS/SHOT-01.mp4" controls preload="metadata" playsinline></video>',
      )
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('runApprovedRegenerateAction stays single-variant even when CONFIG.json.variantCount is greater than 1', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/CONFIG.json',
      `${JSON.stringify(
        {
          agentModel: 'agent-test',
          imageModel: 'image-test',
          videoModel: 'video-test',
          variantCount: 3,
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD.md',
      '# STORYBOARD\n\n## SHOT-01\n\n- Purpose: Establish the dog.\n',
    )
    await writeRepoFile(rootDir, 'templates/STORYBOARD.template.png', 'template')
    await writeRepoFile(rootDir, 'workspace/STORYBOARD.png', 'storyboard-image')

    const seeds: number[] = []
    await runApprovedRegenerateAction(
      '/storyboard',
      rootDir,
      'current',
      'Tighten the panel spacing.',
      {
        imageGenerator: async (input) => {
          seeds.push(input.seed ?? -1)

          if (!input.outputPath) {
            throw new Error('Expected outputPath for approved storyboard generation test.')
          }

          await writeRepoFile(rootDir, input.outputPath, `storyboard:${input.seed}`)

          return {
            generationId: `gen-${input.seed}`,
            model: input.model ?? 'image-test',
            outputPaths: [path.resolve(rootDir, input.outputPath)],
          }
        },
      },
    )

    expect(seeds).toEqual([1])
    expect(await readFile(path.resolve(rootDir, 'workspace/STORYBOARD.png'), 'utf8')).toBe(
      'storyboard:1',
    )
    expect(
      await readFile(path.resolve(rootDir, 'workspace/HISTORY/STORYBOARD/v1.png'), 'utf8'),
    ).toBe('storyboard-image')
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('runApprovedRegenerateAction uses the viewed retained storyboard as the selected-image reference', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/CONFIG.json',
      `${JSON.stringify(
        {
          agentModel: 'agent-test',
          imageModel: 'image-test',
          videoModel: 'video-test',
          variantCount: 1,
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(rootDir, 'workspace/STORYBOARD.png', 'storyboard-current')
    await writeRepoFile(rootDir, 'workspace/HISTORY/STORYBOARD/v2.png', 'storyboard-v2')

    let capturedPrompt = ''
    let capturedReferences: { kind: string; path: string }[] = []

    await runApprovedRegenerateAction('/storyboard', rootDir, 'v2', 'Remove the extra character.', {
      imageGenerator: async (input) => {
        capturedPrompt = input.prompt
        capturedReferences = input.references ?? []

        if (!input.outputPath) {
          throw new Error('Expected outputPath for retained storyboard regeneration test.')
        }

        await writeRepoFile(rootDir, input.outputPath, 'storyboard:regenerated')

        return {
          generationId: 'gen-retained',
          model: input.model ?? 'image-test',
          outputPaths: [path.resolve(rootDir, input.outputPath)],
        }
      },
    })

    expect(capturedPrompt).toContain('Remove the extra character.')
    expect(capturedPrompt).not.toContain('Storyboard markdown:')
    expect(capturedReferences).toEqual([
      { kind: 'selected-image', path: 'workspace/HISTORY/STORYBOARD/v2.png' },
    ])
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
