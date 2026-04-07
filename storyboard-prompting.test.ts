import { expect, test } from 'bun:test'

import {
  buildStoryboardDirectionPrompt,
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
        prompt:
          'A medium shot of a tense dog staring at a warped window reflection. Style: rough graphite storyboard sketch.',
        camera: {
          shotSize: 'medium-shot',
          cameraPosition: 'eye-level',
          cameraAngle: 'level-angle',
        },
        imagePath: 'workspace/STORYBOARD/storyboard-image-alpha.png',
      },
    ],
  }
}

test('buildStoryboardPrompt combines the authored prompt with camera guidance', () => {
  const prompt = buildStoryboardPrompt(createStoryboard(), 'SHOT-01-START')

  expect(prompt).toContain(
    'A medium shot of a tense dog staring at a warped window reflection. Style: rough graphite storyboard sketch.',
  )
  expect(prompt).toContain('Style: black-and-white rough graphite sketch')
  expect(prompt).toContain('- Shot Size: Medium Shot')
})

test('buildStoryboardPromptText appends reference instructions without rebuilding the prompt', () => {
  const prompt = buildStoryboardPromptText({
    prompt:
      'A medium shot of a tense dog staring at a warped window reflection. Style: rough graphite storyboard sketch.',
    references: [{ kind: 'storyboard-template', path: 'templates/STORYBOARD.template.png' }],
    aspectRatio: '16:9',
    model: 'google/gemini-3.1-flash-image-preview',
    size: STORYBOARD_THUMBNAIL_IMAGE_SIZE,
    shotId: 'SHOT-01',
  })

  expect(prompt).toContain('A medium shot of a tense dog staring at a warped window reflection.')
  expect(prompt).toContain('Reference priority matters')
  expect(prompt).toContain('storyboard thumbnail style reference')
  expect(prompt).toContain('do not copy any page layout, borders, labels, or multi-panel structure')
})

test('buildStoryboardRegeneratePrompt preserves the authored prompt and layers edit instructions', () => {
  const prompt = buildStoryboardRegeneratePrompt(
    {
      storyboardImageId: 'SHOT-01-START',
      shotId: 'SHOT-01',
      frameType: 'start',
      prompt:
        'A medium shot of a tense dog staring at a warped window reflection. Style: rough graphite storyboard sketch.',
    },
    'Remove the extra background character.',
  )

  expect(prompt).toContain('A medium shot of a tense dog staring at a warped window reflection.')
  expect(prompt).toContain(
    'Use the attached current storyboard thumbnail as the direct visual baseline.',
  )
  expect(prompt).toContain('Requested change: Remove the extra background character.')
})

test('buildStoryboardDirectionPrompt creates an incremental edit instruction without restating the base frame prompt', () => {
  const prompt = buildStoryboardDirectionPrompt(
    {
      storyboardImageId: 'SHOT-01-START',
      shotId: 'SHOT-01',
      frameType: 'start',
      prompt:
        'A medium shot of a tense dog staring at a warped window reflection. Style: rough graphite storyboard sketch.',
    },
    'Make the dog face the door instead.',
  )

  expect(prompt).not.toContain(
    'A medium shot of a tense dog staring at a warped window reflection.',
  )
  expect(prompt).toContain('This is an incremental storyboard edit, not a fresh render.')
  expect(prompt).toContain('Apply only the requested change')
  expect(prompt).toContain('Requested change: Make the dog face the door instead.')
})
