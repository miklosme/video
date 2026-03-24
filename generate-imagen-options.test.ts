import { expect, test } from 'bun:test'

import { buildPromptText } from './generate-imagen-options'

test('buildPromptText tells keyframe generation which storyboard panel to use', () => {
  const prompt = buildPromptText(
    'Render the start frame.',
    [
      { kind: 'storyboard', path: 'workspace/STORYBOARD.png' },
      { kind: 'character-sheet', path: 'workspace/CHARACTERS/dog-01.png' },
    ],
    '16:9',
    'google/gemini-3.1-flash-image-preview',
    'SHOT-02',
  )

  expect(prompt).toContain('Reference 1 is the full-project storyboard board.')
  expect(prompt).toContain('Focus on the panel labeled "SHOT-02"')
  expect(prompt).toContain('Reference 2 is a character identity sheet.')
})

test('buildPromptText explains previous-shot continuity references', () => {
  const prompt = buildPromptText(
    'Render the continuity start frame.',
    [{ kind: 'previous-shot-end-frame', path: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png' }],
    '16:9',
    'google/gemini-3.1-flash-image-preview',
    'SHOT-02',
  )

  expect(prompt).toContain('Reference 1 is the previous shot end frame.')
  expect(prompt).toContain('preserve cross-shot continuity')
})

test('buildPromptText explains storyboard template references', () => {
  const prompt = buildPromptText(
    'Render the storyboard review board.',
    [{ kind: 'storyboard-template', path: 'templates/STORYBOARD.template.png' }],
    '16:9',
    'google/gemini-3.1-flash-image-preview',
  )

  expect(prompt).toContain('Reference 1 is the storyboard template image.')
  expect(prompt).toContain('Follow its board layout, panel framing, header structure')
  expect(prompt).toContain('derive the actual shot content from the provided storyboard markdown')
})
