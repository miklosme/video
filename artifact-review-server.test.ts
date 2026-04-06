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

async function writeCameraVocabularyFixture(rootDir: string) {
  await writeRepoFile(
    rootDir,
    'CAMERA_VOCABULARY.json',
    await readFile(new URL('./CAMERA_VOCABULARY.json', import.meta.url), 'utf8'),
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

test('artifact review server renders idea and story document pages and puts them first in the top nav', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/IDEA.md',
      '# IDEA\n\nA lonely lighthouse keeps watch over a flooded city.\n',
    )
    await writeRepoFile(
      rootDir,
      'workspace/STORY.md',
      '# STORY\n\nThe keeper must choose between rescue and memory.\n',
    )

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const ideaResponse = await fetch(new URL('/idea', server.url))
      const ideaHtml = await ideaResponse.text()
      const storyResponse = await fetch(new URL('/story', server.url))
      const storyHtml = await storyResponse.text()

      expect(ideaResponse.status).toBe(200)
      expect(ideaHtml).toContain('workspace/IDEA.md')
      expect(ideaHtml).toContain('# IDEA')
      expect(ideaHtml.indexOf('href="/idea"')).toBeLessThan(ideaHtml.indexOf('href="/story"'))
      expect(ideaHtml.indexOf('href="/story"')).toBeLessThan(ideaHtml.indexOf('href="/"'))

      expect(storyResponse.status).toBe(200)
      expect(storyHtml).toContain('workspace/STORY.md')
      expect(storyHtml).toContain('# STORY')
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server exposes the recent generation log and links to it from the top nav', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    const logEntries = Array.from({ length: 6 }, (_, index) => ({
      generationId: `gen-${index + 1}`,
      startedAt: `2026-04-0${index + 1}T10:00:00.000Z`,
      completedAt: `2026-04-0${index + 1}T10:00:05.000Z`,
      status: index === 4 ? 'error' : 'success',
      model: 'image-test',
      prompt: `Prompt ${index + 1}`,
      settings: {
        imageCount: 1,
        aspectRatio: '16:9',
      },
      outputDir: 'workspace/KEYFRAMES/SHOT-01',
      outputPaths: [`workspace/KEYFRAMES/SHOT-01/gen-${index + 1}.png`],
      keyframeId: 'SHOT-01-START',
      shotId: 'SHOT-01',
      frameType: 'start',
      promptId: null,
      artifactType: 'keyframe',
      artifactId: 'SHOT-01-START',
      logFile: 'workspace/GENERATION-LOG.jsonl',
      references: [],
      error:
        index === 4
          ? {
              name: 'TestError',
              message: 'generation failed',
            }
          : null,
    }))

    await writeRepoFile(
      rootDir,
      'workspace/GENERATION-LOG.jsonl',
      `${logEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    )

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const homeResponse = await fetch(new URL('/', server.url))
      const homeHtml = await homeResponse.text()
      const logsResponse = await fetch(new URL('/logs', server.url))
      const logsHtml = await logsResponse.text()

      expect(homeResponse.status).toBe(200)
      expect(homeHtml).toContain('class="top-nav"')
      expect(homeHtml).toContain('justify-content: space-between;')
      expect(homeHtml).toContain('class="button button-link" href="/logs">Logs</a>')

      expect(logsResponse.status).toBe(200)
      expect(logsHtml).toContain('workspace/GENERATION-LOG.jsonl')
      expect(logsHtml).toContain('&quot;generationId&quot;: &quot;gen-6&quot;')
      expect(logsHtml).toContain('&quot;generationId&quot;: &quot;gen-2&quot;')
      expect(logsHtml).not.toContain('&quot;generationId&quot;: &quot;gen-1&quot;')
      expect(logsHtml.indexOf('&quot;generationId&quot;: &quot;gen-6&quot;')).toBeLessThan(
        logsHtml.indexOf('&quot;generationId&quot;: &quot;gen-5&quot;'),
      )
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server renders an empty storyboard editor when no storyboard sidecar exists', async () => {
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
      expect(html).toContain('storyboard-thumb-add-icon')
      expect(html).toContain('New storyboard start frame')
      expect(html).not.toContain('Storyboard Editor')
      expect(html).not.toContain('Source Storyboard')
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server renders the storyboard board before the editor and keeps tiles image-only', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD.json',
      `${JSON.stringify(
        {
          images: [
            {
              frameType: 'start',
              goal: 'Establish the dog noticing something wrong in the glass.',
              imagePath: 'workspace/STORYBOARD/storyboard-image-alpha.png',
              references: [],
            },
          ],
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD/storyboard-image-alpha.png',
      'storyboard-image',
    )

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/storyboard', server.url))
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).not.toContain('Storyboard Editor')
      expect(html).not.toContain('class="version-badges"')
      expect(html).not.toContain('storyboard-thumb-copy')
      expect(html).toContain('storyboard-thumb-add-icon')
      expect(html).toContain('aria-label="SHOT-01-START (Start frame)"')
      expect(html).toContain('data-storyboard-reorder-toggle')
      expect(html).toContain('/vendor/sortablejs.min.js')
      expect(html.indexOf('class="panel storyboard-grid-panel"')).toBeLessThan(
        html.indexOf('class="storyboard-editor-pane"'),
      )
      expect(html).toContain('grid-template-columns: minmax(0, 1fr) minmax(320px, 380px);')
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server leaves storyboard prompt cache empty until generation runs', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD.json',
      `${JSON.stringify({ images: [] }, null, 2)}\n`,
    )

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/storyboard/save', server.url), {
        method: 'POST',
        redirect: 'manual',
        body: new URLSearchParams({
          selectedImageId: '__new__',
          goal: 'Establish the dog noticing something wrong in the glass.',
          referencesJson: '[]',
          regenerateRequest: '',
        }),
      })

      expect(response.status).toBe(303)

      const storyboard = JSON.parse(
        await readFile(path.resolve(rootDir, 'workspace/STORYBOARD.json'), 'utf8'),
      ) as {
        images: Array<{ prompt?: string | null }>
      }

      expect(storyboard.images).toHaveLength(1)
      expect(storyboard.images[0]?.prompt ?? null).toBeNull()
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server reorder endpoint keeps an untouched missing end placeholder virtual', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD.json',
      `${JSON.stringify(
        {
          images: [
            {
              frameType: 'start',
              goal: 'Open on the dog squinting at the glass.',
              imagePath: 'workspace/STORYBOARD/storyboard-image-alpha.png',
            },
          ],
        },
        null,
        2,
      )}\n`,
    )

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/storyboard/reorder', server.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          tileKeys: ['existing:0', 'missing-end:0'],
          selectedTileKey: 'missing-end:0',
        }),
      })

      expect(response.status).toBe(200)

      const payload = (await response.json()) as {
        status: string
        redirectUrl: string
      }

      expect(payload.status).toBe('ok')
      expect(payload.redirectUrl).toContain('image=__end__%3A0')

      const storyboard = JSON.parse(
        await readFile(path.resolve(rootDir, 'workspace/STORYBOARD.json'), 'utf8'),
      ) as {
        images: Array<{
          frameType: 'start' | 'end'
          goal: string
          imagePath: string | null
          prompt?: string | null
        }>
      }

      expect(storyboard.images).toEqual([
        {
          frameType: 'start',
          goal: 'Open on the dog squinting at the glass.',
          imagePath: 'workspace/STORYBOARD/storyboard-image-alpha.png',
        },
      ])
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server reorder endpoint flips frame sides and materializes moved placeholders', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD.json',
      `${JSON.stringify(
        {
          images: [
            {
              frameType: 'start',
              goal: 'Merchant freezes in the market.',
              imagePath: 'workspace/STORYBOARD/storyboard-image-alpha.png',
            },
            {
              frameType: 'end',
              goal: 'The crowd surges past his panic.',
              imagePath: 'workspace/STORYBOARD/storyboard-image-beta.png',
            },
            {
              frameType: 'start',
              goal: 'He rushes toward the library doors.',
              imagePath: 'workspace/STORYBOARD/storyboard-image-gamma.png',
              references: [
                { kind: 'storyboard-template', path: 'templates/STORYBOARD.template.png' },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
    )

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/storyboard/reorder', server.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          tileKeys: ['existing:1', 'existing:0', 'missing-end:2', 'existing:2'],
          selectedTileKey: 'existing:1',
        }),
      })

      expect(response.status).toBe(200)

      const payload = (await response.json()) as {
        status: string
        redirectUrl: string
      }

      expect(payload.status).toBe('ok')
      expect(payload.redirectUrl).toContain('image=0')

      const storyboard = JSON.parse(
        await readFile(path.resolve(rootDir, 'workspace/STORYBOARD.json'), 'utf8'),
      ) as {
        images: Array<{
          frameType: 'start' | 'end'
          goal: string
          imagePath: string | null
          prompt?: string | null
          references?: Array<{ kind: string; path: string }>
        }>
      }

      expect(storyboard.images).toEqual([
        {
          frameType: 'start',
          goal: 'The crowd surges past his panic.',
          imagePath: 'workspace/STORYBOARD/storyboard-image-beta.png',
        },
        {
          frameType: 'end',
          goal: 'Merchant freezes in the market.',
          imagePath: 'workspace/STORYBOARD/storyboard-image-alpha.png',
        },
        {
          frameType: 'start',
          goal: 'He rushes toward the library doors.',
          prompt: null,
          imagePath: null,
          references: [
            {
              kind: 'storyboard-template',
              path: 'templates/STORYBOARD.template.png',
            },
          ],
        },
        {
          frameType: 'end',
          goal: 'He rushes toward the library doors.',
          imagePath: 'workspace/STORYBOARD/storyboard-image-gamma.png',
          references: [
            {
              kind: 'storyboard-template',
              path: 'templates/STORYBOARD.template.png',
            },
          ],
        },
      ])
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server redirects legacy keyframe and shot summary routes to the timeline', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const keyframesResponse = await fetch(new URL('/keyframes', server.url), {
        redirect: 'manual',
      })
      const shotsResponse = await fetch(new URL('/shots', server.url), {
        redirect: 'manual',
      })

      expect(keyframesResponse.status).toBe(302)
      expect(keyframesResponse.headers.get('location')).toBe('/timeline')
      expect(shotsResponse.status).toBe(302)
      expect(shotsResponse.headers.get('location')).toBe('/timeline')
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server exposes omitted keyframe anchors from the timeline', async () => {
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
            keyframes: createPlannedKeyframes(['SHOT-01-END']),
          },
        ],
        null,
        2,
      )}\n`,
    )

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/timeline', server.url))
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).toContain('Timeline')
      expect(html).toContain('SHOT-01-END')
      expect(html).toContain('/keyframes/SHOT-01-START?embed=1')
      expect(html).toContain('"omitted":true')
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
      const embeddedResponse = await fetch(new URL('/keyframes/SHOT-01-END?embed=1', server.url))
      const embeddedHtml = await embeddedResponse.text()

      expect(response.status).toBe(200)
      expect(html).toContain('SHOT-01-END')
      expect(html).toContain('No end keyframe planned')
      expect(html).toContain('action="/keyframes/SHOT-01-END/create"')
      expect(html).toContain('Create keyframe')
      expect(html).toContain('No source prompt available for this artifact.')
      expect(html).toContain('Back to timeline')
      expect(embeddedResponse.status).toBe(200)
      expect(embeddedHtml).not.toContain('Back to timeline')
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server offers a bridge action on an omitted end keyframe when the next shot has a planned start', async () => {
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
            keyframes: createPlannedKeyframes(['SHOT-01-START']),
          },
          {
            shotId: 'SHOT-02',
            status: 'planned',
            videoPath: 'workspace/SHOTS/SHOT-02.mp4',
            durationSeconds: 4,
            keyframes: createPlannedKeyframes(['SHOT-02-START']),
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
      expect(html).toContain('Anchor Planning')
      expect(html).toContain('action="/keyframes/SHOT-01-END/bridge"')
      expect(html).toContain('Make bridge frame')
      expect(html).toContain('SHOT-02-START')
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server bridges an omitted end keyframe and disables removing the shared next-shot start', async () => {
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
            keyframes: createPlannedKeyframes(['SHOT-01-START']),
          },
          {
            shotId: 'SHOT-02',
            status: 'planned',
            videoPath: 'workspace/SHOTS/SHOT-02.mp4',
            durationSeconds: 4,
            keyframes: createPlannedKeyframes(['SHOT-02-START', 'SHOT-02-END']),
          },
        ],
        null,
        2,
      )}\n`,
    )

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const bridgeResponse = await fetch(new URL('/keyframes/SHOT-01-END/bridge', server.url), {
        method: 'POST',
        redirect: 'manual',
      })

      expect(bridgeResponse.status).toBe(303)
      expect(bridgeResponse.headers.get('location')).toBe('/keyframes/SHOT-02-START')

      const shots = JSON.parse(
        await readFile(path.resolve(rootDir, 'workspace/SHOTS.json'), 'utf8'),
      )

      expect(shots).toEqual([
        {
          shotId: 'SHOT-01',
          status: 'planned',
          videoPath: 'workspace/SHOTS/SHOT-01.mp4',
          endFrameMode: 'bridge',
          durationSeconds: 4,
          keyframes: [
            {
              keyframeId: 'SHOT-01-START',
              frameType: 'start',
              imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
            },
          ],
        },
        {
          shotId: 'SHOT-02',
          status: 'planned',
          videoPath: 'workspace/SHOTS/SHOT-02.mp4',
          durationSeconds: 4,
          keyframes: [
            {
              keyframeId: 'SHOT-02-START',
              frameType: 'start',
              imagePath: 'workspace/KEYFRAMES/SHOT-02/SHOT-02-START.png',
            },
            {
              keyframeId: 'SHOT-02-END',
              frameType: 'end',
              imagePath: 'workspace/KEYFRAMES/SHOT-02/SHOT-02-END.png',
            },
          ],
        },
      ])

      const startDetailResponse = await fetch(new URL('/keyframes/SHOT-02-START', server.url))
      const startDetailHtml = await startDetailResponse.text()
      const bridgedRedirectResponse = await fetch(new URL('/keyframes/SHOT-01-END', server.url), {
        redirect: 'manual',
      })
      const timelineResponse = await fetch(new URL('/timeline', server.url))
      const timelineHtml = await timelineResponse.text()

      expect(startDetailResponse.status).toBe(200)
      expect(startDetailHtml).toContain('Shared boundary: SHOT-01 end reuses this start frame.')
      expect(startDetailHtml).toContain('Use distinct end frame')
      expect(startDetailHtml).toContain('action="/keyframes/SHOT-01-END/unbridge"')

      expect(bridgedRedirectResponse.status).toBe(302)
      expect(bridgedRedirectResponse.headers.get('location')).toBe('/keyframes/SHOT-02-START')

      expect(timelineResponse.status).toBe(200)
      expect(timelineHtml).toContain('"left":null')
      expect(timelineHtml).toContain('"keyframeId":"SHOT-02-START"')
      expect(timelineHtml).not.toContain('"keyframeId":"SHOT-01-END"')
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server preserves embedded bridge actions and refresh redirects inside the timeline iframe', async () => {
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
            keyframes: createPlannedKeyframes(['SHOT-01-START']),
          },
          {
            shotId: 'SHOT-02',
            status: 'planned',
            videoPath: 'workspace/SHOTS/SHOT-02.mp4',
            durationSeconds: 4,
            keyframes: createPlannedKeyframes(['SHOT-02-START']),
          },
        ],
        null,
        2,
      )}\n`,
    )

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const embeddedOmittedResponse = await fetch(
        new URL('/keyframes/SHOT-01-END?embed=1', server.url),
      )
      const embeddedOmittedHtml = await embeddedOmittedResponse.text()

      expect(embeddedOmittedResponse.status).toBe(200)
      expect(embeddedOmittedHtml).toContain('action="/keyframes/SHOT-01-END/bridge?embed=1"')

      const bridgeResponse = await fetch(
        new URL('/keyframes/SHOT-01-END/bridge?embed=1', server.url),
        {
          method: 'POST',
          redirect: 'manual',
        },
      )

      expect(bridgeResponse.status).toBe(303)
      expect(bridgeResponse.headers.get('location')).toBe(
        '/keyframes/SHOT-02-START?embed=1&updated=1',
      )

      const embeddedStartResponse = await fetch(
        new URL('/keyframes/SHOT-02-START?embed=1&updated=1', server.url),
      )
      const embeddedStartHtml = await embeddedStartResponse.text()

      expect(embeddedStartResponse.status).toBe(200)
      expect(embeddedStartHtml).toContain('action="/keyframes/SHOT-01-END/unbridge?embed=1"')
      expect(embeddedStartHtml).toContain('artifact-review-refresh')
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

