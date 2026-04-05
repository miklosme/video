import { expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { selectPendingCharacterSheetGenerations } from './generate-character-sheets'
import {
  planKeyframeGenerationReferences,
  resolveKeyframeGenerationPrompt,
  selectPendingKeyframeGenerations,
} from './generate-keyframes'
import type { AiGenerationEventInput, PostHogTelemetry, WorkflowEventProperties } from './posthog'
import { createVideoAgentRuntime, type WorkflowSummary } from './video-agent-core'
import { loadKeyframes, type KeyframeEntry, type ShotEntry } from './workflow-data'

async function writeRepoFile(rootDir: string, relativePath: string, content: string) {
  const filePath = path.resolve(rootDir, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')
}

async function fileExists(filePath: string) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function createTestRepo() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-agent-core-'))

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
  await writeRepoFile(rootDir, 'CREATIVE_AGENTS.md', 'Creative prompt for tests.\n')
  await writeRepoFile(rootDir, 'MODEL_PROMPTING_GUIDE.md', 'Prompting guide for tests.\n')
  await writeRepoFile(rootDir, 'templates/STATUS.template.json', '[]\n')
  await writeRepoFile(
    rootDir,
    'templates/STORYBOARD.template.json',
    `${JSON.stringify(
      {
        references: [
          {
            kind: 'storyboard-template',
            path: 'templates/STORYBOARD.template.png',
          },
        ],
      },
      null,
      2,
    )}\n`,
  )

  return {
    rootDir,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true })
    },
  }
}

function createValidConfig() {
  return `${JSON.stringify(
    {
      agentModel: 'agent-test',
      imageModel: 'image-test',
      videoModel: 'video-test',
      variantCount: 1,
    },
    null,
    2,
  )}\n`
}

function createWorkflowStatus(items: Array<Record<string, unknown>>) {
  return `${JSON.stringify(items, null, 2)}\n`
}

function createPlannedKeyframes(keyframeIds: string[]) {
  return keyframeIds.map((keyframeId) => ({
    keyframeId,
    frameType: keyframeId.endsWith('-END') ? ('end' as const) : ('start' as const),
    imagePath: `workspace/KEYFRAMES/${keyframeId.slice(0, 7)}/${keyframeId}.png`,
  }))
}

test('loadWorkflowSummary derives milestone readiness from workspace files', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(repo.rootDir, 'workspace/CONFIG.json', createValidConfig())
    await writeRepoFile(
      repo.rootDir,
      'workspace/STATUS.json',
      createWorkflowStatus([
        {
          title: 'Clarify idea',
          instruction: 'Capture the project brief.',
          checked: false,
          relatedFiles: ['IDEA.md'],
        },
        {
          title: 'Draft story',
          instruction: 'Write the story.',
          checked: false,
          relatedFiles: ['STORY.md'],
        },
      ]),
    )
    await writeRepoFile(
      repo.rootDir,
      'workspace/IDEA.md',
      '# Idea\n\nA strange and vivid test premise with enough detail to count as ready.\n',
    )

    const runtime = createVideoAgentRuntime({ rootDir: repo.rootDir, creativePrompt: 'test' })
    const workflow = await runtime.loadWorkflowSummary()

    expect(workflow.checkedItems).toBe(1)
    expect(workflow.totalItems).toBe(2)
    expect(workflow.status[0]).toMatchObject({ checked: true, state: 'ready' })
    expect(workflow.status[1]).toMatchObject({ checked: false, state: 'missing' })
    expect(workflow.nextMilestone).toMatchObject({ index: 1, title: 'Draft story' })

    const persistedStatus = JSON.parse(
      await readFile(path.resolve(repo.rootDir, 'workspace/STATUS.json'), 'utf8'),
    ) as Array<{ checked: boolean }>
    expect(persistedStatus[0]?.checked).toBe(true)
    expect(persistedStatus[1]?.checked).toBe(false)
  } finally {
    await repo.cleanup()
  }
})

test('writeWorkspaceFile rolls back invalid writes', async () => {
  const repo = await createTestRepo()

  try {
    const originalConfig = createValidConfig()
    await writeRepoFile(repo.rootDir, 'workspace/CONFIG.json', originalConfig)
    await writeRepoFile(repo.rootDir, 'workspace/STATUS.json', createWorkflowStatus([]))

    const runtime = createVideoAgentRuntime({ rootDir: repo.rootDir, creativePrompt: 'test' })

    await expect(
      runtime.writeWorkspaceFile(
        'CONFIG.json',
        JSON.stringify(
          {
            agentModel: 'unknown-model',
            imageModel: 'image-test',
            videoModel: 'video-test',
            variantCount: 1,
          },
          null,
          2,
        ),
      ),
    ).rejects.toThrow('CONFIG.json.agentModel must match one of the configured values')

    const nextConfig = await readFile(path.resolve(repo.rootDir, 'workspace/CONFIG.json'), 'utf8')
    expect(nextConfig).toBe(originalConfig)
  } finally {
    await repo.cleanup()
  }
})

