import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  buildStoryboardDirectPromptText,
  buildStoryboardPrompt,
  buildStoryboardPromptRewritePrompt,
  buildStoryboardPromptText,
  buildStoryboardRegeneratePrompt,
  modelUsesStoryboardPromptRewrite,
  rewriteStoryboardPrompt,
  STORYBOARD_THUMBNAIL_IMAGE_SIZE,
} from './storyboard-prompting'
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
    ],
  }
}

test('buildStoryboardPrompt reinforces single-thumbnail storyboard output', () => {
  const prompt = buildStoryboardPrompt(createStoryboard(), 'SHOT-01-START')

  expect(prompt).toContain('Create a single 16:9 storyboard thumbnail image')
  expect(prompt).toContain('Black and white only')
  expect(prompt).toContain('Shot: SHOT-01')
  expect(prompt).toContain('Frame: start')
  expect(prompt).toContain(
    'Goal: Establish the dog noticing something off in the window reflection.',
  )
})

test('buildStoryboardPromptText keeps template references focused on thumbnail style', () => {
  const prompt = buildStoryboardPromptText({
    prompt: 'Create the storyboard thumbnail.',
    references: [{ kind: 'storyboard-template', path: 'templates/STORYBOARD.template.png' }],
    aspectRatio: '16:9',
    model: 'google/gemini-3.1-flash-image-preview',
    size: STORYBOARD_THUMBNAIL_IMAGE_SIZE,
    shotId: 'SHOT-01',
  })

  expect(prompt).toContain('Reference priority matters')
  expect(prompt).toContain('storyboard thumbnail style reference')
  expect(prompt).toContain('do not copy any page layout, borders, labels, or multi-panel structure')
  expect(prompt).not.toContain('board layout')
  expect(prompt).toContain(`Target image size: ${STORYBOARD_THUMBNAIL_IMAGE_SIZE}.`)
  expect(prompt).toContain('Target aspect ratio: 16:9.')
})

test('buildStoryboardRegeneratePrompt keeps the shot plan visible during iteration', () => {
  const prompt = buildStoryboardRegeneratePrompt(
    {
      storyboardImageId: 'SHOT-01-START',
      shotId: 'SHOT-01',
      frameType: 'start',
      goal: 'Establish the dog noticing something off in the window reflection.',
    },
    'Remove the extra background character.',
  )

  expect(prompt).toContain('Regenerate the current storyboard image for SHOT-01-START.')
  expect(prompt).toContain('Keep the same single-thumbnail storyboard treatment')
  expect(prompt).toContain('Shot: SHOT-01')
  expect(prompt).toContain('Frame: start')
  expect(prompt).toContain('Direction:')
  expect(prompt).toContain('Remove the extra background character.')
})

test('buildStoryboardDirectPromptText keeps rewritten storyboard prompts untouched', () => {
  const prompt = buildStoryboardDirectPromptText({
    prompt:
      'A tense merchant clutches his satchel in a crowded market. Style: rough graphite storyboard sketch.',
    references: [{ kind: 'storyboard-template', path: 'templates/STORYBOARD.template.png' }],
    aspectRatio: '16:9',
    model: 'bfl/flux-2-klein-9b',
    size: STORYBOARD_THUMBNAIL_IMAGE_SIZE,
    shotId: 'SHOT-01',
  })

  expect(prompt).toBe(
    'A tense merchant clutches his satchel in a crowded market. Style: rough graphite storyboard sketch.',
  )
})

test('buildStoryboardPromptRewritePrompt assembles the rewrite context from workspace canon', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-storyboard-rewrite-context-'))

  try {
    await writeRepoFile(rootDir, 'workspace/IDEA.md', '# IDEA\nA comic Renaissance chase.\n')
    await writeRepoFile(rootDir, 'workspace/STORY.md', '# STORY\nThe merchant loses the bag.\n')
    await writeRepoFile(
      rootDir,
      'workspace/CHARACTERS.md',
      '# CHARACTERS\n\n## Merchant\nCharacter ID: merchant\nNervous cloth seller.\n',
    )

    const prompt = await buildStoryboardPromptRewritePrompt({
      prompt:
        'Create a single 16:9 storyboard thumbnail image for one planned shot anchor.\nShot: SHOT-01\nFrame: start\nGoal: Establish the merchant realizing the bag is gone.',
      imageModel: 'bfl/flux-2-klein-9b',
      rewriteModel: 'openai/gpt-5.4-mini',
      storyboardImageId: 'SHOT-01-START',
      shotId: 'SHOT-01',
      frameType: 'start',
      goal: 'Establish the merchant realizing the bag is gone.',
      previousFrameSummary: null,
      nextFrameSummary: 'SHOT-01-END (end) — The merchant lunges into the crowd.',
      references: [{ kind: 'storyboard-template', path: 'templates/STORYBOARD.template.png' }],
      cwd: rootDir,
    })

    expect(prompt).toContain('Story overview:')
    expect(prompt).toContain('workspace/IDEA.md')
    expect(prompt).toContain('workspace/STORY.md')
    expect(prompt).toContain('Characters:')
    expect(prompt).toContain('workspace/CHARACTERS.md')
    expect(prompt).toContain('Style notes:')
    expect(prompt).toContain('single 16:9 storyboard thumbnail image')
    expect(prompt).toContain('Shot context:')
    expect(prompt).toContain('After: SHOT-01-END (end) — The merchant lunges into the crowd.')
    expect(prompt).toContain('Reference cues:')
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('rewriteStoryboardPrompt uses the configured rewrite step only for supported models', async () => {
  const rewritten = await rewriteStoryboardPrompt(
    {
      prompt: 'Base storyboard prompt.',
      imageModel: 'bfl/flux-2-klein-9b',
      rewriteModel: 'openai/gpt-5.4-mini',
      storyboardImageId: 'SHOT-01-START',
      shotId: 'SHOT-01',
      frameType: 'start',
      goal: 'Establish the merchant realizing the bag is gone.',
      references: [],
    },
    {
      rewriter: async (input) => `${input.prompt} Rewritten.`,
    },
  )

  const untouched = await rewriteStoryboardPrompt(
    {
      prompt: 'Base storyboard prompt.',
      imageModel: 'google/gemini-3.1-flash-image-preview',
      rewriteModel: 'openai/gpt-5.4-mini',
      storyboardImageId: 'SHOT-01-START',
      shotId: 'SHOT-01',
      frameType: 'start',
      goal: 'Establish the merchant realizing the bag is gone.',
      references: [],
    },
    {
      rewriter: async () => 'Should not be used.',
    },
  )

  expect(modelUsesStoryboardPromptRewrite('bfl/flux-2-klein-9b')).toBe(true)
  expect(modelUsesStoryboardPromptRewrite('google/gemini-3.1-flash-image-preview')).toBe(false)
  expect(rewritten).toBe('Base storyboard prompt. Rewritten.')
  expect(untouched).toBe('Base storyboard prompt.')
})