test('artifact review server keeps shot prompt and anchor details on the shot control page', async () => {
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
          prompt: 'The camera glides from the start frame into the end frame.',
          status: 'ready',
        },
        null,
        2,
      )}\n`,
    )

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/shots/SHOT-01', server.url))
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).toContain('SHOT-01')
      expect(html).toContain('Back to timeline')
      expect(html).toContain('The camera glides from the start frame into the end frame.')
      expect(html).toContain('SHOT-01-START -&gt; SHOT-01-END')
      expect(html).toContain('No shot video yet')
      expect(html).toContain('placeholder-missing')
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server renders the timeline from SHOTS.json with embedded keyframe and shot detail targets', async () => {
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
            keyframes: createPlannedKeyframes(['SHOT-01-START']),
          },
          {
            shotId: 'SHOT-02',
            status: 'planned',
            videoPath: 'workspace/SHOTS/SHOT-02.mp4',
            durationSeconds: 6,
            keyframes: createPlannedKeyframes(['SHOT-02-START', 'SHOT-02-END']),
          },
        ],
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(
      rootDir,
      'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
      'shot-01-start-image',
    )

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/timeline', server.url))
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).toContain('Timeline')
      expect(html).toContain('SHOT-01')
      expect(html).toContain('SHOT-02')
      expect(html).toContain('/shots/SHOT-01?embed=1')
      expect(html).toContain('/keyframes/SHOT-01-END?embed=1')
      expect(html).toContain('"omitted":true')
      expect(html).toContain('data-keyframe-rail-id="SHOT-01-START"')
      expect(html).toContain('data-keyframe-rail-id="SHOT-02-START"')
      expect(html).toContain('data-keyframe-rail-id="SHOT-02-END"')
      expect(html).not.toContain('data-keyframe-rail-id="SHOT-01-END"')
      expect(html).toContain('/workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png')
      expect(html).toContain('Not generated yet')
      expect(html).toContain('tl-detail-frame')
      expect(html).not.toContain('mockPointers')
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server timeline update syncs only shot durations back to SHOTS.json', async () => {
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
            keyframes: createPlannedKeyframes(['SHOT-01-START']),
          },
          {
            shotId: 'SHOT-02',
            status: 'planned',
            videoPath: 'workspace/SHOTS/SHOT-02.mp4',
            durationSeconds: 6,
            keyframes: createPlannedKeyframes(['SHOT-02-START', 'SHOT-02-END']),
          },
        ],
        null,
        2,
      )}\n`,
    )

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/timeline/update', server.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          shots: [
            { shotId: 'SHOT-01', durationSeconds: 5 },
            { shotId: 'SHOT-02', durationSeconds: 7 },
          ],
        }),
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: 'ok' })

      const shots = JSON.parse(
        await readFile(path.resolve(rootDir, 'workspace/SHOTS.json'), 'utf8'),
      )

      expect(shots).toEqual([
        {
          shotId: 'SHOT-01',
          status: 'planned',
          videoPath: 'workspace/SHOTS/SHOT-01.mp4',
          durationSeconds: 5,
          keyframes: [
            {
              keyframeId: 'SHOT-01-START',
              frameType: 'start',
              imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
            },
          ],
        },
        {
          shotId: 'SHOT-02',
          status: 'planned',
          videoPath: 'workspace/SHOTS/SHOT-02.mp4',
          durationSeconds: 7,
          keyframes: [
            {
              keyframeId: 'SHOT-02-START',
              frameType: 'start',
              imagePath: 'workspace/KEYFRAMES/SHOT-02/SHOT-02-START.png',
            },
            {
              keyframeId: 'SHOT-02-END',
              frameType: 'end',
              imagePath: 'workspace/KEYFRAMES/SHOT-02/SHOT-02-END.png',
            },
          ],
        },
      ])
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

