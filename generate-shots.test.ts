import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getShotArtifactDescriptor } from './artifact-control'
import {
  planShotGenerationAssets,
  selectPendingShotGenerations,
  syncShotGenerations,
  type PendingShotGeneration,
} from './generate-shots'
import { loadShotArtifacts, loadShotPrompts, type KeyframeEntry } from './workflow-data'

async function writeRepoFile(rootDir: string, relativePath: string, content: string | Uint8Array) {
  const filePath = path.resolve(rootDir, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content)
}

async function createTestRepo() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'generate-shots-'))

  return {
    rootDir,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true })
    },
  }
}

test('generate-shots explains when a planned shot sidecar is missing', async () => {
  const repo = await createTestRepo()
  const scriptPath = fileURLToPath(new URL('./generate-shots.ts', import.meta.url))

  try {
    await writeRepoFile(
      repo.rootDir,
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
    await writeRepoFile(
      repo.rootDir,
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

    const result = Bun.spawnSync({
      cmd: [process.execPath, scriptPath, '--shot-id', 'SHOT-01'],
      cwd: repo.rootDir,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toContain(
      'Planned shots are missing generation sidecars in workspace/SHOTS/.',
    )
    expect(new TextDecoder().decode(result.stderr)).toContain(
      '- SHOT-01: workspace/SHOTS/SHOT-01.json',
    )
  } finally {
    await repo.cleanup()
  }
})

function createPlannedKeyframes(keyframeIds: string[]) {
  return keyframeIds.map((keyframeId) => ({
    keyframeId,
    frameType: keyframeId.endsWith('-END') ? ('end' as const) : ('start' as const),
    imagePath: `workspace/KEYFRAMES/${keyframeId.slice(0, 7)}/${keyframeId}.png`,
  }))
}

test('loadShotPrompts parses planning-only shot entries', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(
      repo.rootDir,
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

    const shots = await loadShotPrompts(repo.rootDir)

    expect(shots).toEqual([
      {
        shotId: 'SHOT-01',
        status: 'planned',
        videoPath: 'workspace/SHOTS/SHOT-01.mp4',
        keyframes: createPlannedKeyframes(['SHOT-01-START', 'SHOT-01-END']),
        keyframeIds: ['SHOT-01-START', 'SHOT-01-END'],
        durationSeconds: 4,
      },
    ])
  } finally {
    await repo.cleanup()
  }
})

test('loadShotPrompts defaults durationSeconds when omitted', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(
      repo.rootDir,
      'workspace/SHOTS.json',
      `${JSON.stringify(
        [
          {
            shotId: 'SHOT-01',
            status: 'planned',
            videoPath: 'workspace/SHOTS/SHOT-01.mp4',
            keyframes: createPlannedKeyframes(['SHOT-01-START', 'SHOT-01-END']),
          },
        ],
        null,
        2,
      )}\n`,
    )

    const shots = await loadShotPrompts(repo.rootDir)

    expect(shots[0]?.durationSeconds).toBe(4)
  } finally {
    await repo.cleanup()
  }
})

test('loadShotArtifacts parses shot sidecars', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(
      repo.rootDir,
      'workspace/SHOTS/SHOT-01.json',
      `${JSON.stringify(
        {
          shotId: 'SHOT-01',
          prompt: 'A concise motion prompt.',
          status: 'planned',
        },
        null,
        2,
      )}\n`,
    )

    const artifacts = await loadShotArtifacts(repo.rootDir)

    expect(artifacts).toEqual([
      {
        shotId: 'SHOT-01',
        prompt: 'A concise motion prompt.',
        status: 'planned',
      },
    ])
  } finally {
    await repo.cleanup()
  }
})

