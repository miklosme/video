import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getStoryboardArtifactDescriptor } from './artifact-control'
import {
  buildStoryboardPrompt,
  resolveStoryboardGenerationPrompt,
  runStoryboardGeneration,
  runStoryboardRegeneration,
  selectPendingStoryboardGenerations,
  syncStoryboardGeneration,
  type PendingStoryboardGeneration,
} from './generate-storyboard'
import { type StoryboardSidecar } from './workflow-data'

async function writeRepoFile(rootDir: string, relativePath: string, content: string) {
  const filePath = path.resolve(rootDir, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')
}

function createStoryboard(): StoryboardSidecar {
  return {
    images: [
      {
        frameType: 'start',
        goal: 'Establish the dog noticing something off in the window reflection.',
        imagePath: 'workspace/STORYBOARD/storyboard-image-alpha.png',
        references: [
          {
            kind: 'user-reference',
            path: 'workspace/references/window.png',
          },
        ],
      },
      {
        frameType: 'end',
        goal: 'Land the transformed dog staring directly at us.',
        imagePath: 'workspace/STORYBOARD/storyboard-image-beta.png',
        references: [],
      },
    ],
  }
}

test('buildStoryboardPrompt targets a single storyboard image rather than a board sheet', () => {
  const storyboard = createStoryboard()
  const prompt = buildStoryboardPrompt(storyboard, 'SHOT-01-START')

  expect(prompt).toContain('Create a single 16:9 storyboard thumbnail image')
  expect(prompt).toContain('No multi-panel sheet, page layout')
  expect(prompt).toContain('Shot: SHOT-01')
  expect(prompt).toContain('Frame: start')
  expect(prompt).toContain(
    'Goal: Establish the dog noticing something off in the window reflection.',
  )
  expect(prompt).not.toContain('storyboard template image')
})

test('selectPendingStoryboardGenerations preserves per-image references', () => {
  const generations = selectPendingStoryboardGenerations(createStoryboard(), 'image-test', {
    storyboardImageId: 'SHOT-01-START',
  })

  expect(generations).toHaveLength(1)
  expect(generations[0]?.userReferences).toEqual([
    {
      kind: 'user-reference',
      path: 'workspace/references/window.png',
    },
  ])
})

test('selectPendingStoryboardGenerations uses cached storyboard prompts when present', () => {
  const storyboard = createStoryboard()
  storyboard.images[0] = {
    ...storyboard.images[0]!,
    prompt: 'Cached storyboard prompt.',
  }

  const generations = selectPendingStoryboardGenerations(storyboard, 'image-test', {
    storyboardImageId: 'SHOT-01-START',
  })

  expect(generations).toHaveLength(1)
  expect(generations[0]?.prompt).toBe('Cached storyboard prompt.')
})

test('resolveStoryboardGenerationPrompt returns cached final prompts unchanged for rewrite models', async () => {
  const prompt = await resolveStoryboardGenerationPrompt(
    {
      imageIndex: 0,
      storyboardImageId: 'SHOT-01-START',
      shotId: 'SHOT-01',
      frameType: 'start',
      goal: 'Establish the dog noticing something off in the window reflection.',
      artifactId: 'storyboard-image-alpha',
      model: 'bfl/flux-2-klein-4b',
      rewriteModel: 'openai/gpt-5.4-mini',
      prompt: 'Cached final storyboard prompt.',
      promptIsFinal: true,
      outputPath: 'workspace/STORYBOARD/storyboard-image-alpha.png',
    },
    [],
    {
      promptRewriter: async () => 'This should not be used.',
    },
  )

  expect(prompt).toBe('Cached final storyboard prompt.')
})

test('runStoryboardRegeneration keeps the selected storyboard image and retained references', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-storyboard-regenerate-'))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD/HISTORY/storyboard-image-alpha/v2.png',
      'selected-storyboard',
    )
    await writeRepoFile(rootDir, 'workspace/references/window.png', 'reference-image')

    const generation: PendingStoryboardGeneration = {
      imageIndex: 0,
      storyboardImageId: 'SHOT-01-START',
      shotId: 'SHOT-01',
      frameType: 'start',
      goal: 'Establish the dog noticing something off in the window reflection.',
      artifactId: 'storyboard-image-alpha',
      model: 'image-test',
      prompt: 'Prompt',
      outputPath: 'workspace/STORYBOARD/storyboard-image-alpha.png',
      userReferences: [
        {
          kind: 'user-reference',
          path: 'workspace/references/window.png',
        },
      ],
    }

    let seenSize: string | undefined
    const result = await runStoryboardRegeneration(generation, {
      outputPath: 'workspace/STORYBOARD/HISTORY/storyboard-image-alpha/.staged-v3.png',
      regenerateRequest: 'Remove the extra background character.',
      selectedVersionPath: 'workspace/STORYBOARD/HISTORY/storyboard-image-alpha/v2.png',
      cwd: rootDir,
      generator: async (input) => {
        seenSize = input.size

        return {
          generationId: 'gen-1',
          model: input.model ?? 'image-test',
          outputPaths: [path.resolve(rootDir, input.outputPath ?? 'out.png')],
        }
      },
    })

    expect(result.prompt).toContain('Regenerate the current storyboard image for SHOT-01-START')
    expect(result.prompt).toContain(
      'Goal: Establish the dog noticing something off in the window reflection.',
    )
    expect(result.prompt).toContain('Direction:')
    expect(result.prompt).toContain('Remove the extra background character.')
    expect(seenSize).toBe('896x512')
    expect(result.references).toEqual([
      {
        kind: 'selected-image',
        path: 'workspace/STORYBOARD/HISTORY/storyboard-image-alpha/v2.png',
      },
      { kind: 'user-reference', path: 'workspace/references/window.png' },
    ])
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('runStoryboardGeneration rewrites flux klein storyboard prompts before image generation', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-storyboard-flux-rewrite-'))

  try {
    await writeRepoFile(rootDir, 'workspace/IDEA.md', '# IDEA\nComic market panic.\n')
    await writeRepoFile(rootDir, 'workspace/STORY.md', '# STORY\nThe merchant loses the bag.\n')
    await writeRepoFile(rootDir, 'workspace/references/window.png', 'reference-image')

    let seenPrompt = ''
    let promptText = ''
    const logFile = 'workspace/test-log.jsonl'
    const result = await runStoryboardGeneration(
      {
        imageIndex: 0,
        storyboardImageId: 'SHOT-01-START',
        shotId: 'SHOT-01',
        frameType: 'start',
        goal: 'Establish the merchant realizing the bag is gone.',
        previousFrameSummary: null,
        nextFrameSummary: 'SHOT-01-END (end) — The merchant lunges into the crowd.',
        artifactId: 'storyboard-image-alpha',
        model: 'bfl/flux-2-klein-4b',
        rewriteModel: 'openai/gpt-5.4-mini',
        prompt: 'Base storyboard prompt.',
        outputPath: 'workspace/STORYBOARD/storyboard-image-alpha.png',
        userReferences: [
          {
            kind: 'user-reference',
            path: 'workspace/references/window.png',
          },
        ],
      },
      {
        cwd: rootDir,
        logFile,
        promptRewriter: async () =>
          'A frantic merchant freezes beside a market stall, clutching an empty satchel as the crowd swirls behind him. Style: rough graphite storyboard sketch.',
        generator: async (input) => {
          seenPrompt = input.prompt
          promptText =
            input.promptTextBuilder?.({
              prompt: input.prompt,
              references: input.references ?? [],
              aspectRatio: input.aspectRatio ?? '16:9',
              model: input.model ?? 'bfl/flux-2-klein-4b',
              shotId: input.shotId,
              size: input.size,
            }) ?? ''

          return {
            generationId: 'gen-1',
            model: input.model ?? 'bfl/flux-2-klein-4b',
            outputPaths: [path.resolve(rootDir, input.outputPath ?? 'out.png')],
          }
        },
      },
    )

    expect(seenPrompt).toContain('A frantic merchant freezes beside a market stall')
    expect(promptText).toBe(seenPrompt)
    expect(result.prompt).toBe(seenPrompt)
    const logEntries = (await readFile(path.resolve(rootDir, logFile), 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            operation?: string
            model: string
            outputText?: string | null
            settings: { targetModel?: string }
          },
      )

    expect(logEntries).toHaveLength(1)
    expect(logEntries[0]).toMatchObject({
      operation: 'storyboard-prompt-rewrite',
      model: 'openai/gpt-5.4-mini',
      outputText:
        'A frantic merchant freezes beside a market stall, clutching an empty satchel as the crowd swirls behind him. Style: rough graphite storyboard sketch.',
      settings: {
        targetModel: 'bfl/flux-2-klein-4b',
      },
    })
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('syncStoryboardGeneration upgrades legacy planning prompts to final cached model prompts', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-storyboard-prompt-cache-'))
  const storyboard = {
    images: [createStoryboard().images[0]!],
  } satisfies StoryboardSidecar
  const legacyPrompt = buildStoryboardPrompt(storyboard, 'SHOT-01-START')

  try {
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD.json',
      `${JSON.stringify(
        {
          images: [
            {
              ...storyboard.images[0],
              prompt: legacyPrompt,
            },
          ],
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(rootDir, 'workspace/IDEA.md', '# IDEA\nComic market panic.\n')
    await writeRepoFile(rootDir, 'workspace/STORY.md', '# STORY\nThe merchant loses the bag.\n')
    await writeRepoFile(rootDir, 'workspace/references/window.png', 'reference-image')

    let seenPrompt = ''
    await syncStoryboardGeneration({
      storyboard: {
        images: [
          {
            ...storyboard.images[0]!,
            prompt: legacyPrompt,
          },
        ],
      },
      model: 'bfl/flux-2-klein-4b',
      rewriteModel: 'openai/gpt-5.4-mini',
      cwd: rootDir,
      promptRewriter: async () => 'Final cached FLUX prompt.',
      generator: async (input) => {
        seenPrompt = input.prompt

        if (!input.outputPath) {
          throw new Error('Expected outputPath for storyboard generation test.')
        }

        await writeRepoFile(rootDir, input.outputPath, 'storyboard-image')

        return {
          generationId: 'gen-1',
          model: input.model ?? 'bfl/flux-2-klein-4b',
          outputPaths: [path.resolve(rootDir, input.outputPath)],
        }
      },
    })

    const savedStoryboard = JSON.parse(
      await readFile(path.resolve(rootDir, 'workspace/STORYBOARD.json'), 'utf8'),
    ) as StoryboardSidecar

    expect(seenPrompt).toBe('Final cached FLUX prompt.')
    expect(savedStoryboard.images[0]?.prompt).toBe('Final cached FLUX prompt.')
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('generate-storyboard skips when the selected storyboard image already exists', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-storyboard-gen-'))
  const scriptPath = fileURLToPath(new URL('./generate-storyboard.ts', import.meta.url))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/CONFIG.json',
      `${JSON.stringify(
        {
          agentModel: 'agent-test',
          imageModel: 'image-test',
          fastImageModel: 'image-fast-test',
          videoModel: 'video-test',
          variantCount: 1,
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD.json',
      `${JSON.stringify(createStoryboard(), null, 2)}\n`,
    )
    await writeRepoFile(rootDir, 'workspace/STORYBOARD/storyboard-image-alpha.png', 'existing-png')

    const result = Bun.spawnSync({
      cmd: [process.execPath, scriptPath, '--storyboard-image-id', 'SHOT-01-START'],
      cwd: rootDir,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stdout)).toContain(
      'Skipping SHOT-01-START; image already exists at workspace/STORYBOARD/storyboard-image-alpha.png',
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('generate-storyboard explains when the storyboard sidecar is missing', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-storyboard-missing-sidecar-'))
  const scriptPath = fileURLToPath(new URL('./generate-storyboard.ts', import.meta.url))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/CONFIG.json',
      `${JSON.stringify(
        {
          agentModel: 'agent-test',
          imageModel: 'image-test',
          fastImageModel: 'image-fast-test',
          videoModel: 'video-test',
          variantCount: 1,
        },
        null,
        2,
      )}\n`,
    )

    const result = Bun.spawnSync({
      cmd: [process.execPath, scriptPath],
      cwd: rootDir,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toContain(
      'workspace/STORYBOARD.json is required before running bun run generate:storyboard.',
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('syncStoryboardGeneration renders variantCount retained versions and selects the last one', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-storyboard-variants-'))
  const storyboard = createStoryboard()
  const descriptor = getStoryboardArtifactDescriptor({
    imagePath: storyboard.images[0]!.imagePath!,
    shotId: 'SHOT-01',
    storyboardImageId: 'SHOT-01-START',
  })

  try {
    await writeRepoFile(rootDir, 'workspace/references/window.png', 'window-reference')

    const sizes: Array<string | undefined> = []
    const seeds: number[] = []
    const summary = await syncStoryboardGeneration({
      storyboard: {
        ...storyboard,
        images: [storyboard.images[0]!],
      },
      model: 'image-test',
      variantCount: 3,
      cwd: rootDir,
      generator: async (input) => {
        sizes.push(input.size)
        seeds.push(input.seed ?? -1)

        if (!input.outputPath) {
          throw new Error('Expected outputPath for storyboard generation test.')
        }

        await writeRepoFile(rootDir, input.outputPath, `storyboard:${input.seed}`)

        return {
          generationId: `gen-${input.seed}`,
          model: input.model ?? 'image-test',
          outputPaths: [path.resolve(rootDir, input.outputPath)],
        }
      },
    })

    expect(summary).toEqual({ generatedCount: 1, skippedCount: 0 })
    expect(sizes).toEqual(['896x512', '896x512', '896x512'])
    expect(seeds).toEqual([1, 2, 3])
    expect(
      await readFile(
        path.resolve(rootDir, 'workspace/STORYBOARD/storyboard-image-alpha.png'),
        'utf8',
      ),
    ).toBe('storyboard:3')
    expect(await readFile(path.resolve(rootDir, descriptor.historyDir, 'v1.png'), 'utf8')).toBe(
      'storyboard:1',
    )
    expect(await readFile(path.resolve(rootDir, descriptor.historyDir, 'v2.png'), 'utf8')).toBe(
      'storyboard:2',
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
