import {
  getStoryboardImageId,
  getStoryboardImagePath,
  type ArtifactReferenceEntry,
  type FrameType,
  type StoryboardImageEntry,
} from './workflow-data'

export const STORYBOARD_NEW_SELECTION_ID = '__new__'

export interface StoryboardShotSlot {
  shotIndex: number
  shotId: string
  items: StoryboardImageEntry[]
}

export function formatStoryboardShotId(index: number) {
  return `SHOT-${String(index).padStart(2, '0')}`
}

export function getNextStoryboardShotId(
  images: readonly Pick<StoryboardImageEntry, 'shotId' | 'frameType'>[],
) {
  const numericShotIds = images
    .filter((image) => image.frameType === 'start')
    .map((image) => /(\d+)(?!.*\d)/.exec(image.shotId)?.[1] ?? null)
    .filter((value): value is string => value !== null)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))

  if (numericShotIds.length > 0) {
    return formatStoryboardShotId(Math.max(...numericShotIds) + 1)
  }

  const plannedStartCount = images.filter((image) => image.frameType === 'start').length
  return formatStoryboardShotId(plannedStartCount + 1)
}

export function createStoryboardImageEntry(options: {
  shotId: string
  frameType: FrameType
  title: string
  purpose: string
  visual: string
  transition: string
  status?: string
  references?: ArtifactReferenceEntry[]
}) {
  const storyboardImageId = getStoryboardImageId({
    shotId: options.shotId,
    frameType: options.frameType,
  })

  return {
    storyboardImageId,
    shotId: options.shotId,
    frameType: options.frameType,
    title: options.title.trim(),
    purpose: options.purpose.trim(),
    visual: options.visual.trim(),
    transition: options.transition.trim(),
    status: options.status?.trim() || 'draft',
    imagePath: getStoryboardImagePath(storyboardImageId),
    ...(options.references && options.references.length > 0
      ? { references: [...options.references] }
      : {}),
  } satisfies StoryboardImageEntry
}

export function buildStoryboardShotSlots(images: readonly StoryboardImageEntry[]) {
  const slots: StoryboardShotSlot[] = []

  for (const image of images) {
    const lastSlot = slots[slots.length - 1] ?? null
    const canAttachAsEnd =
      image.frameType === 'end' &&
      lastSlot !== null &&
      lastSlot.items.length === 1 &&
      lastSlot.items[0]?.frameType === 'start' &&
      lastSlot.items[0]?.shotId === image.shotId

    if (canAttachAsEnd && lastSlot) {
      lastSlot.items.push(image)
      continue
    }

    slots.push({
      shotIndex: slots.length,
      shotId: image.shotId,
      items: [image],
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

  return slot.items.find((item) => item.frameType === frameType) ?? null
}