test('selectPendingShotGenerations uses shot sidecars and canonical output paths', () => {
  expect(
    selectPendingShotGenerations(
      [
        {
          shotId: 'SHOT-01',
          status: 'planned',
          videoPath: 'workspace/SHOTS/SHOT-01.mp4',
          keyframeIds: ['SHOT-01-START', 'SHOT-01-END'],
          durationSeconds: 3.5,
        },
      ],
      [
        {
          shotId: 'SHOT-01',
          prompt: 'A concise motion prompt.',
          status: 'planned',
        },
        {
          shotId: 'SHOT-99',
          prompt: 'Unused.',
          status: 'planned',
        },
      ],
      'video-test',
    ),
  ).toEqual([
    {
      shotId: 'SHOT-01',
      model: 'video-test',
      prompt: 'A concise motion prompt.',
      outputPath: 'workspace/SHOTS/SHOT-01.mp4',
      keyframeIds: ['SHOT-01-START', 'SHOT-01-END'],
      durationSeconds: 3.5,
    },
  ])
})

test('planShotGenerationAssets uses start and end anchors and caps deduped character references', () => {
  const generation: PendingShotGeneration = {
    shotId: 'SHOT-01',
    model: 'video-test',
    prompt: 'A concise motion prompt.',
    outputPath: 'workspace/SHOTS/SHOT-01.mp4',
    keyframeIds: ['SHOT-01-START', 'SHOT-01-END'],
    durationSeconds: 4,
  }
  const keyframes: KeyframeEntry[] = [
    {
      keyframeId: 'SHOT-01-START',
      shotId: 'SHOT-01',
      frameType: 'start',
      title: 'Start frame',
      goal: 'Open the shot.',
      status: 'planned',
      imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
      characterIds: ['dog', 'pack', 'bowl'],
    },
    {
      keyframeId: 'SHOT-01-END',
      shotId: 'SHOT-01',
      frameType: 'end',
      title: 'End frame',
      goal: 'Close the shot.',
      status: 'planned',
      imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png',
      characterIds: ['dog', 'pack', 'room'],
    },
  ]

  expect(planShotGenerationAssets(generation, keyframes)).toEqual({
    inputImagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
    lastFramePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png',
    characterIds: [],
    referenceImagePaths: [],
    references: [
      {
        kind: 'start-frame',
        path: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
      },
      {
        kind: 'end-frame',
        path: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png',
      },
    ],
  })
})

test('planShotGenerationAssets uses a lone start anchor as input without a last-frame control', () => {
  const generation: PendingShotGeneration = {
    shotId: 'SHOT-START-ONLY',
    model: 'video-test',
    prompt: 'A concise motion prompt.',
    outputPath: 'workspace/SHOTS/SHOT-START-ONLY.mp4',
    keyframeIds: ['SHOT-START-ONLY-START'],
    durationSeconds: 4,
  }
  const keyframes: KeyframeEntry[] = [
    {
      keyframeId: 'SHOT-START-ONLY-START',
      shotId: 'SHOT-START-ONLY',
      frameType: 'start',
      title: 'Start-only frame',
      goal: 'Open the shot.',
      status: 'planned',
      imagePath: 'workspace/KEYFRAMES/SHOT-START-ONLY/SHOT-START-ONLY-START.png',
      characterIds: ['dog'],
    },
  ]

  expect(planShotGenerationAssets(generation, keyframes)).toEqual({
    inputImagePath: 'workspace/KEYFRAMES/SHOT-START-ONLY/SHOT-START-ONLY-START.png',
    lastFramePath: null,
    characterIds: [],
    referenceImagePaths: [],
    references: [
      {
        kind: 'start-frame',
        path: 'workspace/KEYFRAMES/SHOT-START-ONLY/SHOT-START-ONLY-START.png',
      },
    ],
  })
})

test('planShotGenerationAssets uses a lone end anchor as input without a last-frame control', () => {
  const generation: PendingShotGeneration = {
    shotId: 'SHOT-END-ONLY',
    model: 'video-test',
    prompt: 'A concise motion prompt.',
    outputPath: 'workspace/SHOTS/SHOT-END-ONLY.mp4',
    keyframeIds: ['SHOT-END-ONLY-END'],
    durationSeconds: 4,
  }
  const keyframes: KeyframeEntry[] = [
    {
      keyframeId: 'SHOT-END-ONLY-END',
      shotId: 'SHOT-END-ONLY',
      frameType: 'end',
      title: 'End-only frame',
      goal: 'Anchor the whole shot from the end pose.',
      status: 'planned',
      imagePath: 'workspace/KEYFRAMES/SHOT-END-ONLY/SHOT-END-ONLY-END.png',
      characterIds: ['dog'],
    },
  ]

  expect(planShotGenerationAssets(generation, keyframes)).toEqual({
    inputImagePath: 'workspace/KEYFRAMES/SHOT-END-ONLY/SHOT-END-ONLY-END.png',
    lastFramePath: null,
    characterIds: [],
    referenceImagePaths: [],
    references: [
      {
        kind: 'end-frame',
        path: 'workspace/KEYFRAMES/SHOT-END-ONLY/SHOT-END-ONLY-END.png',
      },
    ],
  })
})

