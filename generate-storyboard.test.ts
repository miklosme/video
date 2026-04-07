import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getStoryboardArtifactDescriptor } from './artifact-control'
import {
  buildStoryboardPrompt,
  resolveStoryboardGenerationPrompt,
  runStoryboardDirectionRegeneration,
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
        prompt:
          'A medium shot of a tense dog noticing something off in the window reflection. Style: rough graphite storyboard sketch.',
        camera: {
          shotSize: 'medium-shot',
          cameraPosition: 'eye-level',
          cameraAngle: 'level-angle',
        },
        imagePath: 'workspace/STORYBOARD/storyboard-image-alpha.png',
      },
      {
        frameType: 'end',
        prompt:
          'A close-up of the transformed dog staring directly at us. Style: rough graphite storyboard sketch.',
        camera: {
          shotSize: 'close-up',
          cameraPosition: 'eye-level',
          cameraAngle: 'level-angle',
        },
        imagePath: 'workspace/STORYBOARD/storyboard-image-beta.png',
      },
    ],
  }
}

test('buildStoryboardPrompt returns the authored prompt plus deterministic camera guidance', () => {
  const storyboard = createStoryboard()
  const prompt = buildStoryboardPrompt(storyboard, 'SHOT-01-START')

  expect(prompt).toContain(
    'A medium shot of a tense dog noticing something off in the window reflection. Style: rough graphite storyboard sketch.',
  )
  expect(prompt).toContain('Use this camera plan for this frame:')
  expect(prompt).toContain('Shot Size: Medium Shot')
})

test('selectPendingStoryboardGenerations returns storyboard entries without authored references', () => {
  const generations = selectPendingStoryboardGenerations(createStoryboard(), 'image-test', {
    storyboardImageId: 'SHOT-01-START',
  })

  expect(generations).toHaveLength(1)
  expect(generations[0]).not.toHaveProperty('userReferences')
})

test('resolveStoryboardGenerationPrompt returns the authored prompt by default', async () => {
  const prompt = await resolveStoryboardGenerationPrompt({
    imageIndex: 0,
    storyboardImageId: 'SHOT-01-START',
    shotId: 'SHOT-01',
    frameType: 'start',
    artifactId: 'storyboard-image-alpha',
    model: 'bfl/flux-2-klein-9b',
    prompt:
      'A medium shot of a tense dog noticing something off in the window reflection. Style: rough graphite storyboard sketch.',
    outputPath: 'workspace/STORYBOARD/storyboard-image-alpha.png',
  })

  expect(prompt).toBe(
    'A medium shot of a tense dog noticing something off in the window reflection. Style: rough graphite storyboard sketch.',
  )
})

