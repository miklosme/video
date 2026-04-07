import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

async function writeRepoFile(rootDir: string, relativePath: string, content: string) {
  const filePath = path.resolve(rootDir, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')
}

async function writeValidationBaseFiles(rootDir: string) {
  await writeRepoFile(
    rootDir,
    'CAMERA_VOCABULARY.json',
    `${JSON.stringify(
      {
        version: 1,
        source: {
          title: 'Test Camera Vocabulary',
          url: 'https://example.com/camera-vocabulary',
          accessedOn: '2026-04-05',
        },
        categories: [
          {
            id: 'shot_size',
            name: 'Shot Size',
            description: 'Test category.',
          },
          {
            id: 'camera_position',
            name: 'Camera Position',
            description: 'Test category.',
          },
          {
            id: 'camera_angle',
            name: 'Camera Angle',
            description: 'Test category.',
          },
          {
            id: 'camera_movement',
            name: 'Camera Movement',
            description: 'Test category.',
          },
        ],
        entries: [
          {
            id: 'medium-shot',
            category: 'shot_size',
            name: 'Medium Shot',
            description: 'Test entry.',
            appliesToKeyframe: true,
            appliesToShot: true,
          },
          {
            id: 'eye-level',
            category: 'camera_position',
            name: 'Eye Level',
            description: 'Test entry.',
            appliesToKeyframe: true,
            appliesToShot: true,
          },
          {
            id: 'level-angle',
            category: 'camera_angle',
            name: 'Level Angle',
            description: 'Test entry.',
            appliesToKeyframe: true,
            appliesToShot: true,
          },
          {
            id: 'static-shot',
            category: 'camera_movement',
            name: 'Static Shot',
            description: 'Test entry.',
            appliesToKeyframe: false,
            appliesToShot: true,
          },
        ],
      },
      null,
      2,
    )}\n`,
  )
  await writeRepoFile(
    rootDir,
    'MODEL_OPTIONS.json',
    `${JSON.stringify(
      {
        agentModels: ['agent-test'],
        imageModels: ['image-test'],
        videoModels: ['video-test'],
      },
      null,
      2,
    )}\n`,
  )
  await writeRepoFile(rootDir, 'workspace/IDEA.md', '# IDEA\n')
  await writeRepoFile(
    rootDir,
    'workspace/CONFIG.json',
    `${JSON.stringify(
      {
        agentModel: 'agent-test',
        imageModel: 'image-test',
        fastImageModel: 'image-test',
        videoModel: 'video-test',
        variantCount: 1,
      },
      null,
      2,
    )}\n`,
  )
  await writeRepoFile(rootDir, 'workspace/STATUS.json', '[]\n')
  await writeRepoFile(
    rootDir,
    'workspace/STORYBOARD/STORYBOARD.json',
    `${JSON.stringify(
      {
        images: [
          {
            frameType: 'start',
            goal: 'Establish the storyboard validation fixture.',
            imagePath: 'workspace/STORYBOARD/storyboard-image-alpha.png',
          },
        ],
      },
      null,
      2,
    )}\n`,
  )
}

function runValidation(rootDir: string) {
  const scriptPath = fileURLToPath(new URL('./validate-workflow-data.ts', import.meta.url))

  return Bun.spawnSync({
    cmd: [process.execPath, scriptPath],
    cwd: rootDir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

function createPlannedKeyframes(keyframeIds: string[]) {
  return keyframeIds.map((keyframeId) => ({
    keyframeId,
    frameType: keyframeId.endsWith('-END') ? ('end' as const) : ('start' as const),
    imagePath: `workspace/KEYFRAMES/${keyframeId.slice(0, 7)}/${keyframeId}.png`,
  }))
}

test('validate-workflow-data tolerates legacy sidecar model fields', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-validate-data-'))

  try {
    await writeValidationBaseFiles(rootDir)
    await writeRepoFile(
      rootDir,
      'workspace/CHARACTERS/hero.json',
      `${JSON.stringify(
        {
          characterId: 'hero',
          displayName: 'Hero',
          model: 'image-test',
          prompt: 'A clean reference.',
          status: 'ready',
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(rootDir, 'workspace/CHARACTERS/hero.png', 'hero')

    const result = runValidation(rootDir)

    expect(result.exitCode).toBe(0)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('validate-workflow-data rejects keyframe references without a typed kind', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-validate-data-'))

  try {
    await writeValidationBaseFiles(rootDir)
    await writeRepoFile(rootDir, 'workspace/STORYBOARD.md', '# STORYBOARD\n')
    await writeRepoFile(rootDir, 'workspace/STORYBOARD.png', 'storyboard')
    await writeRepoFile(
      rootDir,
      'workspace/CHARACTERS/hero.json',
      `${JSON.stringify(
        {
          characterId: 'hero',
          displayName: 'Hero',
          prompt: 'A clean reference.',
          status: 'ready',
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(rootDir, 'workspace/CHARACTERS/hero.png', 'hero')
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
          prompt: 'Prompt.',
          status: 'planned',
          references: [
            {
              path: 'workspace/STORYBOARD.png',
            },
            {
              kind: 'character-sheet',
              path: 'workspace/CHARACTERS/hero.png',
            },
          ],
        },
        null,
        2,
      )}\n`,
    )

    const result = runValidation(rootDir)

    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toContain(
      'KEYFRAMES/SHOT-01/SHOT-01-START.json.references[0].kind must be one of:',
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('validate-workflow-data rejects keyframe sidecars without explicit references', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-validate-data-'))

  try {
    await writeValidationBaseFiles(rootDir)
    await writeRepoFile(rootDir, 'workspace/STORYBOARD.md', '# STORYBOARD\n')
    await writeRepoFile(rootDir, 'workspace/STORYBOARD.png', 'storyboard')
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
          prompt: 'Prompt.',
          status: 'planned',
        },
        null,
        2,
      )}\n`,
    )

    const result = runValidation(rootDir)

    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toContain(
      'Keyframe artifact "SHOT-01-START" must declare explicit references.',
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('validate-workflow-data rejects storyboard sidecars whose first frame is an end frame', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-validate-data-'))

  try {
    await writeValidationBaseFiles(rootDir)
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD/STORYBOARD.json',
      `${JSON.stringify(
        {
          images: [
            {
              frameType: 'end',
              goal: 'Try to start the board on a closing beat.',
              imagePath: null,
              references: [],
            },
          ],
        },
        null,
        2,
      )}\n`,
    )

    const result = runValidation(rootDir)

    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toContain(
      'workspace/STORYBOARD/STORYBOARD.json.images[0] must directly follow a matching start frame in workspace/STORYBOARD/STORYBOARD.json.',
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('validate-workflow-data accepts explicit multi-character end-keyframe references with a start-frame anchor', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-validate-data-'))

  try {
    await writeValidationBaseFiles(rootDir)
    await writeRepoFile(rootDir, 'workspace/STORYBOARD.md', '# STORYBOARD\n')
    await writeRepoFile(rootDir, 'workspace/STORYBOARD.png', 'storyboard')

    for (const characterId of ['alpha', 'beta', 'gamma']) {
      await writeRepoFile(
        rootDir,
        `workspace/CHARACTERS/${characterId}.json`,
        `${JSON.stringify(
          {
            characterId,
            displayName: characterId,
            prompt: `Reference for ${characterId}.`,
            status: 'ready',
          },
          null,
          2,
        )}\n`,
      )
      await writeRepoFile(rootDir, `workspace/CHARACTERS/${characterId}.png`, characterId)
    }

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
    await writeRepoFile(rootDir, 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png', 'start-image')
    await writeRepoFile(
      rootDir,
      'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.json',
      `${JSON.stringify(
        {
          keyframeId: 'SHOT-01-END',
          shotId: 'SHOT-01',
          frameType: 'end',
          prompt: 'Prompt.',
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
              path: 'workspace/CHARACTERS/alpha.png',
            },
            {
              kind: 'character-sheet',
              path: 'workspace/CHARACTERS/beta.png',
            },
            {
              kind: 'character-sheet',
              path: 'workspace/CHARACTERS/gamma.png',
            },
          ],
        },
        null,
        2,
      )}\n`,
    )

    const result = runValidation(rootDir)

    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stdout)).toContain('"status": "ok"')
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('validate-workflow-data explains how to activate a project when workspace is missing', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-validate-data-'))

  try {
    await writeRepoFile(
      rootDir,
      'MODEL_OPTIONS.json',
      `${JSON.stringify(
        {
          agentModels: ['agent-test'],
          imageModels: ['image-test'],
          videoModels: ['video-test'],
        },
        null,
        2,
      )}\n`,
    )

    const result = runValidation(rootDir)

    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toContain(
      'No active workspace. Run bun run switch <project-name> or bun run new <project-name> first.',
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('validate-workflow-data rejects the legacy KEYFRAMES.json manifest', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-validate-data-'))

  try {
    await writeValidationBaseFiles(rootDir)
    await writeRepoFile(
      rootDir,
      'workspace/KEYFRAMES.json',
      `${JSON.stringify(
        [
          {
            keyframeId: 'SHOT-01-END',
            shotId: 'SHOT-01',
            frameType: 'end',
            imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png',
          },
        ],
        null,
        2,
      )}\n`,
    )

    const result = runValidation(rootDir)

    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toContain(
      'Legacy KEYFRAMES.json is no longer supported. Merge its entries into SHOTS.json and remove the old file.',
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('validate-workflow-data accepts FINAL-CUT.json before shot videos are rendered', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-validate-data-'))

  try {
    await writeValidationBaseFiles(rootDir)
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
      'workspace/FINAL-CUT.json',
      `${JSON.stringify(
        {
          version: 1,
          shots: [
            {
              shotId: 'SHOT-01',
              enabled: true,
              trimStartFrames: 0,
              trimEndFrames: 0,
              transition: { type: 'cut', durationFrames: 0 },
            },
          ],
          soundtrack: null,
        },
        null,
        2,
      )}\n`,
    )

    const result = runValidation(rootDir)

    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stdout)).toContain('"status": "ok"')
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('validate-workflow-data still validates FINAL-CUT.json shot mappings before shot videos exist', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-validate-data-'))

  try {
    await writeValidationBaseFiles(rootDir)
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
      'workspace/FINAL-CUT.json',
      `${JSON.stringify(
        {
          version: 1,
          shots: [
            {
              shotId: 'SHOT-99',
              enabled: true,
              trimStartFrames: 0,
              trimEndFrames: 0,
              transition: { type: 'cut', durationFrames: 0 },
            },
          ],
          soundtrack: null,
        },
        null,
        2,
      )}\n`,
    )

    const result = runValidation(rootDir)

    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toContain(
      'FINAL-CUT.json references unknown shotId "SHOT-99"',
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('validate-workflow-data accepts bridge endFrameMode when the next shot has a planned start', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-validate-data-'))

  try {
    await writeValidationBaseFiles(rootDir)
    await writeRepoFile(
      rootDir,
      'workspace/SHOTS.json',
      `${JSON.stringify(
        [
          {
            shotId: 'SHOT-01',
            status: 'planned',
            videoPath: 'workspace/SHOTS/SHOT-01.mp4',
            endFrameMode: 'bridge',
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

    const result = runValidation(rootDir)

    expect(result.exitCode).toBe(0)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('validate-workflow-data rejects bridge endFrameMode when the next shot has no planned start', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-validate-data-'))

  try {
    await writeValidationBaseFiles(rootDir)
    await writeRepoFile(
      rootDir,
      'workspace/SHOTS.json',
      `${JSON.stringify(
        [
          {
            shotId: 'SHOT-01',
            status: 'planned',
            videoPath: 'workspace/SHOTS/SHOT-01.mp4',
            endFrameMode: 'bridge',
            durationSeconds: 4,
            keyframes: createPlannedKeyframes(['SHOT-01-START']),
          },
          {
            shotId: 'SHOT-02',
            status: 'planned',
            videoPath: 'workspace/SHOTS/SHOT-02.mp4',
            durationSeconds: 4,
            keyframes: createPlannedKeyframes(['SHOT-02-END']),
          },
        ],
        null,
        2,
      )}\n`,
    )

    const result = runValidation(rootDir)

    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toContain(
      'Shot "SHOT-01" cannot use endFrameMode "bridge" because next shot "SHOT-02" has no planned "start" keyframe.',
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