test('planShotGenerationAssets errors when all referenced anchors are missing from SHOTS.json', () => {
  const generation: PendingShotGeneration = {
    shotId: 'SHOT-404',
    model: 'video-test',
    prompt: 'A concise motion prompt.',
    outputPath: 'workspace/SHOTS/SHOT-404.mp4',
    keyframeIds: ['SHOT-404-START', 'SHOT-404-END'],
    durationSeconds: 4,
  }

  expect(() => planShotGenerationAssets(generation, [])).toThrow(
    'Shot "SHOT-404" cannot be generated because all referenced keyframes are missing from workspace/SHOTS.json.',
  )
})

test('planShotGenerationAssets uses only explicit shot-sidecar references', () => {
  const generation: PendingShotGeneration = {
    shotId: 'SHOT-02',
    model: 'video-test',
    prompt: 'A concise motion prompt.',
    outputPath: 'workspace/SHOTS/SHOT-02.mp4',
    keyframeIds: ['SHOT-02-START', 'SHOT-02-END'],
    durationSeconds: 4,
    userReferences: [
      {
        path: 'workspace/REFERENCES/layout.png',
        kind: 'user-reference',
        label: 'Layout',
      },
      {
        path: 'workspace/REFERENCES/light.png',
        kind: 'user-reference',
        label: 'Light',
      },
    ],
  }
  const keyframes: KeyframeEntry[] = [
    {
      keyframeId: 'SHOT-02-START',
      shotId: 'SHOT-02',
      frameType: 'start',
      title: 'Start frame',
      goal: 'Open the shot.',
      status: 'planned',
      imagePath: 'workspace/KEYFRAMES/SHOT-02/SHOT-02-START.png',
      characterIds: ['dog', 'pack'],
    },
    {
      keyframeId: 'SHOT-02-END',
      shotId: 'SHOT-02',
      frameType: 'end',
      title: 'End frame',
      goal: 'Close the shot.',
      status: 'planned',
      imagePath: 'workspace/KEYFRAMES/SHOT-02/SHOT-02-END.png',
      characterIds: ['dog'],
    },
  ]

  expect(planShotGenerationAssets(generation, keyframes)).toEqual({
    inputImagePath: 'workspace/KEYFRAMES/SHOT-02/SHOT-02-START.png',
    lastFramePath: 'workspace/KEYFRAMES/SHOT-02/SHOT-02-END.png',
    characterIds: [],
    referenceImagePaths: ['workspace/REFERENCES/layout.png', 'workspace/REFERENCES/light.png'],
    references: [
      {
        kind: 'start-frame',
        path: 'workspace/KEYFRAMES/SHOT-02/SHOT-02-START.png',
      },
      {
        kind: 'end-frame',
        path: 'workspace/KEYFRAMES/SHOT-02/SHOT-02-END.png',
      },
      {
        kind: 'user-reference',
        path: 'workspace/REFERENCES/layout.png',
      },
      {
        kind: 'user-reference',
        path: 'workspace/REFERENCES/light.png',
      },
    ],
  })
})

