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
      shotId: 'SHOT-01',
      frameType: 'start',
      title: 'One',
      purpose: 'Start one',
      visual: 'Visual one',
      transition: 'Transition one',
    }),
    createStoryboardImageEntry({
      shotId: 'SHOT-01',
      frameType: 'end',
      title: 'One End',
      purpose: 'End one',
      visual: 'Visual one end',
      transition: 'Transition one end',
    }),
    createStoryboardImageEntry({
      shotId: 'SHOT-02',
      frameType: 'start',
      title: 'Two',
      purpose: 'Start two',
      visual: 'Visual two',
      transition: 'Transition two',
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

  expect(findStoryboardImageForShotIndex(images, 0, 'start')?.storyboardImageId).toBe(
    'SHOT-01-START',
  )
  expect(findStoryboardImageForShotIndex(images, 0, 'end')?.storyboardImageId).toBe('SHOT-01-END')
  expect(findStoryboardImageForShotIndex(images, 1, 'start')?.storyboardImageId).toBe(
    'SHOT-02-START',
  )
  expect(findStoryboardImageForShotIndex(images, 1, 'end')).toBeNull()
})

test('getNextStoryboardShotId advances from the highest planned start shot id', () => {
  expect(getNextStoryboardShotId(createImages())).toBe('SHOT-03')
})