test('bootstrapNextMilestoneScaffold copies the next milestone template into workspace', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(repo.rootDir, 'workspace/CONFIG.json', createValidConfig())
    await writeRepoFile(
      repo.rootDir,
      'workspace/STATUS.json',
      createWorkflowStatus([
        {
          title: 'Clarify idea',
          instruction: 'Capture the project brief.',
          checked: true,
          relatedFiles: ['IDEA.md'],
        },
        {
          title: 'Draft story',
          instruction: 'Write the story.',
          checked: false,
          relatedFiles: ['STORY.md'],
        },
      ]),
    )
    await writeRepoFile(
      repo.rootDir,
      'workspace/IDEA.md',
      '# Idea\n\nA grounded concept with enough detail to count as ready.\n',
    )
    await writeRepoFile(repo.rootDir, 'templates/STORY.template.md', '# Story\n\nTBD\n')

    const runtime = createVideoAgentRuntime({ rootDir: repo.rootDir, creativePrompt: 'test' })
    const workflow = await runtime.loadWorkflowSummary()
    const bootstrappedFiles = await runtime.bootstrapNextMilestoneScaffold(workflow)

    expect(bootstrappedFiles).toHaveLength(1)
    expect(bootstrappedFiles[0]?.fileName).toBe('STORY.md')
    expect(await readFile(path.resolve(repo.rootDir, 'workspace/STORY.md'), 'utf8')).toBe(
      '# Story\n\nTBD\n',
    )
  } finally {
    await repo.cleanup()
  }
})

test('resetWorkflowFromMilestone only removes the selected milestone artifacts', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(repo.rootDir, 'workspace/CONFIG.json', createValidConfig())
    await writeRepoFile(
      repo.rootDir,
      'workspace/STATUS.json',
      createWorkflowStatus([
        {
          title: 'Clarify idea',
          instruction: 'Capture the project brief.',
          checked: true,
          relatedFiles: ['IDEA.md'],
        },
        {
          title: 'Draft story',
          instruction: 'Write the story.',
          checked: true,
          relatedFiles: ['STORY.md'],
        },
      ]),
    )
    await writeRepoFile(
      repo.rootDir,
      'workspace/IDEA.md',
      '# Idea\n\nA grounded concept with enough detail to count as ready.\n',
    )
    await writeRepoFile(
      repo.rootDir,
      'workspace/STORY.md',
      '# Story\n\nA complete story file that should be removed by reset.\n',
    )

    const runtime = createVideoAgentRuntime({ rootDir: repo.rootDir, creativePrompt: 'test' })
    const result = await runtime.resetWorkflowFromMilestone(1)

    expect(result.removedFiles).toEqual(['STORY.md'])
    expect(await fileExists(path.resolve(repo.rootDir, 'workspace/IDEA.md'))).toBe(true)
    expect(await fileExists(path.resolve(repo.rootDir, 'workspace/STORY.md'))).toBe(false)

    const nextStatus = JSON.parse(
      await readFile(path.resolve(repo.rootDir, 'workspace/STATUS.json'), 'utf8'),
    ) as Array<{ checked: boolean }>
    expect(nextStatus[0]?.checked).toBe(true)
    expect(nextStatus[1]?.checked).toBe(false)
  } finally {
    await repo.cleanup()
  }
})

test('loadWorkflowSummary distinguishes keyframe preparation from keyframe review', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(repo.rootDir, 'workspace/CONFIG.json', createValidConfig())
    await writeRepoFile(
      repo.rootDir,
      'workspace/STATUS.json',
      createWorkflowStatus([
        {
          title: 'Plan keyframes',
          instruction: 'Plan the keyframes.',
          checked: false,
          relatedFiles: ['SHOTS.json'],
        },
        {
          title: 'Prepare keyframes',
          instruction: 'Write the sidecars.',
          checked: false,
          relatedFiles: ['SHOTS.json', 'KEYFRAMES/'],
        },
        {
          title: 'Review keyframes',
          instruction: 'Review the rendered PNGs.',
          checked: false,
          relatedFiles: ['SHOTS.json', 'KEYFRAMES/'],
        },
      ]),
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
    await writeRepoFile(
      repo.rootDir,
      'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.json',
      `${JSON.stringify(
        {
          keyframeId: 'SHOT-01-START',
          shotId: 'SHOT-01',
          frameType: 'start',
          prompt: 'A calm opening frame.',
          status: 'planned',
          references: [
            {
              kind: 'storyboard',
              path: 'workspace/STORYBOARD.png',
            },
          ],
        },
        null,
        2,
      )}\n`,
    )

    const runtime = createVideoAgentRuntime({ rootDir: repo.rootDir, creativePrompt: 'test' })
    const workflow = await runtime.loadWorkflowSummary()

    expect(workflow.status[0]).toMatchObject({ checked: true, state: 'approved' })
    expect(workflow.status[1]).toMatchObject({ checked: true, state: 'ready' })
    expect(workflow.status[2]).toMatchObject({ checked: false, state: 'incomplete' })
    expect(workflow.nextMilestone).toMatchObject({ title: 'Review keyframes' })
  } finally {
    await repo.cleanup()
  }
})

test('loadWorkflowSummary keeps keyframe preparation incomplete when sidecar references are missing', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(repo.rootDir, 'workspace/CONFIG.json', createValidConfig())
    await writeRepoFile(
      repo.rootDir,
      'workspace/STATUS.json',
      createWorkflowStatus([
        {
          title: 'Plan keyframes',
          instruction: 'Plan the keyframes.',
          checked: false,
          relatedFiles: ['SHOTS.json'],
        },
        {
          title: 'Prepare keyframes',
          instruction: 'Write the sidecars.',
          checked: false,
          relatedFiles: ['SHOTS.json', 'KEYFRAMES/'],
        },
      ]),
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
    await writeRepoFile(
      repo.rootDir,
      'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.json',
      `${JSON.stringify(
        {
          keyframeId: 'SHOT-01-START',
          shotId: 'SHOT-01',
          frameType: 'start',
          prompt: 'A calm opening frame.',
          status: 'planned',
        },
        null,
        2,
      )}\n`,
    )

    const runtime = createVideoAgentRuntime({ rootDir: repo.rootDir, creativePrompt: 'test' })
    const workflow = await runtime.loadWorkflowSummary()

    expect(workflow.status[0]).toMatchObject({ checked: true, state: 'ready' })
    expect(workflow.status[1]).toMatchObject({ checked: false, state: 'incomplete' })
    expect(workflow.nextMilestone).toMatchObject({ title: 'Prepare keyframes' })
  } finally {
    await repo.cleanup()
  }
})

