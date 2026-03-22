import { expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createVideoAgentRuntime, type WorkflowSummary } from './video-agent-core'

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
    },
    null,
    2,
  )}\n`
}

function createWorkflowStatus(items: Array<Record<string, unknown>>) {
  return `${JSON.stringify(items, null, 2)}\n`
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
