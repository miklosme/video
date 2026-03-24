import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

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
            keyframeIds: ['SHOT-01-START', 'SHOT-01-END'],
            durationSeconds: 4,
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
            keyframeIds: ['SHOT-01-START', 'SHOT-01-END'],
          },
        ],
        null,
        2,
      )}\n`,
    )

    const shots = await loadShotPrompts(repo.rootDir)

    expect(shots[0]?.durationSeconds).toBe(8)
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
          model: 'video-test',
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
        model: 'video-test',
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
          model: 'video-test',
          prompt: 'A concise motion prompt.',
          status: 'planned',
        },
        {
          shotId: 'SHOT-99',
          model: 'video-test',
          prompt: 'Unused.',
          status: 'planned',
        },
      ],
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
    characterIds: ['dog', 'pack', 'bowl', 'room'],
    characterReferencePaths: [
      'workspace/CHARACTERS/dog.png',
      'workspace/CHARACTERS/pack.png',
      'workspace/CHARACTERS/bowl.png',
    ],
    references: [
      {
        kind: 'start-frame',
        path: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
      },
      {
        kind: 'end-frame',
        path: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png',
      },
      {
        kind: 'character-sheet',
        path: 'workspace/CHARACTERS/dog.png',
      },
      {
        kind: 'character-sheet',
        path: 'workspace/CHARACTERS/pack.png',
      },
      {
        kind: 'character-sheet',
        path: 'workspace/CHARACTERS/bowl.png',
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
          model: 'image-test',
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
            model: 'image-test',
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