test('loadWorkflowSummary distinguishes storyboard authoring from storyboard review', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(repo.rootDir, 'workspace/CONFIG.json', createValidConfig())
    await writeRepoFile(
      repo.rootDir,
      'workspace/STATUS.json',
      createWorkflowStatus([
        {
          title: 'Build storyboard',
          instruction: 'Write the storyboard markdown.',
          checked: false,
          relatedFiles: ['STORYBOARD.md'],
        },
        {
          title: 'Review storyboard',
          instruction: 'Review the storyboard image.',
          checked: false,
          relatedFiles: ['STORYBOARD.md', 'STORYBOARD.png'],
        },
        {
          title: 'Plan keyframes',
          instruction: 'Plan the keyframes.',
          checked: false,
          relatedFiles: ['SHOTS.json'],
        },
      ]),
    )
    await writeRepoFile(
      repo.rootDir,
      'workspace/STORYBOARD.md',
      '# STORYBOARD\n\n## SHOT-01\n\n- Purpose: Establish the dog.\n- Visual: The white dog sits by the bowl.\n',
    )

    const runtime = createVideoAgentRuntime({ rootDir: repo.rootDir, creativePrompt: 'test' })
    const workflowBeforeImage = await runtime.loadWorkflowSummary()

    expect(workflowBeforeImage.status[0]).toMatchObject({ checked: true, state: 'ready' })
    expect(workflowBeforeImage.status[1]).toMatchObject({
      checked: false,
      state: 'incomplete',
      relatedFiles: ['STORYBOARD.md', 'STORYBOARD.json', 'STORYBOARD.png'],
    })
    expect(workflowBeforeImage.nextMilestone).toMatchObject({ title: 'Review storyboard' })

    await writeRepoFile(repo.rootDir, 'workspace/STORYBOARD.png', 'png-bytes')

    const workflowWithoutSidecar = await runtime.loadWorkflowSummary()

    expect(workflowWithoutSidecar.status[1]).toMatchObject({
      checked: false,
      state: 'incomplete',
    })

    await writeRepoFile(
      repo.rootDir,
      'workspace/STORYBOARD.json',
      `${JSON.stringify(
        {
          references: [
            {
              kind: 'storyboard-template',
              path: 'templates/STORYBOARD.template.png',
            },
          ],
        },
        null,
        2,
      )}\n`,
    )

    const workflowAfterImage = await runtime.loadWorkflowSummary()

    expect(workflowAfterImage.status[1]).toMatchObject({ checked: true, state: 'ready' })
    expect(workflowAfterImage.nextMilestone).toMatchObject({ title: 'Plan keyframes' })
  } finally {
    await repo.cleanup()
  }
})

