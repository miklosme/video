import { formatKeyframeCameraPlan } from './camera-utils'
import type { PromptTextBuilderInput } from './generate-imagen-options'
import { buildStoryboardDerivedImages } from './storyboard-utils'
import {
  getStoryboardSidecarPath,
  type FrameType,
  type KeyframeCameraSpec,
  type StoryboardImageEntry,
  type StoryboardSidecar,
} from './workflow-data'

export const STORYBOARD_THUMBNAIL_IMAGE_SIZE = '896x512' as const

const STORYBOARD_SIDECAR_PATH = getStoryboardSidecarPath()

export const STORYBOARD_THUMBNAIL_PROMPT_CONFIG = {
  referencePriorityLine:
    'Reference priority matters: earlier references win when two references conflict.',
  referenceInstructions: {
    startFrame:
      'Reference {n} is the same-shot start frame. Preserve continuity of identity, setting, and staging while pushing toward the requested beat.',
    endFrame:
      'Reference {n} is the same-shot end frame. Match it as the destination beat and final composition target.',
    previousShotEndFrame:
      'Reference {n} is the previous shot end frame. Preserve cross-shot continuity for screen direction, scene geography, and subject placement.',
    storyboard:
      'Reference {n} is another storyboard image for {shotId}. Use it for composition, staging, and visual intent only.',
    storyboardTemplate:
      'Reference {n} is a storyboard thumbnail style reference. Borrow its monochrome sketch treatment, line economy, and review readability, but do not copy any page layout, borders, labels, or multi-panel structure.',
    characterSheet:
      'Reference {n} is a character identity sheet. Preserve the same subject identity, silhouette, markings, and stable wardrobe details.',
    selectedImage:
      'Reference {n} is the currently selected storyboard thumbnail. Treat it as the direct visual baseline and change only what the prompt requires.',
    userReference:
      'Reference {n} is an additional supporting reference. Use it only for the concrete scene facts, props, wardrobe, environment, or composition cues implied by the request.',
  },
} as const

export function appendStoryboardCameraPrompt(prompt: string, camera?: KeyframeCameraSpec) {
  const trimmedPrompt = prompt.trim()

  if (!camera) {
    return trimmedPrompt
  }

  return [
    trimmedPrompt,
    '',
    'Use this camera plan for this frame:',
    formatKeyframeCameraPlan(camera),
    'Keep this framing explicit in the storyboard composition.',
  ].join('\n')
}

function getStoryboardImageContext(
  storyboard: StoryboardSidecar,
  imageSelector: number | string,
): {
  index: number
  current: ReturnType<typeof buildStoryboardDerivedImages>[number]
} {
  const derivedImages = buildStoryboardDerivedImages(storyboard.images)
  const index =
    typeof imageSelector === 'number'
      ? imageSelector
      : derivedImages.findIndex((entry) => entry.storyboardImageId === imageSelector)

  if (index < 0) {
    throw new Error(
      `Storyboard image "${String(imageSelector)}" is missing from ${STORYBOARD_SIDECAR_PATH}.`,
    )
  }

  return {
    index,
    current: derivedImages[index]!,
  }
}

function injectReferenceNumber(template: string, referenceNumber: number, shotId?: string) {
  return template
    .replace('{n}', String(referenceNumber))
    .replace('{shotId}', shotId ?? 'the current shot')
}

