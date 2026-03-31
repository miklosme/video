import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runApprovedAction, startArtifactReviewServer } from './artifact-review-server'

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
      'workspace/KEYFRAMES.json',
      `${JSON.stringify(
        [
          {
            keyframeId: 'SHOT-01-END',
            shotId: 'SHOT-01',
            frameType: 'end',
            title: 'Closing anchor',
            goal: 'Hold on the final frame only.',
            status: 'planned',
            imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png',
            characterIds: [],
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
      expect(html).toContain('Closing anchor')
      expect(html).toContain('No start keyframe planned')
      expect(html).not.toContain('Missing start frame')
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

test('artifact review server shows version history for an existing character and saves reference edits', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-artifact-review-'))

  try {
    await writeCharacterArtifactFixture(rootDir)

    const server = startArtifactReviewServer({ cwd: rootDir, preferredPort: 0 })

    try {
      const detailResponse = await fetch(new URL('/characters/hero', server.url))
      const detailHtml = await detailResponse.text()

      expect(detailResponse.status).toBe(200)
      expect(detailHtml).toContain('Version History')
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
      expect(html).toContain('Regenerate')
      expect(html).not.toContain('Edit Request')
      expect(html).toContain('action="/characters/hero/generate"')
      expect(html).not.toContain('/characters/hero/approve')
      expect(html).toContain('name="baseVersionId" value="current"')
      expect(html).not.toContain('Go to current')
    } finally {
      await server.stop()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('artifact review server shows historical actions and regenerates from the viewed retained version', async () => {
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
          editInstruction: 'Tighten the panel spacing.',
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

test('runApprovedAction stays single-variant even when CONFIG.json.variantCount is greater than 1', async () => {
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
    await runApprovedAction('/storyboard', rootDir, 'current', 'Tighten the panel spacing.', {
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
    })

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