test('writeWorkspaceFile bootstraps storyboard sidecar after storyboard markdown is written', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(repo.rootDir, 'workspace/CONFIG.json', createValidConfig())
    await writeRepoFile(
      repo.rootDir,
      'workspace/STATUS.json',
      createWorkflowStatus([
        {
          title: 'Build storyboard',
          instruction: 'Write the storyboard markdown.',
          checked: false,
          relatedFiles: ['STORYBOARD.md'],
        },
        {
          title: 'Review storyboard',
          instruction: 'Review the storyboard image.',
          checked: false,
          relatedFiles: ['STORYBOARD.md', 'STORYBOARD.png'],
        },
      ]),
    )

    const runtime = createVideoAgentRuntime({ rootDir: repo.rootDir, creativePrompt: 'test' })
    const result = await runtime.writeWorkspaceFile(
      'STORYBOARD.md',
      '# STORYBOARD\n\n## SHOT-01\n\n- Purpose: Establish the dog.\n- Visual: The white dog sits by the bowl.\n',
    )

    expect(result.bootstrappedFiles).toEqual([
      {
        fileName: 'STORYBOARD.json',
        workspacePath: path.resolve(repo.rootDir, 'workspace/STORYBOARD.json'),
      },
    ])
    expect(await readFile(path.resolve(repo.rootDir, 'workspace/STORYBOARD.json'), 'utf8')).toBe(
      `${JSON.stringify(
        {
          references: [
            {
              kind: 'storyboard-template',
              path: 'templates/STORYBOARD.template.png',
            },
          ],
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    await repo.cleanup()
  }
})

test('writeWorkspaceArtifact strips model fields from image sidecars', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(repo.rootDir, 'workspace/CONFIG.json', createValidConfig())
    await writeRepoFile(repo.rootDir, 'workspace/STATUS.json', createWorkflowStatus([]))

    const runtime = createVideoAgentRuntime({ rootDir: repo.rootDir, creativePrompt: 'test' })

    await runtime.writeWorkspaceArtifact(
      'CHARACTERS/test-dog.json',
      JSON.stringify(
        {
          characterId: 'test-dog',
          displayName: 'Test Dog',
          model: 'wrong-model',
          prompt: 'Character sheet prompt.',
          status: 'planned',
        },
        null,
        2,
      ),
    )

    const savedArtifact = JSON.parse(
      await readFile(path.resolve(repo.rootDir, 'workspace/CHARACTERS/test-dog.json'), 'utf8'),
    ) as { model?: string }

    expect(savedArtifact.model).toBeUndefined()
  } finally {
    await repo.cleanup()
  }
})

test('writeWorkspaceArtifact strips model fields from shot sidecars', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(repo.rootDir, 'workspace/CONFIG.json', createValidConfig())
    await writeRepoFile(repo.rootDir, 'workspace/STATUS.json', createWorkflowStatus([]))

    const runtime = createVideoAgentRuntime({ rootDir: repo.rootDir, creativePrompt: 'test' })

    await runtime.writeWorkspaceArtifact(
      'SHOTS/SHOT-01.json',
      JSON.stringify(
        {
          shotId: 'SHOT-01',
          model: 'wrong-model',
          prompt: 'Shot prompt.',
          status: 'planned',
        },
        null,
        2,
      ),
    )

    const savedArtifact = JSON.parse(
      await readFile(path.resolve(repo.rootDir, 'workspace/SHOTS/SHOT-01.json'), 'utf8'),
    ) as { model?: string }

    expect(savedArtifact.model).toBeUndefined()
  } finally {
    await repo.cleanup()
  }
})

test('artifact generation planning uses sidecars and canonical output paths', () => {
  const keyframeGenerations = selectPendingKeyframeGenerations(
    [
      {
        keyframeId: 'SHOT-01-START',
        shotId: 'SHOT-01',
        frameType: 'start',
        title: 'Opening frame',
        goal: 'Set the opening pose.',
        status: 'planned',
        imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
        characterIds: ['test-dog'],
      },
      {
        keyframeId: 'SHOT-01-END',
        shotId: 'SHOT-01',
        frameType: 'end',
        title: 'Ending frame',
        goal: 'Land the pose.',
        status: 'planned',
        imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png',
        characterIds: ['test-dog'],
      },
    ],
    [
      {
        keyframeId: 'SHOT-01-START',
        shotId: 'SHOT-01',
        frameType: 'start',
        prompt: 'A calm opening frame.',
        status: 'planned',
      },
      {
        keyframeId: 'ORPHAN-FRAME',
        shotId: 'SHOT-99',
        frameType: 'end',
        prompt: 'Unused.',
        status: 'planned',
      },
    ],
    [
      {
        shotId: 'SHOT-01',
        status: 'planned',
        videoPath: 'workspace/SHOTS/SHOT-01.mp4',
        keyframes: createPlannedKeyframes(['SHOT-01-START', 'SHOT-01-END']),
        keyframeIds: ['SHOT-01-START', 'SHOT-01-END'],
        durationSeconds: 4,
      },
    ],
    'image-test',
  )

  const characterGenerations = selectPendingCharacterSheetGenerations(
    [
      {
        characterId: 'test-dog',
        displayName: 'Test Dog',
        prompt: 'Character sheet prompt.',
        status: 'planned',
      },
    ],
    'image-test',
  )

  expect(keyframeGenerations).toEqual([
    {
      keyframeId: 'SHOT-01-START',
      shotId: 'SHOT-01',
      frameType: 'start',
      model: 'image-test',
      prompt: 'A calm opening frame.',
      outputPath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
      userReferences: undefined,
    },
  ])
  expect(characterGenerations).toEqual([
    {
      characterId: 'test-dog',
      displayName: 'Test Dog',
      model: 'image-test',
      prompt: 'Character sheet prompt.',
      outputPath: 'workspace/CHARACTERS/test-dog.png',
    },
  ])
})

test('loadKeyframes flattens planned keyframes from SHOTS.json', async () => {
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
            keyframes: createPlannedKeyframes(['SHOT-01-START']),
          },
        ],
        null,
        2,
      )}\n`,
    )

    const keyframes = await loadKeyframes(repo.rootDir)

    expect(keyframes).toEqual([
      {
        keyframeId: 'SHOT-01-START',
        shotId: 'SHOT-01',
        frameType: 'start',
        imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
      },
    ])
  } finally {
    await repo.cleanup()
  }
})

test('loadWorkflowSummary distinguishes shot planning from shot preparation and review', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(repo.rootDir, 'workspace/CONFIG.json', createValidConfig())
    await writeRepoFile(
      repo.rootDir,
      'workspace/STATUS.json',
      createWorkflowStatus([
        {
          title: 'Plan shots',
          instruction: 'Plan the shots.',
          checked: false,
          relatedFiles: ['SHOTS.json'],
        },
        {
          title: 'Prepare shots',
          instruction: 'Write the shot sidecars.',
          checked: false,
          relatedFiles: ['SHOTS.json', 'SHOTS/'],
        },
        {
          title: 'Review shots',
          instruction: 'Review the rendered videos.',
          checked: false,
          relatedFiles: ['SHOTS.json', 'SHOTS/'],
        },
      ]),
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
            keyframes: createPlannedKeyframes(['SHOT-01-START', 'SHOT-01-END']),
          },
        ],
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(
      repo.rootDir,
      'workspace/SHOTS/SHOT-01.json',
      `${JSON.stringify(
        {
          shotId: 'SHOT-01',
          prompt: 'A clean shot prompt.',
          status: 'planned',
        },
        null,
        2,
      )}\n`,
    )

    const runtime = createVideoAgentRuntime({ rootDir: repo.rootDir, creativePrompt: 'test' })
    const workflowBeforeVideo = await runtime.loadWorkflowSummary()

    expect(workflowBeforeVideo.status[0]).toMatchObject({ checked: true, state: 'approved' })
    expect(workflowBeforeVideo.status[1]).toMatchObject({ checked: true, state: 'ready' })
    expect(workflowBeforeVideo.status[2]).toMatchObject({ checked: false, state: 'incomplete' })

    await writeRepoFile(repo.rootDir, 'workspace/SHOTS/SHOT-01.mp4', 'video-bytes')

    const workflowAfterVideo = await runtime.loadWorkflowSummary()

    expect(workflowAfterVideo.status[2]).toMatchObject({ checked: true, state: 'ready' })
  } finally {
    await repo.cleanup()
  }
})

