import { randomBytes } from 'node:crypto'

import {
  getStoryboardArtifactIdFromPath,
  getStoryboardImageId,
  getStoryboardImagePath,
  type FrameType,
  type KeyframeCameraSpec,
  type StoryboardImageEntry,
} from './workflow-data'

export const STORYBOARD_NEW_SELECTION_ID = '__new__'

export interface StoryboardDerivedImageEntry {
  imageIndex: number
  shotIndex: number
  shotId: string
  storyboardImageId: string
  entry: StoryboardImageEntry
}

export interface StoryboardShotSlot {
  shotIndex: number
  shotId: string
  items: StoryboardDerivedImageEntry[]
}

export function formatStoryboardShotId(index: number) {
  return `SHOT-${String(index).padStart(2, '0')}`
}

export function getStoryboardSelectionId(imageIndex: number) {
  return String(imageIndex)
}

export function parseStoryboardSelectionId(value: string) {
  if (!/^\d+$/.test(value)) {
    return null
  }

  const imageIndex = Number(value)
  return Number.isInteger(imageIndex) && imageIndex >= 0 ? imageIndex : null
}

export function createStoryboardImagePath() {
  return getStoryboardImagePath(`storyboard-image-${randomBytes(4).toString('hex')}.png`)
}

export function buildStoryboardDerivedImages(images: readonly StoryboardImageEntry[]) {
  const derivedImages: StoryboardDerivedImageEntry[] = []
  let currentShotIndex = -1

  for (const [imageIndex, entry] of images.entries()) {
    const previous = images[imageIndex - 1] ?? null
    const sharesPreviousShot = entry.frameType === 'end' && previous?.frameType === 'start'

    if (!sharesPreviousShot) {
      currentShotIndex += 1
    }

    const shotId = formatStoryboardShotId(currentShotIndex + 1)

    derivedImages.push({
      imageIndex,
      shotIndex: currentShotIndex,
      shotId,
      storyboardImageId: getStoryboardImageId({
        shotId,
        frameType: entry.frameType,
      }),
      entry,
    })
  }

  return derivedImages
}

export function getNextStoryboardShotId(images: readonly StoryboardImageEntry[]) {
  return formatStoryboardShotId(buildStoryboardShotSlots(images).length + 1)
}

export function createStoryboardImageEntry(options: {
  frameType: FrameType
  prompt: string
  camera?: KeyframeCameraSpec
  imagePath?: string | null
}) {
  return {
    frameType: options.frameType,
    prompt: options.prompt.trim(),
    ...(options.camera ? { camera: options.camera } : {}),
    imagePath: options.imagePath ?? null,
  } satisfies StoryboardImageEntry
}

export function buildStoryboardShotSlots(images: readonly StoryboardImageEntry[]) {
  const slots: StoryboardShotSlot[] = []

  for (const item of buildStoryboardDerivedImages(images)) {
    const lastSlot = slots[slots.length - 1] ?? null

    if (lastSlot && lastSlot.shotIndex === item.shotIndex) {
      lastSlot.items.push(item)
      continue
    }

    slots.push({
      shotIndex: item.shotIndex,
      shotId: item.shotId,
      items: [item],
    })
  }

  return slots
}

export function findStoryboardImageForShotIndex(
  images: readonly StoryboardImageEntry[],
  shotIndex: number,
  frameType: FrameType,
) {
  const slot = buildStoryboardShotSlots(images)[shotIndex]

  if (!slot) {
    return null
  }

  return slot.items.find((item) => item.entry.frameType === frameType)?.entry ?? null
}

export function findStoryboardDerivedImageBySelectionId(
  images: readonly StoryboardImageEntry[],
  selectionId: string,
) {
  const imageIndex = parseStoryboardSelectionId(selectionId)

  if (imageIndex === null) {
    return null
  }

  return buildStoryboardDerivedImages(images)[imageIndex] ?? null
}

export function findStoryboardDerivedImageByArtifactId(
  images: readonly StoryboardImageEntry[],
  artifactId: string,
) {
  return (
    buildStoryboardDerivedImages(images).find(
      (item) =>
        item.entry.imagePath !== null &&
        getStoryboardArtifactIdFromPath(item.entry.imagePath) === artifactId,
    ) ?? null
  )
}
