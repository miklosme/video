import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getStoryboardArtifactDescriptor } from './artifact-control'
import {
  buildStoryboardPrompt,
  runStoryboardRegeneration,
  selectPendingStoryboardGeneration,
  syncStoryboardGeneration,
} from './generate-storyboard'

async function writeRepoFile(rootDir: string, relativePath: string, content: string) {
  const filePath = path.resolve(rootDir, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')
}

test('buildStoryboardPrompt keeps storyboard generation visual-first while preserving shot labels', () => {
  const markdown = `# STORYBOARD

## SHOT-01

- Purpose: Establish the dog.

## SHOT-02

- Purpose: Reveal the transformation.
`

  const prompt = buildStoryboardPrompt(markdown)

  expect(prompt).toContain('single storyboard sheet')
  expect(prompt).toContain('attached storyboard template image')
  expect(prompt).toContain('visible shot labels that exactly match the SHOT-XX IDs')
  expect(prompt).toContain('multiple storyboard panels')
  expect(prompt).toContain('minimal per-panel text')
  expect(prompt).toContain(
    'Do not include long descriptions, purpose text, transition text, duration text, or dense header blocks on the board.',
  )
  expect(prompt).not.toContain('template-style text labels and descriptive headers')
  expect(prompt).toContain(markdown.trim())
})

test('selectPendingStoryboardGeneration preserves explicit storyboard sidecar references', () => {
  const generation = selectPendingStoryboardGeneration(
    '# STORYBOARD\n\n## SHOT-01\n\n- Purpose: Establish the dog.\n',
    'google/gemini-3.1-flash-image-preview',
    [
      {
        kind: 'storyboard-template',
        path: 'templates/STORYBOARD.template.png',
      },
    ],
  )

  expect(generation.references).toEqual([
    { kind: 'storyboard-template', path: 'templates/STORYBOARD.template.png' },
  ])
})

test('runStoryboardRegeneration uses only the selected storyboard image and the approved request', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-storyboard-regenerate-'))

  try {
    await writeRepoFile(rootDir, 'workspace/HISTORY/STORYBOARD/v2.png', 'selected-storyboard')

    const result = await runStoryboardRegeneration({
      model: 'image-test',
      outputPath: 'workspace/HISTORY/STORYBOARD/.staged-v3.png',
      regenerateRequest: 'Remove the extra character from the last panel.',
      selectedVersionPath: 'workspace/HISTORY/STORYBOARD/v2.png',
      cwd: rootDir,
      generator: async (input) => ({
        generationId: 'gen-1',
        model: input.model ?? 'image-test',
        outputPaths: [path.resolve(rootDir, input.outputPath ?? 'out.png')],
      }),
    })

    expect(result.prompt).toContain('Regenerate the current storyboard board')
    expect(result.prompt).toContain('Approved change:')
    expect(result.prompt).toContain('Remove the extra character from the last panel.')
    expect(result.prompt).not.toContain('Storyboard markdown:')
    expect(result.prompt).not.toContain('storyboard template image')
    expect(result.references).toEqual([
      { kind: 'selected-image', path: 'workspace/HISTORY/STORYBOARD/v2.png' },
    ])
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('generate-storyboard skips when the canonical storyboard image already exists', async () => {
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
          videoModel: 'video-test',
          variantCount: 1,
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD.md',
      '# STORYBOARD\n\n## SHOT-01\n\n- Purpose: Establish the dog.\n',
    )
    await writeRepoFile(
      rootDir,
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
    await writeRepoFile(rootDir, 'templates/STORYBOARD.template.png', 'template')
    await writeRepoFile(rootDir, 'workspace/STORYBOARD.png', 'existing-png')

    const result = Bun.spawnSync({
      cmd: [process.execPath, scriptPath],
      cwd: rootDir,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stdout)).toContain(
      'Skipping storyboard; image already exists at workspace/STORYBOARD.png',
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
          videoModel: 'video-test',
          variantCount: 1,
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD.md',
      '# STORYBOARD\n\n## SHOT-01\n\n- Purpose: Establish the dog.\n',
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
  const descriptor = getStoryboardArtifactDescriptor()

  try {
    await writeRepoFile(rootDir, 'templates/STORYBOARD.template.png', 'template')
    const storyboardReferences = [
      {
        kind: 'storyboard-template' as const,
        path: 'templates/STORYBOARD.template.png',
      },
    ]

    const seeds: number[] = []
    const summary = await syncStoryboardGeneration({
      storyboardMarkdown: '# STORYBOARD\n\n## SHOT-01\n\n- Purpose: Establish the dog.\n',
      model: 'image-test',
      userReferences: storyboardReferences,
      variantCount: 3,
      cwd: rootDir,
      generator: async (input) => {
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
    expect(seeds).toEqual([1, 2, 3])
    expect(await readFile(path.resolve(rootDir, 'workspace/STORYBOARD.png'), 'utf8')).toBe(
      'storyboard:3',
    )
    expect(await readFile(path.resolve(rootDir, descriptor.historyDir, 'v1.png'), 'utf8')).toBe(
      'storyboard:1',
    )
    expect(await readFile(path.resolve(rootDir, descriptor.historyDir, 'v2.png'), 'utf8')).toBe(
      'storyboard:2',
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
