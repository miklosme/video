import type { PromptTextBuilderInput } from './generate-imagen-options'
import { buildStoryboardDerivedImages } from './storyboard-utils'
import { type StoryboardImageEntry, type StoryboardSidecar } from './workflow-data'

export const STORYBOARD_THUMBNAIL_IMAGE_SIZE = '896x512' as const

export const STORYBOARD_THUMBNAIL_PROMPT_CONFIG = {
  generationDirectives: [
    'Create a single 16:9 storyboard thumbnail image for one planned shot anchor.',
    'No multi-panel sheet, page layout, border frame, shot label, caption, speech bubble, watermark, or any other text inside the image.',
    'Black and white only: rough graphite or pencil storyboard sketch, loose previs linework, and light grayscale shading.',
    'Prioritize clear staging, strong silhouettes, readable spatial depth, and one obvious focal point.',
    'Keep it rough and iteration-friendly, not a polished illustration, cinematic concept painting, or finished comic panel.',
  ],
  frameDirectives: {
    start: 'Show the opening beat of the shot, not the ending beat.',
    end: 'Show the closing beat of the shot, not the opening beat.',
  },
  regenerationDirectives: [
    'Keep the same single-thumbnail storyboard treatment unless the direction below explicitly asks for a broader change.',
    'Preserve the core shot intent, subject placement, and readability unless the direction below explicitly changes them.',
  ],
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
      'Reference {n} is the currently selected storyboard thumbnail. Treat it as the direct visual baseline and change only what the direction requires.',
    userReference:
      'Reference {n} is an additional supporting reference. Use it only for the concrete scene facts, props, wardrobe, environment, or composition cues implied by the request.',
  },
} as const

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
      `Storyboard image "${String(imageSelector)}" is missing from workspace/STORYBOARD.json.`,
    )
  }

  return {
    index,
    current: derivedImages[index]!,
  }
}

export function buildStoryboardPrompt(
  storyboard: StoryboardSidecar,
  imageSelector: number | string,
) {
  const { current } = getStoryboardImageContext(storyboard, imageSelector)

  return [
    ...STORYBOARD_THUMBNAIL_PROMPT_CONFIG.generationDirectives,
    STORYBOARD_THUMBNAIL_PROMPT_CONFIG.frameDirectives[current.entry.frameType],
    '',
    `Shot: ${current.shotId}`,
    `Frame: ${current.entry.frameType}`,
    `Storyboard Image: ${current.storyboardImageId}`,
    `Goal: ${current.entry.goal.trim()}`,
  ].join('\n')
}

export function buildStoryboardRegeneratePrompt(
  generation: Pick<
    {
      storyboardImageId: string
      shotId: string
      frameType: StoryboardImageEntry['frameType']
      goal: string
    },
    'storyboardImageId' | 'shotId' | 'frameType' | 'goal'
  >,
  regenerateRequest?: string | null,
) {
  const trimmedRequest = regenerateRequest?.trim() ?? ''

  const lines = [
    `Regenerate the current storyboard image for ${generation.storyboardImageId}.`,
    `Use the attached ${generation.frameType} frame from ${generation.shotId} as the direct visual baseline.`,
    ...STORYBOARD_THUMBNAIL_PROMPT_CONFIG.regenerationDirectives,
    '',
    `Shot: ${generation.shotId}`,
    `Frame: ${generation.frameType}`,
    `Goal: ${generation.goal.trim()}`,
  ]

  if (trimmedRequest.length > 0) {
    lines.push('', 'Direction:', trimmedRequest)
  }

  return lines.join('\n')
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

export function buildStoryboardPromptText(input: PromptTextBuilderInput) {
  const lines = [input.prompt]

  if (input.references.length > 0) {
    lines.push('', STORYBOARD_THUMBNAIL_PROMPT_CONFIG.referencePriorityLine)

    for (const [index, reference] of input.references.entries()) {
      lines.push(buildStoryboardReferenceInstruction(reference, index + 1, input.shotId))
    }
  }

  if (input.size) {
    lines.push(
      '',
      `Target image size: ${input.size}. Prefer the lower-resolution output tier when available.`,
    )
  }

  lines.push(`Target aspect ratio: ${input.aspectRatio}.`)

  return lines.join('\n')
}