test('keyframe reference planning preserves explicit authored reference order', () => {
  const keyframes: KeyframeEntry[] = [
    {
      keyframeId: 'SHOT-01-START',
      shotId: 'SHOT-01',
      frameType: 'start',
      title: 'Opening frame',
      goal: 'Set the opening pose.',
      status: 'planned',
      imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
      characterIds: ['dog-01'],
    },
    {
      keyframeId: 'SHOT-01-END',
      shotId: 'SHOT-01',
      frameType: 'end',
      title: 'Ending frame',
      goal: 'Set the ending pose.',
      status: 'planned',
      imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png',
      characterIds: ['dog-01'],
    },
  ]
  const shots: ShotEntry[] = [
    {
      shotId: 'SHOT-01',
      status: 'planned',
      videoPath: 'workspace/SHOTS/SHOT-01.mp4',
      keyframeIds: ['SHOT-01-START', 'SHOT-01-END'],
      durationSeconds: 4,
    },
  ]

  expect(
    planKeyframeGenerationReferences(
      {
        ...keyframes[0]!,
      },
      [...keyframes],
      [...shots],
      {
        userReferences: [
          {
            kind: 'storyboard',
            path: 'workspace/STORYBOARD.png',
          },
          {
            kind: 'character-sheet',
            path: 'workspace/CHARACTERS/dog-01.png',
          },
        ],
      },
    ),
  ).toEqual([
    {
      kind: 'storyboard',
      path: 'workspace/STORYBOARD.png',
    },
    {
      kind: 'character-sheet',
      path: 'workspace/CHARACTERS/dog-01.png',
    },
  ])

  expect(
    planKeyframeGenerationReferences(
      {
        ...keyframes[1]!,
      },
      [...keyframes],
      [...shots],
      {
        userReferences: [
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
            path: 'workspace/CHARACTERS/dog-01.png',
          },
        ],
      },
    ),
  ).toEqual([
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
      path: 'workspace/CHARACTERS/dog-01.png',
    },
  ])

  expect(
    planKeyframeGenerationReferences(
      {
        keyframeId: 'SHOT-02-END',
        shotId: 'SHOT-02',
        frameType: 'end',
        characterIds: ['dog-01'],
      },
      [...keyframes],
      [
        ...shots,
        {
          shotId: 'SHOT-02',
          status: 'planned',
          videoPath: 'workspace/SHOTS/SHOT-02.mp4',
          keyframeIds: ['SHOT-02-END'],
          durationSeconds: 4,
        },
      ],
      {
        userReferences: [
          {
            kind: 'storyboard',
            path: 'workspace/STORYBOARD.png',
          },
          {
            kind: 'character-sheet',
            path: 'workspace/CHARACTERS/dog-01.png',
          },
        ],
      },
    ),
  ).toEqual([
    {
      kind: 'storyboard',
      path: 'workspace/STORYBOARD.png',
    },
    {
      kind: 'character-sheet',
      path: 'workspace/CHARACTERS/dog-01.png',
    },
  ])
})

test('resolveKeyframeGenerationPrompt returns the authored prompt unchanged', () => {
  expect(
    resolveKeyframeGenerationPrompt({
      prompt: 'Base prompt.',
    }),
  ).toBe('Base prompt.')
})

test('loadWorkflowSummary normalizes removed image models to the first supported option', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(
      repo.rootDir,
      'MODEL_OPTIONS.json',
      `${JSON.stringify(
        {
          agentModels: ['agent-test'],
          imageModels: ['image-reference-default', 'image-reference-alt'],
          videoModels: ['video-test'],
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(
      repo.rootDir,
      'workspace/CONFIG.json',
      `${JSON.stringify(
        {
          agentModel: 'agent-test',
          imageModel: 'google/imagen-4.0-fast-generate-001',
          videoModel: 'video-test',
          variantCount: 2,
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(repo.rootDir, 'workspace/STATUS.json', createWorkflowStatus([]))

    const runtime = createVideoAgentRuntime({ rootDir: repo.rootDir, creativePrompt: 'test' })
    const workflow = await runtime.loadWorkflowSummary()

    expect(workflow.config.imageModel).toBe('image-reference-default')
    expect(workflow.config.variantCount).toBe(2)
  } finally {
    await repo.cleanup()
  }
})

test('loadWorkflowSummary bootstraps CONFIG.json with variantCount set to 1', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(repo.rootDir, 'workspace/STATUS.json', createWorkflowStatus([]))

    const runtime = createVideoAgentRuntime({ rootDir: repo.rootDir, creativePrompt: 'test' })
    const workflow = await runtime.loadWorkflowSummary()

    expect(workflow.config.variantCount).toBe(1)

    const persistedConfig = JSON.parse(
      await readFile(path.resolve(repo.rootDir, 'workspace/CONFIG.json'), 'utf8'),
    ) as { variantCount?: number }
    expect(persistedConfig.variantCount).toBe(1)
  } finally {
    await repo.cleanup()
  }
})