test('artifact review server renders camera override controls for shot regeneration', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    await writeCameraVocabularyFixture(rootDir)
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
          camera: {
            shotSize: 'medium-shot',
            cameraPosition: 'eye-level',
            cameraAngle: 'level-angle',
            cameraMovement: 'static-shot',
          },
          prompt: 'The camera glides from the start frame into the end frame.',
          status: 'ready',
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(rootDir, 'workspace/SHOTS/SHOT-01.mp4', 'current-shot-video')

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const response = await fetch(new URL('/shots/SHOT-01', server.url))
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).toContain('Camera Overrides')
      expect(html).toContain('name="cameraOverrideShotSize"')
      expect(html).toContain('name="cameraOverrideCameraMovement"')
      expect(html).toContain('Keep current (Medium Shot)')
      expect(html).toContain('Keep current (Static Shot)')
      expect(html).toContain('Current Camera Plan')
      expect(html).toContain('Shot Size: Medium Shot')
      expect(html).toContain('Camera Movement: Static Shot')
      expect(html).not.toContain('leave the note blank and use camera overrides only')

      const detailVisualIndex = html.indexOf('<div class="detail-visual">')
      const currentCameraPlanIndex = html.indexOf('Current Camera Plan')
      const detailSideIndex = html.indexOf('<div class="detail-side">')

      expect(detailVisualIndex).toBeGreaterThan(-1)
      expect(currentCameraPlanIndex).toBeGreaterThan(detailVisualIndex)
      expect(detailSideIndex).toBeGreaterThan(currentCameraPlanIndex)
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server accepts camera-only keyframe regeneration requests', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))
  let capturedPrompt = ''

  try {
    await writeConfigFixture(rootDir)
    await writeCameraVocabularyFixture(rootDir)
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
          camera: {
            shotSize: 'medium-shot',
            cameraPosition: 'eye-level',
            cameraAngle: 'level-angle',
          },
          prompt: 'A stable opening frame.',
          status: 'ready',
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(
      rootDir,
      'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
      'keyframe-current',
    )

    const server = startArtifactReviewServer({
      cwd: rootDir,
      preferredPort: 0,
      imageGenerator: async (input) => {
        capturedPrompt = input.prompt

        if (!input.outputPath) {
          throw new Error('Expected outputPath for keyframe regeneration test.')
        }

        await writeRepoFile(rootDir, input.outputPath, 'keyframe-regenerated')

        return {
          generationId: 'gen-keyframe-regenerated',
          model: input.model ?? 'image-test',
          outputPaths: [path.resolve(rootDir, input.outputPath)],
        }
      },
    })

    try {
      const response = await fetch(new URL('/keyframes/SHOT-01-START/regenerate', server.url), {
        method: 'POST',
        redirect: 'manual',
        body: new URLSearchParams({
          baseVersionId: 'current',
          cameraOverrideShotSize: 'close-up',
        }),
      })

      expect(response.status).toBe(303)
      expect(response.headers.get('location')).toBe('/keyframes/SHOT-01-START')

      await waitFor(async () => {
        expect(
          await readFile(
            path.resolve(rootDir, 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png'),
            'utf8',
          ),
        ).toBe('keyframe-regenerated')
      })

      const sidecar = JSON.parse(
        await readFile(
          path.resolve(rootDir, 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.json'),
          'utf8',
        ),
      )

      expect(sidecar.camera).toEqual({
        shotSize: 'close-up',
        cameraPosition: 'eye-level',
        cameraAngle: 'level-angle',
      })
      expect(sidecar.prompt).toBe('A stable opening frame.')
      expect(capturedPrompt).toContain('Shot Size: Close Up')
      expect(capturedPrompt).not.toContain('Approved change:')
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server persists shot camera overrides to the sidecar without changing the prompt', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))
  let capturedPrompt = ''

  try {
    await writeConfigFixture(rootDir)
    await writeCameraVocabularyFixture(rootDir)
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
          camera: {
            shotSize: 'medium-shot',
            cameraPosition: 'eye-level',
            cameraAngle: 'level-angle',
            cameraMovement: 'static-shot',
          },
          prompt: 'The camera glides from the start frame into the end frame.',
          status: 'ready',
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(rootDir, 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png', 'start-png')
    await writeRepoFile(rootDir, 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png', 'end-png')
    await writeRepoFile(rootDir, 'workspace/SHOTS/SHOT-01.mp4', 'current-shot-video')

    const server = startArtifactReviewServer({
      cwd: rootDir,
      preferredPort: 0,
      shotVideoGenerator: async (input) => {
        capturedPrompt = input.prompt

        return {
          data: new Uint8Array([1, 2, 3]),
          mediaType: 'video/mp4',
        }
      },
    })

    try {
      const response = await fetch(new URL('/shots/SHOT-01/regenerate', server.url), {
        method: 'POST',
        redirect: 'manual',
        body: new URLSearchParams({
          baseVersionId: 'current',
          cameraOverrideShotSize: 'close-up',
          cameraOverrideCameraMovement: 'tracking-shot',
        }),
      })

      expect(response.status).toBe(303)
      expect(response.headers.get('location')).toBe('/shots/SHOT-01')

      await waitFor(async () => {
        expect(capturedPrompt.length).toBeGreaterThan(0)
      })

      const sidecar = JSON.parse(
        await readFile(path.resolve(rootDir, 'workspace/SHOTS/SHOT-01.json'), 'utf8'),
      )

      expect(sidecar.camera).toEqual({
        shotSize: 'close-up',
        cameraPosition: 'eye-level',
        cameraAngle: 'level-angle',
        cameraMovement: 'tracking-shot',
      })
      expect(sidecar.prompt).toBe('The camera glides from the start frame into the end frame.')
      expect(capturedPrompt).toContain('Shot Size: Close Up')
      expect(capturedPrompt).toContain('Camera Movement: Tracking Shot')
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('runApprovedRegenerateAction passes shot camera overrides into regeneration prompts', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))
  let capturedPrompt = ''

  try {
    await writeConfigFixture(rootDir)
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
          camera: {
            shotSize: 'medium-shot',
            cameraPosition: 'eye-level',
            cameraAngle: 'level-angle',
            cameraMovement: 'static-shot',
          },
          prompt: 'The camera glides from the start frame into the end frame.',
          status: 'ready',
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(rootDir, 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png', 'start-png')
    await writeRepoFile(rootDir, 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png', 'end-png')

    await runApprovedRegenerateAction('/shots/SHOT-01', rootDir, 'current', '', {
      cameraOverrides: {
        shotSize: 'close-up',
        cameraMovement: 'tracking-shot',
      },
      shotVideoGenerator: async (input) => {
        capturedPrompt = input.prompt

        return {
          data: new Uint8Array([1, 2, 3]),
          mediaType: 'video/mp4',
        }
      },
    })

    expect(capturedPrompt).toContain('Shot Size: Close Up')
    expect(capturedPrompt).toContain('Camera Movement: Tracking Shot')
    expect(capturedPrompt).not.toContain('Approved change:')
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
          fastImageModel: 'image-fast-test',
          videoModel: 'video-test',
          variantCount: 3,
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD.json',
      `${JSON.stringify(
        {
          images: [
            {
              frameType: 'start',
              goal: 'Establish the dog noticing something wrong in the glass.',
              imagePath: 'workspace/STORYBOARD/storyboard-image-alpha.png',
              references: [],
            },
          ],
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD/storyboard-image-alpha.png',
      'storyboard-image',
    )

    const seeds: number[] = []
    await runApprovedRegenerateAction(
      '/storyboard/images/storyboard-image-alpha',
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
    expect(
      await readFile(
        path.resolve(rootDir, 'workspace/STORYBOARD/storyboard-image-alpha.png'),
        'utf8',
      ),
    ).toBe('storyboard:1')
    expect(
      await readFile(
        path.resolve(rootDir, 'workspace/STORYBOARD/HISTORY/storyboard-image-alpha/v1.png'),
        'utf8',
      ),
    ).toBe('storyboard-image')
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('runApprovedRegenerateAction keeps storyboard sidecar references during regenerate', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/CONFIG.json',
      `${JSON.stringify(
        {
          agentModel: 'agent-test',
          imageModel: 'image-test',
          fastImageModel: 'image-fast-test',
          videoModel: 'video-test',
          variantCount: 1,
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD/storyboard-image-alpha.png',
      'storyboard-current',
    )
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD/HISTORY/storyboard-image-alpha/v2.png',
      'storyboard-v2',
    )
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD.json',
      `${JSON.stringify(
        {
          images: [
            {
              frameType: 'start',
              goal: 'Establish the dog noticing something wrong in the glass.',
              imagePath: 'workspace/STORYBOARD/storyboard-image-alpha.png',
              references: [
                {
                  kind: 'storyboard-template',
                  path: 'templates/STORYBOARD.template.png',
                },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(rootDir, 'templates/STORYBOARD.template.png', 'storyboard-template')

    let capturedPrompt = ''
    let capturedReferences: { kind: string; path: string }[] = []

    await runApprovedRegenerateAction(
      '/storyboard/images/storyboard-image-alpha',
      rootDir,
      'v2',
      'Remove the extra character.',
      {
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
      },
    )

    expect(capturedPrompt).toContain('Regenerate the current storyboard image for SHOT-01-START')
    expect(capturedPrompt).toContain('Remove the extra character.')
    expect(capturedReferences).toEqual([
      {
        kind: 'selected-image',
        path: 'workspace/STORYBOARD/HISTORY/storyboard-image-alpha/v2.png',
      },
      { kind: 'storyboard-template', path: 'templates/STORYBOARD.template.png' },
    ])
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
