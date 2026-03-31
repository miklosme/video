import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getKeyframeArtifactDescriptor } from './artifact-control'
import {
  planKeyframeGenerationReferences,
  selectPendingKeyframeGenerations,
  syncKeyframeGenerations,
} from './generate-keyframes'
import type { KeyframeArtifactEntry, KeyframeEntry, ShotEntry } from './workflow-data'

async function writeRepoFile(rootDir: string, relativePath: string, content: string) {
  const filePath = path.resolve(rootDir, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')
}

function createShots(): ShotEntry[] {
  return [
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
    {
      shotId: 'SHOT-02',
      status: 'planned',
      videoPath: 'workspace/SHOTS/SHOT-02.mp4',
      keyframeIds: ['SHOT-02-START', 'SHOT-02-END'],
      durationSeconds: 4,
      incomingTransition: {
        type: 'continuity',
        notes: 'Carry the same geography into the next shot.',
      },
    },
    {
      shotId: 'SHOT-03',
      status: 'planned',
      videoPath: 'workspace/SHOTS/SHOT-03.mp4',
      keyframeIds: ['SHOT-03-START', 'SHOT-03-END'],
      durationSeconds: 4,
      incomingTransition: {
        type: 'scene-change',
        notes: 'Reset the composition for a fresh setup.',
      },
    },
  ]
}

function createKeyframes(): KeyframeEntry[] {
  return [
    {
      keyframeId: 'SHOT-01-START',
      shotId: 'SHOT-01',
      frameType: 'start',
      title: 'Open',
      goal: 'Open the sequence.',
      status: 'planned',
      imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
      characterIds: ['dog'],
    },
    {
      keyframeId: 'SHOT-01-END',
      shotId: 'SHOT-01',
      frameType: 'end',
      title: 'Land',
      goal: 'Land the first shot.',
      status: 'planned',
      imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png',
      characterIds: ['dog'],
    },
    {
      keyframeId: 'SHOT-02-START',
      shotId: 'SHOT-02',
      frameType: 'start',
      title: 'Continue',
      goal: 'Continue the action.',
      status: 'planned',
      imagePath: 'workspace/KEYFRAMES/SHOT-02/SHOT-02-START.png',
      characterIds: ['dog'],
    },
    {
      keyframeId: 'SHOT-02-END',
      shotId: 'SHOT-02',
      frameType: 'end',
      title: 'Close',
      goal: 'Close the second shot.',
      status: 'planned',
      imagePath: 'workspace/KEYFRAMES/SHOT-02/SHOT-02-END.png',
      characterIds: ['dog'],
    },
    {
      keyframeId: 'SHOT-03-START',
      shotId: 'SHOT-03',
      frameType: 'start',
      title: 'Reset',
      goal: 'Open a new setup.',
      status: 'planned',
      imagePath: 'workspace/KEYFRAMES/SHOT-03/SHOT-03-START.png',
      characterIds: ['dog'],
    },
    {
      keyframeId: 'SHOT-03-END',
      shotId: 'SHOT-03',
      frameType: 'end',
      title: 'Settle',
      goal: 'Settle the new setup.',
      status: 'planned',
      imagePath: 'workspace/KEYFRAMES/SHOT-03/SHOT-03-END.png',
      characterIds: ['dog'],
    },
  ]
}

function createArtifacts(): KeyframeArtifactEntry[] {
  return createKeyframes().map((entry) => ({
    keyframeId: entry.keyframeId,
    shotId: entry.shotId,
    frameType: entry.frameType,
    model: 'image-test',
    prompt: `Prompt for ${entry.keyframeId}.`,
    status: 'planned',
  }))
}

test('selectPendingKeyframeGenerations follows SHOTS order and start-before-end sequencing', () => {
  expect(
    selectPendingKeyframeGenerations(createKeyframes(), createArtifacts(), createShots()).map(
      (entry) => entry.keyframeId,
    ),
  ).toEqual([
    'SHOT-01-START',
    'SHOT-01-END',
    'SHOT-02-START',
    'SHOT-02-END',
    'SHOT-03-START',
    'SHOT-03-END',
  ])
})

test('selectPendingKeyframeGenerations supports one-anchor start-only and end-only shots', () => {
  const shots: ShotEntry[] = [
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
    {
      shotId: 'SHOT-02',
      status: 'planned',
      videoPath: 'workspace/SHOTS/SHOT-02.mp4',
      keyframeIds: ['SHOT-02-END'],
      durationSeconds: 4,
      incomingTransition: {
        type: 'scene-change',
        notes: 'Reset the composition.',
      },
    },
    {
      shotId: 'SHOT-03',
      status: 'planned',
      videoPath: 'workspace/SHOTS/SHOT-03.mp4',
      keyframeIds: ['SHOT-03-START'],
      durationSeconds: 4,
      incomingTransition: {
        type: 'scene-change',
        notes: 'Open a fresh setup.',
      },
    },
  ]
  const keyframes: KeyframeEntry[] = [
    ...createKeyframes().slice(0, 2),
    {
      keyframeId: 'SHOT-02-END',
      shotId: 'SHOT-02',
      frameType: 'end',
      title: 'Land the single anchor',
      goal: 'Use one closing frame only.',
      status: 'planned',
      imagePath: 'workspace/KEYFRAMES/SHOT-02/SHOT-02-END.png',
      characterIds: ['dog'],
    },
    {
      keyframeId: 'SHOT-03-START',
      shotId: 'SHOT-03',
      frameType: 'start',
      title: 'Open the single anchor',
      goal: 'Use one opening frame only.',
      status: 'planned',
      imagePath: 'workspace/KEYFRAMES/SHOT-03/SHOT-03-START.png',
      characterIds: ['dog'],
    },
  ]
  const artifacts: KeyframeArtifactEntry[] = keyframes.map((entry) => ({
    keyframeId: entry.keyframeId,
    shotId: entry.shotId,
    frameType: entry.frameType,
    model: 'image-test',
    prompt: `Prompt for ${entry.keyframeId}.`,
    status: 'planned',
  }))

  expect(
    selectPendingKeyframeGenerations(keyframes, artifacts, shots).map((entry) => entry.keyframeId),
  ).toEqual(['SHOT-01-START', 'SHOT-01-END', 'SHOT-02-END', 'SHOT-03-START'])
})

test('planKeyframeGenerationReferences uses previous shot end for continuity and skips it for scene changes', () => {
  const shots = createShots()
  const keyframes = createKeyframes()
  const continuityReferences = [
    {
      kind: 'previous-shot-end-frame' as const,
      path: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png',
    },
    {
      kind: 'storyboard' as const,
      path: 'workspace/STORYBOARD.png',
    },
    {
      kind: 'character-sheet' as const,
      path: 'workspace/CHARACTERS/dog.png',
    },
  ]
  const sceneChangeReferences = [
    {
      kind: 'storyboard' as const,
      path: 'workspace/STORYBOARD.png',
    },
    {
      kind: 'character-sheet' as const,
      path: 'workspace/CHARACTERS/dog.png',
    },
  ]

  expect(
    planKeyframeGenerationReferences(
      {
        ...keyframes[2]!,
        incomingTransition: shots[1]!.incomingTransition,
      },
      keyframes,
      shots,
      {
        userReferences: continuityReferences,
      },
    ),
  ).toEqual(continuityReferences)

  expect(
    planKeyframeGenerationReferences(
      {
        ...keyframes[4]!,
        incomingTransition: shots[2]!.incomingTransition,
      },
      keyframes,
      shots,
      {
        userReferences: sceneChangeReferences,
      },
    ),
  ).toEqual(sceneChangeReferences)
})

test('planKeyframeGenerationReferences preserves authored references for end-only shots', () => {
  const keyframes: KeyframeEntry[] = [
    {
      keyframeId: 'SHOT-04-END',
      shotId: 'SHOT-04',
      frameType: 'end',
      title: 'Single end anchor',
      goal: 'Use one closing anchor only.',
      status: 'planned',
      imagePath: 'workspace/KEYFRAMES/SHOT-04/SHOT-04-END.png',
      characterIds: ['dog'],
    },
  ]
  const shots: ShotEntry[] = [
    {
      shotId: 'SHOT-04',
      status: 'planned',
      videoPath: 'workspace/SHOTS/SHOT-04.mp4',
      keyframeIds: ['SHOT-04-END'],
      durationSeconds: 4,
      incomingTransition: {
        type: 'scene-change',
        notes: 'Reset the composition for a fresh setup.',
      },
    },
  ]
  const endOnlyReferences = [
    {
      kind: 'storyboard' as const,
      path: 'workspace/STORYBOARD.png',
    },
    {
      kind: 'character-sheet' as const,
      path: 'workspace/CHARACTERS/dog.png',
    },
  ]

  expect(
    planKeyframeGenerationReferences(
      {
        ...keyframes[0]!,
        incomingTransition: shots[0]!.incomingTransition,
      },
      keyframes,
      shots,
      {
        userReferences: endOnlyReferences,
      },
    ),
  ).toEqual(endOnlyReferences)
})

test('generate-keyframes fails for a continuity shot when the previous shot end image is missing', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-generate-keyframes-'))
  const scriptPath = fileURLToPath(new URL('./generate-keyframes.ts', import.meta.url))

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
    await writeRepoFile(
      rootDir,
      'workspace/SHOTS.json',
      `${JSON.stringify(createShots().slice(0, 2), null, 2)}\n`,
    )
    await writeRepoFile(
      rootDir,
      'workspace/KEYFRAMES.json',
      `${JSON.stringify(createKeyframes().slice(0, 4), null, 2)}\n`,
    )
    await writeRepoFile(rootDir, 'workspace/STORYBOARD.png', 'storyboard')
    await writeRepoFile(rootDir, 'workspace/CHARACTERS/dog.png', 'character')
    await writeRepoFile(
      rootDir,
      'workspace/KEYFRAMES/SHOT-02/SHOT-02-START.json',
      `${JSON.stringify(
        {
          keyframeId: 'SHOT-02-START',
          shotId: 'SHOT-02',
          frameType: 'start',
          model: 'image-test',
          prompt: 'Prompt for SHOT-02-START.',
          status: 'planned',
          references: [
            {
              kind: 'previous-shot-end-frame',
              path: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png',
            },
            {
              kind: 'storyboard',
              path: 'workspace/STORYBOARD.png',
            },
            {
              kind: 'character-sheet',
              path: 'workspace/CHARACTERS/dog.png',
            },
          ],
        },
        null,
        2,
      )}\n`,
    )

    const result = Bun.spawnSync({
      cmd: [process.execPath, scriptPath, '--shot-id', 'SHOT-02'],
      cwd: rootDir,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toContain(
      'required previous-shot-end-frame reference is missing at workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png',
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('generate-keyframes fails for an end keyframe when the same-shot start image is missing', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-generate-keyframes-'))
  const scriptPath = fileURLToPath(new URL('./generate-keyframes.ts', import.meta.url))

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
    await writeRepoFile(
      rootDir,
      'workspace/SHOTS.json',
      `${JSON.stringify(createShots().slice(0, 1), null, 2)}\n`,
    )
    await writeRepoFile(
      rootDir,
      'workspace/KEYFRAMES.json',
      `${JSON.stringify(createKeyframes().slice(0, 2), null, 2)}\n`,
    )
    await writeRepoFile(rootDir, 'workspace/STORYBOARD.png', 'storyboard')
    await writeRepoFile(rootDir, 'workspace/CHARACTERS/dog.png', 'character')
    await writeRepoFile(
      rootDir,
      'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.json',
      `${JSON.stringify(
        {
          keyframeId: 'SHOT-01-END',
          shotId: 'SHOT-01',
          frameType: 'end',
          model: 'image-test',
          prompt: 'Prompt for SHOT-01-END.',
          status: 'planned',
          references: [
            {
              kind: 'start-frame',
              path: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
            },
            {
              kind: 'storyboard',
              path: 'workspace/STORYBOARD.png',
            },
            {
              kind: 'character-sheet',
              path: 'workspace/CHARACTERS/dog.png',
            },
          ],
        },
        null,
        2,
      )}\n`,
    )

    const result = Bun.spawnSync({
      cmd: [process.execPath, scriptPath, '--keyframe-id', 'SHOT-01-END'],
      cwd: rootDir,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toContain(
      'required start-frame reference is missing at workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('syncKeyframeGenerations renders variantCount retained versions and selects the last one', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-keyframe-variants-'))
  const keyframes = createKeyframes()
  const shots = createShots()
  const generation = {
    keyframeId: 'SHOT-01-START',
    shotId: 'SHOT-01',
    frameType: 'start' as const,
    model: 'image-test',
    prompt: 'Prompt for SHOT-01-START.',
    outputPath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
    characterIds: ['dog'],
    incomingTransition: shots[0]!.incomingTransition,
    userReferences: [
      {
        kind: 'storyboard' as const,
        path: 'workspace/STORYBOARD.png',
      },
      {
        kind: 'character-sheet' as const,
        path: 'workspace/CHARACTERS/dog.png',
      },
    ],
  }
  const descriptor = getKeyframeArtifactDescriptor(generation)

  try {
    await writeRepoFile(rootDir, 'workspace/STORYBOARD.png', 'storyboard')
    await writeRepoFile(rootDir, 'workspace/CHARACTERS/dog.png', 'dog')

    const seeds: number[] = []
    const summary = await syncKeyframeGenerations([generation], keyframes, shots, {
      variantCount: 3,
      cwd: rootDir,
      generator: async (input) => {
        seeds.push(input.seed ?? -1)

        if (!input.outputPath) {
          throw new Error('Expected outputPath for keyframe generation test.')
        }

        await writeRepoFile(rootDir, input.outputPath, `keyframe:${input.seed}`)

        return {
          generationId: `gen-${input.seed}`,
          model: input.model ?? 'image-test',
          outputPaths: [path.resolve(rootDir, input.outputPath)],
        }
      },
    })

    expect(summary).toEqual({ generatedCount: 1, skippedCount: 0 })
    expect(seeds).toEqual([1, 2, 3])
    expect(
      await readFile(
        path.resolve(rootDir, 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png'),
        'utf8',
      ),
    ).toBe('keyframe:3')
    expect(await readFile(path.resolve(rootDir, descriptor.historyDir, 'v1.png'), 'utf8')).toBe(
      'keyframe:1',
    )
    expect(await readFile(path.resolve(rootDir, descriptor.historyDir, 'v2.png'), 'utf8')).toBe(
      'keyframe:2',
    )
    expect(
      await readFile(path.resolve(rootDir, descriptor.historyDir, 'v3.png'), 'utf8').catch(
        () => null,
      ),
    ).toBeNull()
    expect(
      await readFile(path.resolve(rootDir, descriptor.historyDir, 'artifact.json'), 'utf8').catch(
        () => null,
      ),
    ).toBeNull()
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
