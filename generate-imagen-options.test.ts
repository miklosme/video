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
  expect(prompt).toContain('Follow the panel labeled "SHOT-02"')
  expect(prompt).toContain('Reference 2 is a character identity sheet.')
  expect(prompt).not.toContain('provided order of priority')
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
  expect(prompt).toContain('Preserve cross-shot continuity')
})

test('buildPromptText explains storyboard template references', () => {
  const prompt = buildPromptText(
    'Render the storyboard review board.',
    [{ kind: 'storyboard-template', path: 'templates/STORYBOARD.template.png' }],
    '16:9',
    'google/gemini-3.1-flash-image-preview',
  )

  expect(prompt).toContain('Reference 1 is the storyboard template image.')
  expect(prompt).toContain('Match its board layout, panel framing, border treatment')
  expect(prompt).toContain('deriving shot content from the storyboard markdown')
})

test('buildPromptText includes the requested target image size when provided', () => {
  const prompt = buildPromptText(
    'Render the keyframe.',
    [],
    '16:9',
    'google/gemini-3.1-flash-image-preview',
    'SHOT-01',
    '1024x576',
  )

  expect(prompt).toContain('Target image size: 1024x576.')
  expect(prompt).toContain('Prefer the lower-resolution output tier when available.')
})
