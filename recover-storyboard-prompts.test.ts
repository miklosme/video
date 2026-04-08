import { expect, test } from 'bun:test'

import {
  buildPromptRecoveryRequest,
  getDefaultOutputPath,
  getImagePathCandidates,
  normalizeRecoveredPrompt,
} from './recover-storyboard-prompts'

test('normalizeRecoveredPrompt trims wrapping quotes and collapses whitespace', () => {
  expect(normalizeRecoveredPrompt('  "Busy market.   Merchant runs."  \n')).toBe(
    'Busy market. Merchant runs.',
  )
})

test('buildPromptRecoveryRequest keeps the original prompt as style-only guidance', () => {
  const request = buildPromptRecoveryRequest({
    frameType: 'end',
    prompt: 'Old prompt that should not be trusted.',
    camera: {
      shotSize: 'medium-shot',
      cameraPosition: 'eye-level',
      cameraAngle: 'level-angle',
    },
    imagePath: 'workspace/STORYBOARD/example.png',
  })

  expect(request).toContain('Use only as terminology and style reference')
  expect(request).toContain('Frame type from JSON: end.')
  expect(request).toContain('shotSize=medium-shot')
  expect(request).toContain('Return JSON with this shape: {"prompt":"..."}')
})

test('getImagePathCandidates collapses duplicate workspace-root candidates', () => {
  expect(
    getImagePathCandidates(
      'workspace/STORYBOARD/example.png',
      '/repo/workspace/STORYBOARD/STORYBOARD.json',
      '/repo',
    ),
  ).toEqual(['/repo/workspace/STORYBOARD/example.png'])
})

test('getDefaultOutputPath writes next to the storyboard file', () => {
  expect(getDefaultOutputPath('/repo/workspace/STORYBOARD/STORYBOARD.json')).toBe(
    '/repo/workspace/STORYBOARD/STORYBOOK.fixed.json',
  )
})