function buildStoryboardReferenceInstruction(
  reference: PromptTextBuilderInput['references'][number],
  referenceNumber: number,
  shotId?: string,
) {
  switch (reference.kind) {
    case 'start-frame':
      return injectReferenceNumber(
        STORYBOARD_THUMBNAIL_PROMPT_CONFIG.referenceInstructions.startFrame,
        referenceNumber,
        shotId,
      )
    case 'end-frame':
      return injectReferenceNumber(
        STORYBOARD_THUMBNAIL_PROMPT_CONFIG.referenceInstructions.endFrame,
        referenceNumber,
        shotId,
      )
    case 'previous-shot-end-frame':
      return injectReferenceNumber(
        STORYBOARD_THUMBNAIL_PROMPT_CONFIG.referenceInstructions.previousShotEndFrame,
        referenceNumber,
        shotId,
      )
    case 'storyboard':
      return injectReferenceNumber(
        STORYBOARD_THUMBNAIL_PROMPT_CONFIG.referenceInstructions.storyboard,
        referenceNumber,
        shotId,
      )
    case 'storyboard-template':
      return injectReferenceNumber(
        STORYBOARD_THUMBNAIL_PROMPT_CONFIG.referenceInstructions.storyboardTemplate,
        referenceNumber,
        shotId,
      )
    case 'character-sheet':
      return injectReferenceNumber(
        STORYBOARD_THUMBNAIL_PROMPT_CONFIG.referenceInstructions.characterSheet,
        referenceNumber,
        shotId,
      )
    case 'selected-image':
      return injectReferenceNumber(
        STORYBOARD_THUMBNAIL_PROMPT_CONFIG.referenceInstructions.selectedImage,
        referenceNumber,
        shotId,
      )
    case 'user-reference':
      return injectReferenceNumber(
        STORYBOARD_THUMBNAIL_PROMPT_CONFIG.referenceInstructions.userReference,
        referenceNumber,
        shotId,
      )
  }
}

export function buildStoryboardPrompt(
  storyboard: StoryboardSidecar,
  imageSelector: number | string,
) {
  const { current } = getStoryboardImageContext(storyboard, imageSelector)
  return appendStoryboardCameraPrompt(current.entry.prompt, current.entry.camera)
}

export function buildStoryboardRegeneratePrompt(
  generation: Pick<
    {
      storyboardImageId: string
      shotId: string
      frameType: StoryboardImageEntry['frameType']
      prompt: string
      camera?: StoryboardImageEntry['camera']
    },
    'storyboardImageId' | 'shotId' | 'frameType' | 'prompt' | 'camera'
  >,
  regenerateRequest?: string | null,
) {
  const trimmedPrompt = appendStoryboardCameraPrompt(generation.prompt, generation.camera)
  const trimmedRequest = regenerateRequest?.trim() ?? ''

  const lines = [
    trimmedPrompt,
    '',
    'Use the attached current storyboard thumbnail as the direct visual baseline.',
    'Preserve the same shot intent, subject identity, staging readability, and rough monochrome storyboard treatment unless the prompt or requested change explicitly says otherwise.',
  ]

  if (trimmedRequest.length > 0) {
    lines.push('', `Requested change: ${trimmedRequest}`)
  }

  return lines.join('\n')
}

export function buildStoryboardDirectionPrompt(
  generation: Pick<
    {
      storyboardImageId: string
      shotId: string
      frameType: FrameType
      prompt: string
      camera?: StoryboardImageEntry['camera']
    },
    'storyboardImageId' | 'shotId' | 'frameType' | 'prompt' | 'camera'
  >,
  regenerateRequest: string,
) {
  const trimmedRequest = regenerateRequest.trim()

  if (trimmedRequest.length === 0) {
    throw new Error('A direction request is required for storyboard direction edits.')
  }

  return [
    appendStoryboardCameraPrompt(generation.prompt, generation.camera),
    '',
    'Use the attached current storyboard thumbnail as the direct visual baseline.',
    'Apply only the requested change and preserve the rest of the frame, including subject identity, staging, continuity, and rough monochrome storyboard readability.',
    '',
    `Requested change: ${trimmedRequest}`,
  ].join('\n')
}

export function buildStoryboardPromptText(input: PromptTextBuilderInput) {
  const lines = [input.prompt]

  if (input.references.length > 0) {
    lines.push('', STORYBOARD_THUMBNAIL_PROMPT_CONFIG.referencePriorityLine)

    for (const [index, reference] of input.references.entries()) {
      lines.push(buildStoryboardReferenceInstruction(reference, index + 1, input.shotId))
    }
  }

  return lines.join('\n')
}