test('syncShotGenerations honors firstOnly after skipping existing outputs', async () => {
  const repo = await createTestRepo()

  try {
    const keyframes: KeyframeEntry[] = [
      {
        keyframeId: 'SHOT-01-START',
        shotId: 'SHOT-01',
        frameType: 'start',
        title: 'Start frame',
        goal: 'Open the shot.',
        status: 'planned',
        imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
        characterIds: ['dog'],
      },
      {
        keyframeId: 'SHOT-01-END',
        shotId: 'SHOT-01',
        frameType: 'end',
        title: 'End frame',
        goal: 'Close the shot.',
        status: 'planned',
        imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png',
        characterIds: ['dog'],
      },
      {
        keyframeId: 'SHOT-02-START',
        shotId: 'SHOT-02',
        frameType: 'start',
        title: 'Start frame',
        goal: 'Open the shot.',
        status: 'planned',
        imagePath: 'workspace/KEYFRAMES/SHOT-02/SHOT-02-START.png',
        characterIds: ['dog'],
      },
      {
        keyframeId: 'SHOT-02-END',
        shotId: 'SHOT-02',
        frameType: 'end',
        title: 'End frame',
        goal: 'Close the shot.',
        status: 'planned',
        imagePath: 'workspace/KEYFRAMES/SHOT-02/SHOT-02-END.png',
        characterIds: ['dog'],
      },
    ]

    await writeRepoFile(repo.rootDir, 'workspace/CHARACTERS/dog.png', 'png')
    await writeRepoFile(repo.rootDir, 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png', 'png')
    await writeRepoFile(repo.rootDir, 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png', 'png')
    await writeRepoFile(repo.rootDir, 'workspace/KEYFRAMES/SHOT-02/SHOT-02-START.png', 'png')
    await writeRepoFile(repo.rootDir, 'workspace/KEYFRAMES/SHOT-02/SHOT-02-END.png', 'png')
    await writeRepoFile(repo.rootDir, 'workspace/SHOTS/SHOT-01.mp4', 'existing-video')

    const calls: string[] = []
    const summary = await syncShotGenerations(
      [
        {
          shotId: 'SHOT-01',
          model: 'video-test',
          prompt: 'First shot.',
          outputPath: 'workspace/SHOTS/SHOT-01.mp4',
          keyframeIds: ['SHOT-01-START', 'SHOT-01-END'],
          durationSeconds: 5,
        },
        {
          shotId: 'SHOT-02',
          model: 'video-test',
          prompt: 'Second shot.',
          outputPath: 'workspace/SHOTS/SHOT-02.mp4',
          keyframeIds: ['SHOT-02-START', 'SHOT-02-END'],
          durationSeconds: 2.5,
        },
      ],
      keyframes,
      [
        {
          characterId: 'dog',
          displayName: 'Dog',
          prompt: 'Dog sheet.',
          status: 'planned',
        },
      ],
      {
        firstOnly: true,
        cwd: repo.rootDir,
        logFile: 'workspace/test-log.jsonl',
        generator: async (input) => {
          expect(input.durationSeconds).toBe(2.5)
          calls.push(input.shotId)
          return {
            data: new TextEncoder().encode(`video:${input.shotId}`),
            mediaType: 'video/mp4',
          }
        },
      },
    )

    expect(summary).toEqual({ generatedCount: 1, skippedCount: 1 })
    expect(calls).toEqual(['SHOT-02'])
    expect(await readFile(path.resolve(repo.rootDir, 'workspace/SHOTS/SHOT-02.mp4'), 'utf8')).toBe(
      'video:SHOT-02',
    )
  } finally {
    await repo.cleanup()
  }
})

test('syncShotGenerations fails fast and logs provider errors', async () => {
  const repo = await createTestRepo()

  try {
    const keyframes: KeyframeEntry[] = [
      {
        keyframeId: 'SHOT-01-START',
        shotId: 'SHOT-01',
        frameType: 'start',
        title: 'Start frame',
        goal: 'Open the shot.',
        status: 'planned',
        imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
        characterIds: ['dog'],
      },
      {
        keyframeId: 'SHOT-01-END',
        shotId: 'SHOT-01',
        frameType: 'end',
        title: 'End frame',
        goal: 'Close the shot.',
        status: 'planned',
        imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png',
        characterIds: ['dog'],
      },
    ]

    await writeRepoFile(repo.rootDir, 'workspace/CHARACTERS/dog.png', 'png')
    await writeRepoFile(repo.rootDir, 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png', 'png')
    await writeRepoFile(repo.rootDir, 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png', 'png')

    await expect(
      syncShotGenerations(
        [
          {
            shotId: 'SHOT-01',
            model: 'video-test',
            prompt: 'First shot.',
            outputPath: 'workspace/SHOTS/SHOT-01.mp4',
            keyframeIds: ['SHOT-01-START', 'SHOT-01-END'],
            durationSeconds: 6,
          },
        ],
        keyframes,
        [
          {
            characterId: 'dog',
            displayName: 'Dog',
            prompt: 'Dog sheet.',
            status: 'planned',
          },
        ],
        {
          cwd: repo.rootDir,
          logFile: 'workspace/test-log.jsonl',
          generator: async () => {
            throw new Error('provider rejected combined request')
          },
        },
      ),
    ).rejects.toThrow('provider rejected combined request')

    const logLines = (
      await readFile(path.resolve(repo.rootDir, 'workspace/test-log.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { status: string; error: { message: string } | null })

    expect(logLines).toHaveLength(1)
    expect(logLines[0]).toMatchObject({
      status: 'error',
      error: {
        message: 'provider rejected combined request',
      },
    })
  } finally {
    await repo.cleanup()
  }
})

test('syncShotGenerations renders variantCount retained versions, selects the last one, and logs seeds', async () => {
  const repo = await createTestRepo()
  const descriptor = getShotArtifactDescriptor('SHOT-01')

  try {
    const keyframes: KeyframeEntry[] = [
      {
        keyframeId: 'SHOT-01-START',
        shotId: 'SHOT-01',
        frameType: 'start',
        title: 'Start frame',
        goal: 'Open the shot.',
        status: 'planned',
        imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
        characterIds: ['dog'],
      },
      {
        keyframeId: 'SHOT-01-END',
        shotId: 'SHOT-01',
        frameType: 'end',
        title: 'End frame',
        goal: 'Close the shot.',
        status: 'planned',
        imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png',
        characterIds: ['dog'],
      },
    ]

    await writeRepoFile(repo.rootDir, 'workspace/CHARACTERS/dog.png', 'png')
    await writeRepoFile(repo.rootDir, 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png', 'png')
    await writeRepoFile(repo.rootDir, 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png', 'png')

    const seeds: number[] = []
    const summary = await syncShotGenerations(
      [
        {
          shotId: 'SHOT-01',
          model: 'video-test',
          prompt: 'First shot.',
          outputPath: 'workspace/SHOTS/SHOT-01.mp4',
          keyframeIds: ['SHOT-01-START', 'SHOT-01-END'],
          durationSeconds: 5,
        },
      ],
      keyframes,
      [
        {
          characterId: 'dog',
          displayName: 'Dog',
          prompt: 'Dog sheet.',
          status: 'planned',
        },
      ],
      {
        variantCount: 3,
        cwd: repo.rootDir,
        logFile: 'workspace/test-log.jsonl',
        generator: async (input) => {
          seeds.push(input.seed ?? -1)
          return {
            data: new TextEncoder().encode(`video:${input.seed}`),
            mediaType: 'video/mp4',
          }
        },
      },
    )

    expect(summary).toEqual({ generatedCount: 1, skippedCount: 0 })
    expect(seeds).toEqual([1, 2, 3])
    expect(await readFile(path.resolve(repo.rootDir, 'workspace/SHOTS/SHOT-01.mp4'), 'utf8')).toBe(
      'video:3',
    )
    expect(
      await readFile(path.resolve(repo.rootDir, descriptor.historyDir, 'v1.mp4'), 'utf8'),
    ).toBe('video:1')
    expect(
      await readFile(path.resolve(repo.rootDir, descriptor.historyDir, 'v2.mp4'), 'utf8'),
    ).toBe('video:2')
    expect(
      await readFile(path.resolve(repo.rootDir, descriptor.historyDir, 'v3.mp4'), 'utf8').catch(
        () => null,
      ),
    ).toBeNull()
    expect(
      await readFile(
        path.resolve(repo.rootDir, descriptor.historyDir, 'artifact.json'),
        'utf8',
      ).catch(() => null),
    ).toBeNull()

    const logEntries = (
      await readFile(path.resolve(repo.rootDir, 'workspace/test-log.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { settings: { seed?: number } })

    expect(logEntries.map((entry) => entry.settings.seed)).toEqual([1, 2, 3])
  } finally {
    await repo.cleanup()
  }
})
