import { expect, test } from 'bun:test'

import {
  buildStoryboardPrompt,
  buildStoryboardPromptText,
  buildStoryboardRegeneratePrompt,
  STORYBOARD_THUMBNAIL_IMAGE_SIZE,
} from './storyboard-prompting'
import { type StoryboardSidecar } from './workflow-data'

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
