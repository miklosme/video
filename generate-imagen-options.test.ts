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
