import { expect, test } from 'bun:test'

import {
  buildStoryboardShotSlots,
  createStoryboardImageEntry,
  findStoryboardImageForShotIndex,
  getNextStoryboardShotId,
} from './storyboard-utils'
import { type StoryboardImageEntry } from './workflow-data'

function createImages(): StoryboardImageEntry[] {
  return [
    createStoryboardImageEntry({
      frameType: 'start',
      prompt: 'Start one',
    }),
    createStoryboardImageEntry({
      frameType: 'end',
      prompt: 'End one',
    }),
    createStoryboardImageEntry({
      frameType: 'start',
      prompt: 'Start two',
    }),
  ]
}

test('buildStoryboardShotSlots groups adjacent start and end storyboard frames', () => {
  const slots = buildStoryboardShotSlots(createImages())

  expect(slots).toHaveLength(2)
  expect(slots[0]?.items.map((item) => item.storyboardImageId)).toEqual([
    'SHOT-01-START',
    'SHOT-01-END',
  ])
  expect(slots[1]?.items.map((item) => item.storyboardImageId)).toEqual(['SHOT-02-START'])
})

test('findStoryboardImageForShotIndex matches storyboard frames by slot order and frame type', () => {
  const images = createImages()

  expect(findStoryboardImageForShotIndex(images, 0, 'start')).toMatchObject({
    frameType: 'start',
    prompt: 'Start one',
  })
  expect(findStoryboardImageForShotIndex(images, 0, 'end')).toMatchObject({
    frameType: 'end',
    prompt: 'End one',
  })
  expect(findStoryboardImageForShotIndex(images, 1, 'start')).toMatchObject({
    frameType: 'start',
    prompt: 'Start two',
  })
  expect(findStoryboardImageForShotIndex(images, 1, 'end')).toBeNull()
})

test('getNextStoryboardShotId advances from the highest planned start shot id', () => {
  expect(getNextStoryboardShotId(createImages())).toBe('SHOT-03')
})