test('loadWorkflowSummary normalizes invalid variantCount back to 1', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(
      repo.rootDir,
      'workspace/CONFIG.json',
      `${JSON.stringify(
        {
          agentModel: 'agent-test',
          imageModel: 'image-test',
          videoModel: 'video-test',
          variantCount: 0,
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(repo.rootDir, 'workspace/STATUS.json', createWorkflowStatus([]))

    const runtime = createVideoAgentRuntime({ rootDir: repo.rootDir, creativePrompt: 'test' })
    const workflow = await runtime.loadWorkflowSummary()

    expect(workflow.config.variantCount).toBe(1)

    const persistedConfig = JSON.parse(
      await readFile(path.resolve(repo.rootDir, 'workspace/CONFIG.json'), 'utf8'),
    ) as { variantCount?: number }
    expect(persistedConfig.variantCount).toBe(1)
  } finally {
    await repo.cleanup()
  }
})

test('runTurn emits callbacks in the expected order', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(repo.rootDir, 'workspace/CONFIG.json', createValidConfig())
    await writeRepoFile(
      repo.rootDir,
      'workspace/STATUS.json',
      createWorkflowStatus([
        {
          title: 'Clarify idea',
          instruction: 'Capture the project brief.',
          checked: true,
          relatedFiles: ['IDEA.md'],
        },
        {
          title: 'Draft story',
          instruction: 'Write the story.',
          checked: false,
          relatedFiles: ['STORY.md'],
        },
      ]),
    )
    await writeRepoFile(
      repo.rootDir,
      'workspace/IDEA.md',
      '# Idea\n\nA grounded concept with enough detail to count as ready.\n',
    )
    await writeRepoFile(repo.rootDir, 'templates/STORY.template.md', '# Story\n\nTBD\n')

    const events: string[] = []
    const workflowStates: string[] = []
    const runtime = createVideoAgentRuntime({
      rootDir: repo.rootDir,
      creativePrompt: 'test',
      onToolEvent: (message) => {
        events.push(`tool:${message}`)
      },
      onFileChange: (fileName) => {
        events.push(`file:${fileName}`)
      },
      onWorkflowChange: (workflow: WorkflowSummary) => {
        workflowStates.push(workflow.nextMilestone?.state ?? 'none')
        events.push(`workflow:${workflow.nextMilestone?.state ?? 'none'}`)
      },
      createAgent: () => ({
        stream: async ({
          messages,
          experimental_onToolCallStart,
          experimental_onToolCallFinish,
        }) => {
          expect(messages[0]?.role).toBe('system')
          expect(String(messages[0]?.content)).toContain(
            'Use the raw workspace/STATUS.json below as the exact workflow map for this turn.',
          )
          expect(String(messages[0]?.content)).toContain(
            'Current project idea / creative brief from workspace/IDEA.md:',
          )
          expect(String(messages[0]?.content)).toContain(
            'A grounded concept with enough detail to count as ready.',
          )
          expect(String(messages[0]?.content)).toContain(
            'Keyframe sidecars must always include explicit references.',
          )
          expect(String(messages[0]?.content)).toContain('"relatedFiles": [')
          expect(String(messages[0]?.content)).toContain('"IDEA.md"')
          expect(String(messages[0]?.content)).not.toContain('Primary source files:')

          experimental_onToolCallStart?.({ toolCall: { toolName: 'readWorkspaceFile' } })
          experimental_onToolCallFinish?.({
            toolCall: { toolName: 'readWorkspaceFile' },
            success: true,
          })

          return {
            textStream: (async function* () {
              yield 'Hello'
              yield ' world'
            })(),
            text: Promise.resolve('Hello world'),
          }
        },
      }),
    })

    const result = await runtime.runTurn({
      userInput: 'Draft the story.',
      transcript: [
        {
          id: 'assistant-1',
          role: 'assistant',
          text: 'What is the concept?',
        },
      ],
      onTextDelta: (delta) => {
        events.push(`delta:${delta}`)
      },
    })

    expect(result.text).toBe('Hello world')
    expect(result.bootstrappedFiles.map((file) => file.fileName)).toEqual(['STORY.md'])
    expect(workflowStates).toEqual(['missing', 'incomplete', 'incomplete'])
    expect(events).toEqual([
      'workflow:missing',
      'file:STORY.md',
      'workflow:incomplete',
      'tool:Running readWorkspaceFile',
      'tool:Completed readWorkspaceFile',
      'delta:Hello',
      'delta: world',
      'workflow:incomplete',
    ])
  } finally {
    await repo.cleanup()
  }
})

test('runTurn omits IDEA.md runtime context when IDEA.md is missing', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(repo.rootDir, 'workspace/CONFIG.json', createValidConfig())
    await writeRepoFile(
      repo.rootDir,
      'workspace/STATUS.json',
      createWorkflowStatus([
        {
          title: 'Draft story',
          instruction: 'Write the story.',
          checked: false,
          relatedFiles: ['STORY.md'],
        },
      ]),
    )
    await writeRepoFile(repo.rootDir, 'templates/STORY.template.md', '# Story\n\nTBD\n')

    const runtime = createVideoAgentRuntime({
      rootDir: repo.rootDir,
      creativePrompt: 'test',
      createAgent: () => ({
        stream: async ({ messages }) => {
          expect(messages[0]?.role).toBe('system')
          expect(String(messages[0]?.content)).not.toContain(
            'Current project idea / creative brief from workspace/IDEA.md:',
          )
          expect(String(messages[0]?.content)).not.toContain('Raw workspace/IDEA.md:')

          return {
            textStream: (async function* () {
              yield 'Hello world'
            })(),
            text: Promise.resolve('Hello world'),
          }
        },
      }),
    })

    const result = await runtime.runTurn({
      userInput: 'Draft the story.',
      transcript: [],
    })

    expect(result.text).toBe('Hello world')
  } finally {
    await repo.cleanup()
  }
})

function createMockTelemetry(traceId = 'trace-test') {
  const workflowEvents: Array<{ event: string; properties?: Record<string, unknown> }> = []
  const aiGenerations: AiGenerationEventInput[] = []

  return {
    telemetry: {
      isEnabled: true,
      distinctId: 'install-test',
      sessionId: 'session-test',
      createTraceId: () => traceId,
      captureWorkflowEvent: (event: string, properties?: WorkflowEventProperties) => {
        workflowEvents.push({ event, properties })
      },
      captureAiGeneration: (event: AiGenerationEventInput) => {
        aiGenerations.push(event)
      },
      shutdown: async () => {},
    } satisfies PostHogTelemetry,
    workflowEvents,
    aiGenerations,
  }
}

test('runTurn captures AI generation telemetry for a successful step', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(repo.rootDir, 'workspace/CONFIG.json', createValidConfig())
    await writeRepoFile(
      repo.rootDir,
      'workspace/STATUS.json',
      createWorkflowStatus([
        {
          title: 'Clarify idea',
          instruction: 'Capture the project brief.',
          checked: true,
          relatedFiles: ['IDEA.md'],
        },
      ]),
    )
    await writeRepoFile(repo.rootDir, 'workspace/IDEA.md', '# Idea\n\nTelemetry test idea.\n')

    const { telemetry, aiGenerations } = createMockTelemetry('trace-success')
    const runtime = createVideoAgentRuntime({
      rootDir: repo.rootDir,
      creativePrompt: 'test',
      telemetry,
      createAgent: () => ({
        stream: async ({ messages, experimental_onStepStart, onStepFinish }) => {
          experimental_onStepStart?.({
            stepNumber: 0,
            model: { provider: 'gateway', modelId: 'openai/gpt-5.4' },
            messages,
          })

          onStepFinish?.({
            stepNumber: 0,
            model: { provider: 'gateway', modelId: 'openai/gpt-5.4' },
            text: 'Telemetry success',
            toolCalls: [{ toolName: 'readWorkspaceFile' }],
            toolResults: [{ ok: true }],
            finishReason: 'stop',
            rawFinishReason: 'stop',
            usage: {
              inputTokens: 11,
              outputTokens: 7,
              totalTokens: 18,
              reasoningTokens: 2,
              cachedInputTokens: 3,
              inputTokenDetails: {
                cacheWriteTokens: 1,
              },
            },
            request: {
              body: {
                temperature: 0.2,
              },
            },
            response: {
              id: 'resp-success',
              body: {
                ok: true,
              },
              messages: [{ role: 'assistant', content: 'Telemetry success' }],
            },
            providerMetadata: { route: 'primary' },
            metadata: { traceId: 'trace-success' },
          })

          return {
            textStream: (async function* () {
              yield 'Telemetry success'
            })(),
            text: Promise.resolve('Telemetry success'),
          }
        },
      }),
    })

    const result = await runtime.runTurn({
      userInput: 'Tell me something useful.',
      transcript: [],
      traceId: 'trace-success',
    })

    expect(result.text).toBe('Telemetry success')
    expect(aiGenerations).toHaveLength(1)
    expect(aiGenerations[0]).toMatchObject({
      traceId: 'trace-success',
      spanId: 'resp-success',
      spanName: 'video_agent_step_1',
      provider: 'gateway',
      model: 'openai/gpt-5.4',
      finishReason: 'stop',
      rawFinishReason: 'stop',
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        reasoningTokens: 2,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 1,
      },
    })
  } finally {
    await repo.cleanup()
  }
})

test('runTurn captures failed AI telemetry for an unfinished step', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(repo.rootDir, 'workspace/CONFIG.json', createValidConfig())
    await writeRepoFile(repo.rootDir, 'workspace/STATUS.json', createWorkflowStatus([]))

    const { telemetry, aiGenerations } = createMockTelemetry('trace-failure')
    const runtime = createVideoAgentRuntime({
      rootDir: repo.rootDir,
      creativePrompt: 'test',
      telemetry,
      createAgent: () => ({
        stream: async ({ messages, experimental_onStepStart }) => {
          experimental_onStepStart?.({
            stepNumber: 0,
            model: { provider: 'gateway', modelId: 'openai/gpt-5.4' },
            messages,
          })

          throw new Error('LLM exploded')
        },
      }),
    })

    await expect(
      runtime.runTurn({
        userInput: 'Break please.',
        transcript: [],
        traceId: 'trace-failure',
      }),
    ).rejects.toThrow('LLM exploded')

    expect(aiGenerations).toHaveLength(1)
    expect(aiGenerations[0]).toMatchObject({
      traceId: 'trace-failure',
      spanName: 'video_agent_step_1',
      provider: 'gateway',
      model: 'openai/gpt-5.4',
      statusCode: 500,
      error: {
        name: 'Error',
        message: 'LLM exploded',
      },
    })
  } finally {
    await repo.cleanup()
  }
})

test('runTurn emits one AI generation event per completed step', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(repo.rootDir, 'workspace/CONFIG.json', createValidConfig())
    await writeRepoFile(repo.rootDir, 'workspace/STATUS.json', createWorkflowStatus([]))

    const { telemetry, aiGenerations } = createMockTelemetry('trace-multi')
    const runtime = createVideoAgentRuntime({
      rootDir: repo.rootDir,
      creativePrompt: 'test',
      telemetry,
      createAgent: () => ({
        stream: async ({ messages, experimental_onStepStart, onStepFinish }) => {
          experimental_onStepStart?.({
            stepNumber: 0,
            model: { provider: 'gateway', modelId: 'openai/gpt-5.4' },
            messages,
          })
          onStepFinish?.({
            stepNumber: 0,
            model: { provider: 'gateway', modelId: 'openai/gpt-5.4' },
            text: '',
            toolCalls: [{ toolName: 'readWorkspaceFile' }],
            toolResults: [{ fileName: 'IDEA.md' }],
            finishReason: 'tool-calls',
            rawFinishReason: 'tool-calls',
            usage: {},
            request: { body: { step: 1 } },
            response: {
              id: 'resp-step-1',
              messages: [{ role: 'assistant', content: '', tool_calls: ['readWorkspaceFile'] }],
            },
          })

          experimental_onStepStart?.({
            stepNumber: 1,
            model: { provider: 'gateway', modelId: 'openai/gpt-5.4' },
            messages,
          })
          onStepFinish?.({
            stepNumber: 1,
            model: { provider: 'gateway', modelId: 'openai/gpt-5.4' },
            text: 'Final answer',
            toolCalls: [],
            toolResults: [],
            finishReason: 'stop',
            rawFinishReason: 'stop',
            usage: {
              inputTokens: 4,
              outputTokens: 5,
              totalTokens: 9,
            },
            request: { body: { step: 2 } },
            response: {
              id: 'resp-step-2',
              messages: [{ role: 'assistant', content: 'Final answer' }],
            },
          })

          return {
            textStream: (async function* () {
              yield 'Final answer'
            })(),
            text: Promise.resolve('Final answer'),
          }
        },
      }),
    })

    await runtime.runTurn({
      userInput: 'Two steps please.',
      transcript: [],
      traceId: 'trace-multi',
    })

    expect(aiGenerations).toHaveLength(2)
    expect(aiGenerations[0]).toMatchObject({
      traceId: 'trace-multi',
      spanId: 'resp-step-1',
      finishReason: 'tool-calls',
      toolCalls: ['readWorkspaceFile'],
    })
    expect(aiGenerations[1]).toMatchObject({
      traceId: 'trace-multi',
      spanId: 'resp-step-2',
      finishReason: 'stop',
      usage: {
        inputTokens: 4,
        outputTokens: 5,
        totalTokens: 9,
      },
    })
  } finally {
    await repo.cleanup()
  }
})

test('runTurn emits hidden next-step suggestions without visible tool noise', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(repo.rootDir, 'workspace/CONFIG.json', createValidConfig())
    await writeRepoFile(repo.rootDir, 'workspace/STATUS.json', createWorkflowStatus([]))

    const events: string[] = []
    const emittedSuggestions: Array<
      Array<{
        label: string
        prompt: string
      }>
    > = []

    const runtime = createVideoAgentRuntime({
      rootDir: repo.rootDir,
      creativePrompt: 'test',
      onToolEvent: (message) => {
        events.push(message)
      },
      onNextStepSuggestions: (suggestions) => {
        emittedSuggestions.push(suggestions)
      },
      createAgent: () => ({
        stream: async ({
          experimental_onToolCallStart,
          experimental_onToolCallFinish,
          messages,
        }) => {
          expect(String(messages[0]?.content)).toContain('publishNextStepSuggestions exactly once')

          experimental_onToolCallStart?.({
            toolCall: {
              toolName: 'publishNextStepSuggestions',
            },
          })
          experimental_onToolCallFinish?.({
            toolCall: {
              toolName: 'publishNextStepSuggestions',
            },
            success: true,
            output: [
              { label: 'Draft story', prompt: 'Draft STORY.md from the current idea.' },
              { label: 'Three options', prompt: 'Give me 3 story directions.' },
              { label: 'Review gaps', prompt: 'Review STORY.md and tell me what is weak.' },
            ],
          })
          experimental_onToolCallStart?.({
            toolCall: {
              toolName: 'readWorkspaceFile',
            },
          })
          experimental_onToolCallFinish?.({
            toolCall: {
              toolName: 'readWorkspaceFile',
            },
            success: true,
            output: { fileName: 'IDEA.md' },
          })

          return {
            textStream: (async function* () {
              yield 'Done.'
            })(),
            text: Promise.resolve('Done.'),
          }
        },
      }),
    })

    const result = await runtime.runTurn({
      userInput: 'Take the next step.',
      transcript: [],
    })

    expect(result.text).toBe('Done.')
    expect(events).toEqual(['Running readWorkspaceFile', 'Completed readWorkspaceFile'])
    expect(emittedSuggestions).toEqual([
      [
        { label: 'Draft story', prompt: 'Draft STORY.md from the current idea.' },
        { label: 'Three options', prompt: 'Give me 3 story directions.' },
        { label: 'Review gaps', prompt: 'Review STORY.md and tell me what is weak.' },
      ],
    ])
  } finally {
    await repo.cleanup()
  }
})

test('runTurn ignores invalid hidden next-step suggestion payloads', async () => {
  const repo = await createTestRepo()

  try {
    await writeRepoFile(repo.rootDir, 'workspace/CONFIG.json', createValidConfig())
    await writeRepoFile(repo.rootDir, 'workspace/STATUS.json', createWorkflowStatus([]))

    const emittedSuggestions: Array<unknown> = []

    const runtime = createVideoAgentRuntime({
      rootDir: repo.rootDir,
      creativePrompt: 'test',
      onNextStepSuggestions: (suggestions) => {
        emittedSuggestions.push(suggestions)
      },
      createAgent: () => ({
        stream: async ({ experimental_onToolCallFinish }) => {
          experimental_onToolCallFinish?.({
            toolCall: {
              toolName: 'publishNextStepSuggestions',
            },
            success: true,
            output: [
              { label: 'Only one', prompt: 'One suggestion is not enough.' },
              { label: 'Second', prompt: 'Still invalid because there are only two.' },
            ],
          })

          return {
            textStream: (async function* () {
              yield 'Done.'
            })(),
            text: Promise.resolve('Done.'),
          }
        },
      }),
    })

    await runtime.runTurn({
      userInput: 'Take the next step.',
      transcript: [],
    })

    expect(emittedSuggestions).toEqual([])
  } finally {
    await repo.cleanup()
  }
})
