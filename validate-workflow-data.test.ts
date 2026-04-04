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

async function writeValidationBaseFiles(
  rootDir: string,
  storyboardReferences: Record<string, unknown>[] = [
    {
      kind: 'storyboard-template',
      path: 'templates/STORYBOARD.template.png',
    },
  ],
) {
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
    'workspace/STORYBOARD.json',
    `${JSON.stringify(
      {
        references: storyboardReferences,
      },
      null,
      2,
    )}\n`,
  )
  await writeRepoFile(rootDir, 'templates/STORYBOARD.template.png', 'template')
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
          model: 'image-test',
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

test('validate-workflow-data rejects duplicate reference paths in storyboard sidecars', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-validate-data-'))

  try {
    await writeValidationBaseFiles(rootDir, [
      {
        kind: 'storyboard-template',
        path: 'templates/STORYBOARD.template.png',
      },
      {
        kind: 'user-reference',
        path: 'templates/STORYBOARD.template.png',
      },
    ])

    const result = runValidation(rootDir)

    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toContain(
      'workspace/STORYBOARD.json has duplicate reference path "templates/STORYBOARD.template.png"',
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('validate-workflow-data rejects storyboard sidecars with non-user refs after the template', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-validate-data-'))

  try {
    await writeValidationBaseFiles(rootDir, [
      {
        kind: 'storyboard-template',
        path: 'templates/STORYBOARD.template.png',
      },
      {
        kind: 'storyboard',
        path: 'workspace/STORYBOARD.png',
      },
    ])
    await writeRepoFile(rootDir, 'workspace/STORYBOARD.png', 'storyboard')

    const result = runValidation(rootDir)

    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toContain(
      'workspace/STORYBOARD.json reference 2 must use kind "user-reference" after the storyboard template reference.',
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
            model: 'image-test',
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
    await writeRepoFile(rootDir, 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png', 'start-image')
    await writeRepoFile(
      rootDir,
      'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.json',
      `${JSON.stringify(
        {
          keyframeId: 'SHOT-01-END',
          shotId: 'SHOT-01',
          frameType: 'end',
          model: 'image-test',
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
