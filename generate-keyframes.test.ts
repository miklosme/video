import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  planKeyframeGenerationReferences,
  selectPendingKeyframeGenerations,
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

test('planKeyframeGenerationReferences uses previous shot end for continuity and skips it for scene changes', () => {
  const shots = createShots()
  const keyframes = createKeyframes()

  expect(
    planKeyframeGenerationReferences(
      {
        ...keyframes[2]!,
        incomingTransition: shots[1]!.incomingTransition,
      },
      keyframes,
      shots,
    ),
  ).toEqual([
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
  ])

  expect(
    planKeyframeGenerationReferences(
      {
        ...keyframes[4]!,
        incomingTransition: shots[2]!.incomingTransition,
      },
      keyframes,
      shots,
    ),
  ).toEqual([
    {
      kind: 'storyboard',
      path: 'workspace/STORYBOARD.png',
    },
    {
      kind: 'character-sheet',
      path: 'workspace/CHARACTERS/dog.png',
    },
  ])
})

test('generate-keyframes fails for a continuity shot when the previous shot end image is missing', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-generate-keyframes-'))
  const scriptPath = fileURLToPath(new URL('./generate-keyframes.ts', import.meta.url))

  try {
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
