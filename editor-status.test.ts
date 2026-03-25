import { expect, test } from 'bun:test'

import { getEditorStatus } from './editor-status'

test('getEditorStatus returns not yet available for a missing shots manifest', () => {
  const error = Object.assign(new Error('ENOENT: no such file or directory'), {
    code: 'ENOENT',
    path: '/Users/miklosme/github/video/workspace/SHOTS.json',
  })

  expect(getEditorStatus(error)).toBe('Not yet available')
})

test('getEditorStatus returns not yet available when the missing file only appears in the message', () => {
  const error = Object.assign(
    new Error(
      "ENOENT: no such file or directory, open '/Users/miklosme/github/video/workspace/FINAL-CUT.json'",
    ),
    {
      code: 'ENOENT',
    },
  )

  expect(getEditorStatus(error)).toBe('Not yet available')
})

test('getEditorStatus preserves unexpected startup failures', () => {
  expect(getEditorStatus(new Error('Port already in use.'))).toBe(
    'Unavailable: Port already in use.',
  )
})
