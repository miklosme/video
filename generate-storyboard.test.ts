import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getStoryboardArtifactDescriptor } from './artifact-control'
import {
  buildStoryboardPrompt,
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

test('selectPendingStoryboardGeneration attaches the storyboard template reference', () => {
  const generation = selectPendingStoryboardGeneration(
    '# STORYBOARD\n\n## SHOT-01\n\n- Purpose: Establish the dog.\n',
    'google/gemini-3.1-flash-image-preview',
  )

  expect(generation.references).toEqual([
    { kind: 'storyboard-template', path: 'templates/STORYBOARD.template.png' },
  ])
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

test('syncStoryboardGeneration renders variantCount retained versions and selects the last one', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-storyboard-variants-'))
  const descriptor = getStoryboardArtifactDescriptor()

  try {
    await writeRepoFile(rootDir, 'templates/STORYBOARD.template.png', 'template')

    const seeds: number[] = []
    const summary = await syncStoryboardGeneration({
      storyboardMarkdown: '# STORYBOARD\n\n## SHOT-01\n\n- Purpose: Establish the dog.\n',
      model: 'image-test',
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

    const history = JSON.parse(
      await readFile(path.resolve(rootDir, descriptor.artifactControlPath), 'utf8'),
    ) as {
      latestVersionId: string
      selectedVersionId: string
    }
    expect(history.latestVersionId).toBe('v3')
    expect(history.selectedVersionId).toBe('v3')

    const firstVariant = JSON.parse(
      await readFile(path.resolve(rootDir, descriptor.historyDir, 'v1.json'), 'utf8'),
    ) as { autoSelected: boolean; seed: number }
    const lastVariant = JSON.parse(
      await readFile(path.resolve(rootDir, descriptor.historyDir, 'v3.json'), 'utf8'),
    ) as { autoSelected: boolean; seed: number }

    expect(firstVariant).toMatchObject({ autoSelected: false, seed: 1 })
    expect(lastVariant).toMatchObject({ autoSelected: true, seed: 3 })
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
