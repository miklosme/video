import { expect, test } from 'bun:test'

import {
  clearBufferedNextStepSuggestions,
  createEmptyBufferedNextStepSuggestions,
  getNextStepSuggestionShortcutIndex,
  normalizeSuggestedNextSteps,
  promotePendingBufferedNextStepSuggestions,
  setPendingBufferedNextStepSuggestions,
} from './next-step-suggestions'

test('normalizeSuggestedNextSteps trims and validates exactly three suggestions', () => {
  expect(
    normalizeSuggestedNextSteps([
      { label: '  Draft story  ', prompt: '  Draft STORY.md from the idea.  ' },
      { label: 'Three options', prompt: 'Give me 3 story options.' },
      { label: 'Review gaps', prompt: 'Review STORY.md and tell me what is weak.' },
    ]),
  ).toEqual([
    { label: 'Draft story', prompt: 'Draft STORY.md from the idea.' },
    { label: 'Three options', prompt: 'Give me 3 story options.' },
    { label: 'Review gaps', prompt: 'Review STORY.md and tell me what is weak.' },
  ])

  expect(
    normalizeSuggestedNextSteps([
      { label: 'Only one', prompt: 'One' },
      { label: 'Only two', prompt: 'Two' },
    ]),
  ).toBeNull()

  expect(
    normalizeSuggestedNextSteps([
      { label: 'One', prompt: 'One' },
      { label: 'Two', prompt: 'Two' },
      { label: '   ', prompt: 'Three' },
    ]),
  ).toBeNull()
})

test('buffered suggestion helpers keep pending suggestions hidden until promotion', () => {
  const withPending = setPendingBufferedNextStepSuggestions(
    createEmptyBufferedNextStepSuggestions(),
    [
      { label: 'Draft story', prompt: 'Draft STORY.md from the idea.' },
      { label: 'Three options', prompt: 'Give me 3 story options.' },
      { label: 'Review gaps', prompt: 'Review STORY.md and tell me what is weak.' },
    ],
  )

  expect(withPending.pending).toEqual([
    { label: 'Draft story', prompt: 'Draft STORY.md from the idea.' },
    { label: 'Three options', prompt: 'Give me 3 story options.' },
    { label: 'Review gaps', prompt: 'Review STORY.md and tell me what is weak.' },
  ])
  expect(withPending.displayed).toEqual([])

  const promoted = promotePendingBufferedNextStepSuggestions(withPending)

  expect(promoted.pending).toBeNull()
  expect(promoted.displayed).toEqual([
    { label: 'Draft story', prompt: 'Draft STORY.md from the idea.' },
    { label: 'Three options', prompt: 'Give me 3 story options.' },
    { label: 'Review gaps', prompt: 'Review STORY.md and tell me what is weak.' },
  ])

  expect(clearBufferedNextStepSuggestions()).toEqual({
    pending: null,
    displayed: [],
  })
})

test('buffered suggestion helpers keep the last pending payload before promotion', () => {
  const initial = setPendingBufferedNextStepSuggestions(createEmptyBufferedNextStepSuggestions(), [
    { label: 'First', prompt: 'First prompt.' },
    { label: 'Second', prompt: 'Second prompt.' },
    { label: 'Third', prompt: 'Third prompt.' },
  ])

  const replaced = setPendingBufferedNextStepSuggestions(initial, [
    { label: 'Draft story', prompt: 'Draft STORY.md from the current idea.' },
    { label: 'Three options', prompt: 'Give me 3 story directions.' },
    { label: 'Review gaps', prompt: 'Review STORY.md and tell me what is weak.' },
  ])

  expect(promotePendingBufferedNextStepSuggestions(replaced).displayed).toEqual([
    { label: 'Draft story', prompt: 'Draft STORY.md from the current idea.' },
    { label: 'Three options', prompt: 'Give me 3 story directions.' },
    { label: 'Review gaps', prompt: 'Review STORY.md and tell me what is weak.' },
  ])
})

test('shortcut helper maps only keys 1 through 3', () => {
  expect(getNextStepSuggestionShortcutIndex('1', undefined)).toBe(0)
  expect(getNextStepSuggestionShortcutIndex(undefined, '2')).toBe(1)
  expect(getNextStepSuggestionShortcutIndex('3', undefined)).toBe(2)
  expect(getNextStepSuggestionShortcutIndex('4', undefined)).toBeNull()
  expect(getNextStepSuggestionShortcutIndex('return', '\r')).toBeNull()
})
