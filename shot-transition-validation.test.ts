import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { validateShots } from './validate-workflow-data'
import { loadKeyframes, loadShotPrompts, type KeyframeEntry, type ShotEntry } from './workflow-data'

async function writeRepoFile(rootDir: string, relativePath: string, content: string) {
  const filePath = path.resolve(rootDir, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')
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
      title: 'Close',
      goal: 'Close the first shot.',
      status: 'planned',
      imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png',
      characterIds: ['dog'],
    },
    {
      keyframeId: 'SHOT-02-START',
      shotId: 'SHOT-02',
      frameType: 'start',
      title: 'Continue',
      goal: 'Continue the sequence.',
      status: 'planned',
      imagePath: 'workspace/KEYFRAMES/SHOT-02/SHOT-02-START.png',
      characterIds: ['dog'],
    },
    {
      keyframeId: 'SHOT-02-END',
      shotId: 'SHOT-02',
      frameType: 'end',
      title: 'Land',
      goal: 'Land the second shot.',
      status: 'planned',
      imagePath: 'workspace/KEYFRAMES/SHOT-02/SHOT-02-END.png',
      characterIds: ['dog'],
    },
  ]
}

test('loadShotPrompts rejects missing incomingTransition', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-shot-transition-'))

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
          },
        ],
        null,
        2,
      )}\n`,
    )

    await expect(loadShotPrompts(rootDir)).rejects.toThrow(
      'SHOTS.json[0].incomingTransition must be an object.',
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('loadShotPrompts rejects empty incomingTransition notes', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-shot-transition-'))

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
              notes: '',
            },
          },
        ],
        null,
        2,
      )}\n`,
    )

    await expect(loadShotPrompts(rootDir)).rejects.toThrow(
      'SHOTS.json[0].incomingTransition.notes must be a non-empty string.',
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('validateShots rejects a first shot that is not opening', () => {
  const shots: ShotEntry[] = [
    {
      shotId: 'SHOT-01',
      status: 'planned',
      videoPath: 'workspace/SHOTS/SHOT-01.mp4',
      keyframeIds: ['SHOT-01-START', 'SHOT-01-END'],
      durationSeconds: 4,
      incomingTransition: {
        type: 'continuity',
        notes: 'Incorrect for the first shot.',
      },
    },
  ]

  expect(() => validateShots(createKeyframes(), shots)).toThrow(
    'Shot "SHOT-01" is the first SHOTS.json entry, so incomingTransition.type must be "opening".',
  )
})

test('validateShots rejects opening on later shots', () => {
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
      keyframeIds: ['SHOT-02-START', 'SHOT-02-END'],
      durationSeconds: 4,
      incomingTransition: {
        type: 'opening',
        notes: 'Incorrect reuse of opening.',
      },
    },
  ]

  expect(() => validateShots(createKeyframes(), shots)).toThrow(
    'Shot "SHOT-02" may not use incomingTransition.type "opening" unless it is the first SHOTS.json entry.',
  )
})

test('validateShots allows a start-only shot', () => {
  const shots: ShotEntry[] = [
    {
      shotId: 'SHOT-01',
      status: 'planned',
      videoPath: 'workspace/SHOTS/SHOT-01.mp4',
      keyframeIds: ['SHOT-01-START'],
      durationSeconds: 4,
      incomingTransition: {
        type: 'opening',
        notes: 'Open the sequence.',
      },
    },
  ]

  expect(() =>
    validateShots(
      createKeyframes().filter((entry) => entry.keyframeId === 'SHOT-01-START'),
      shots,
    ),
  ).not.toThrow()
})

test('validateShots allows an end-only shot', () => {
  const shots: ShotEntry[] = [
    {
      shotId: 'SHOT-01',
      status: 'planned',
      videoPath: 'workspace/SHOTS/SHOT-01.mp4',
      keyframeIds: ['SHOT-01-END'],
      durationSeconds: 4,
      incomingTransition: {
        type: 'opening',
        notes: 'Open the sequence.',
      },
    },
  ]

  expect(() =>
    validateShots(
      createKeyframes().filter((entry) => entry.keyframeId === 'SHOT-01-END'),
      shots,
    ),
  ).not.toThrow()
})

test('validateShots rejects a shot with zero keyframes', () => {
  const shots: ShotEntry[] = [
    {
      shotId: 'SHOT-01',
      status: 'planned',
      videoPath: 'workspace/SHOTS/SHOT-01.mp4',
      keyframeIds: [],
      durationSeconds: 4,
      incomingTransition: {
        type: 'opening',
        notes: 'Open the sequence.',
      },
    },
  ]

  expect(() => validateShots(createKeyframes(), shots)).toThrow(
    'Shot "SHOT-01" must reference either one anchor keyframe or a start/end pair.',
  )
})

test('loadKeyframes rejects legacy single frame types with a clear error', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-shot-transition-'))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/KEYFRAMES.json',
      `${JSON.stringify(
        [
          {
            keyframeId: 'SHOT-01-SINGLE',
            shotId: 'SHOT-01',
            frameType: 'single',
            title: 'Legacy single',
            goal: 'Old schema entry.',
            status: 'planned',
            imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-SINGLE.png',
            characterIds: ['dog'],
          },
        ],
        null,
        2,
      )}\n`,
    )

    await expect(loadKeyframes(rootDir)).rejects.toThrow(
      'KEYFRAMES.json[0].frameType must be one of: start, end.',
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
