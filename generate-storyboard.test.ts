import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildStoryboardPrompt } from './generate-storyboard'

async function writeRepoFile(rootDir: string, relativePath: string, content: string) {
  const filePath = path.resolve(rootDir, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')
}

test('buildStoryboardPrompt includes raw markdown and shot-label instructions', () => {
  const markdown = `# STORYBOARD

## SHOT-01

- Purpose: Establish the dog.

## SHOT-02

- Purpose: Reveal the transformation.
`

  const prompt = buildStoryboardPrompt(markdown)

  expect(prompt).toContain('single storyboard sheet')
  expect(prompt).toContain('visible shot labels that exactly match the SHOT-XX IDs')
  expect(prompt).toContain(markdown.trim())
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