test('runStoryboardRegeneration keeps the selected storyboard image as the edit baseline', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-storyboard-regenerate-'))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD/HISTORY/storyboard-image-alpha/v2.png',
      'selected-storyboard',
    )

    const generation: PendingStoryboardGeneration = {
      imageIndex: 0,
      storyboardImageId: 'SHOT-01-START',
      shotId: 'SHOT-01',
      frameType: 'start',
      artifactId: 'storyboard-image-alpha',
      model: 'image-test',
      prompt:
        'A medium shot of a tense dog noticing something off in the window reflection. Style: rough graphite storyboard sketch.',
      outputPath: 'workspace/STORYBOARD/storyboard-image-alpha.png',
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

    expect(result.prompt).toContain(
      'A medium shot of a tense dog noticing something off in the window reflection.',
    )
    expect(result.prompt).toContain(
      'Use the attached current storyboard thumbnail as the direct visual baseline.',
    )
    expect(result.prompt).toContain('Requested change: Remove the extra background character.')
    expect(seenSize).toBe('896x512')
    expect(result.references).toEqual([
      {
        kind: 'selected-image',
        path: 'workspace/STORYBOARD/HISTORY/storyboard-image-alpha/v2.png',
      },
    ])
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('runStoryboardDirectionRegeneration keeps the base prompt and applies the direction request', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-storyboard-direction-'))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD/HISTORY/storyboard-image-alpha/v2.png',
      'selected-storyboard',
    )

    const generation: PendingStoryboardGeneration = {
      imageIndex: 0,
      storyboardImageId: 'SHOT-01-START',
      shotId: 'SHOT-01',
      frameType: 'start',
      artifactId: 'storyboard-image-alpha',
      model: 'image-test',
      prompt:
        'A medium shot of a tense dog noticing something off in the window reflection. Style: rough graphite storyboard sketch.',
      outputPath: 'workspace/STORYBOARD/storyboard-image-alpha.png',
    }

    let promptText = ''
    const result = await runStoryboardDirectionRegeneration(generation, {
      outputPath: 'workspace/STORYBOARD/HISTORY/storyboard-image-alpha/.staged-v3.png',
      regenerateRequest: 'Make them face the door.',
      selectedVersionPath: 'workspace/STORYBOARD/HISTORY/storyboard-image-alpha/v2.png',
      cwd: rootDir,
      generator: async (input) => {
        promptText =
          input.promptTextBuilder?.({
            prompt: input.prompt,
            references: input.references ?? [],
            aspectRatio: input.aspectRatio ?? '16:9',
            model: input.model ?? 'image-test',
            shotId: input.shotId,
            size: input.size,
          }) ?? ''

        return {
          generationId: 'gen-1',
          model: input.model ?? 'image-test',
          outputPaths: [path.resolve(rootDir, input.outputPath ?? 'out.png')],
        }
      },
    })

    expect(result.prompt).toContain(
      'A medium shot of a tense dog noticing something off in the window reflection.',
    )
    expect(result.prompt).toContain('Apply only the requested change')
    expect(result.prompt).toContain('Requested change: Make them face the door.')
    expect(promptText).toContain('Reference 1 is the currently selected storyboard thumbnail.')
    expect(result.references).toEqual([
      {
        kind: 'selected-image',
        path: 'workspace/STORYBOARD/HISTORY/storyboard-image-alpha/v2.png',
      },
    ])
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('runStoryboardGeneration uses the authored prompt directly for flux klein generation', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-storyboard-direct-prompt-'))

  try {
    let seenPrompt = ''
    let promptText = ''
    const result = await runStoryboardGeneration(
      {
        imageIndex: 0,
        storyboardImageId: 'SHOT-01-START',
        shotId: 'SHOT-01',
        frameType: 'start',
        artifactId: 'storyboard-image-alpha',
        model: 'bfl/flux-2-klein-9b',
        prompt:
          'A frantic merchant freezes beside a market stall, clutching an empty satchel as the crowd swirls behind him. Style: rough graphite storyboard sketch.',
        outputPath: 'workspace/STORYBOARD/storyboard-image-alpha.png',
      },
      {
        cwd: rootDir,
        generator: async (input) => {
          seenPrompt = input.prompt
          promptText =
            input.promptTextBuilder?.({
              prompt: input.prompt,
              references: input.references ?? [],
              aspectRatio: input.aspectRatio ?? '16:9',
              model: input.model ?? 'bfl/flux-2-klein-9b',
              shotId: input.shotId,
              size: input.size,
            }) ?? ''

          return {
            generationId: 'gen-1',
            model: input.model ?? 'bfl/flux-2-klein-9b',
            outputPaths: [path.resolve(rootDir, input.outputPath ?? 'out.png')],
          }
        },
      },
    )

    expect(seenPrompt).toBe(
      'A frantic merchant freezes beside a market stall, clutching an empty satchel as the crowd swirls behind him. Style: rough graphite storyboard sketch.',
    )
    expect(promptText).toBe(seenPrompt)
    expect(result.prompt).toBe(seenPrompt)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('syncStoryboardGeneration keeps storyboard prompts persisted as authored', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-storyboard-prompt-persist-'))
  const storyboard = {
    images: [createStoryboard().images[0]!],
  } satisfies StoryboardSidecar

  try {
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD/STORYBOARD.json',
      `${JSON.stringify(storyboard, null, 2)}\n`,
    )

    let seenPrompt = ''
    await syncStoryboardGeneration({
      storyboard,
      model: 'bfl/flux-2-klein-9b',
      cwd: rootDir,
      generator: async (input) => {
        seenPrompt = input.prompt

        if (!input.outputPath) {
          throw new Error('Expected outputPath for storyboard generation test.')
        }

        await writeRepoFile(rootDir, input.outputPath, 'storyboard-image')

        return {
          generationId: 'gen-1',
          model: input.model ?? 'bfl/flux-2-klein-9b',
          outputPaths: [path.resolve(rootDir, input.outputPath)],
        }
      },
    })

    const savedStoryboard = JSON.parse(
      await readFile(path.resolve(rootDir, 'workspace/STORYBOARD/STORYBOARD.json'), 'utf8'),
    ) as StoryboardSidecar

    expect(seenPrompt).toContain(storyboard.images[0]?.prompt ?? '')
    expect(seenPrompt).toContain('Use this camera plan for this frame:')
    expect(savedStoryboard.images[0]?.prompt).toBe(storyboard.images[0]?.prompt)
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
      'workspace/STORYBOARD/STORYBOARD.json',
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
      'workspace/STORYBOARD/STORYBOARD.json is required before running bun run generate:storyboard.',
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
    expect(
      await readFile(
        path.resolve(rootDir, 'workspace/STORYBOARD/HISTORY/storyboard-image-alpha/v1.png'),
        'utf8',
      ),
    ).toBe('storyboard:1')
    expect(
      await readFile(
        path.resolve(rootDir, 'workspace/STORYBOARD/HISTORY/storyboard-image-alpha/v2.png'),
        'utf8',
      ),
    ).toBe('storyboard:2')
    expect(descriptor.artifactId).toBe('storyboard-image-alpha')
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
