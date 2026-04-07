import { createGateway, generateText } from 'ai'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { formatKeyframeCameraPlan } from './camera-utils'
import type { PromptTextBuilderInput } from './generate-imagen-options'
import { buildStoryboardDerivedImages } from './storyboard-utils'
import {
  loadCharacterSheets,
  resolveWorkflowPath,
  workspacePathExists,
  type FrameType,
  type GenerationLogEntry,
  type GenerationReferenceEntry,
  type StoryboardImageEntry,
  type StoryboardSidecar,
} from './workflow-data'

export const STORYBOARD_THUMBNAIL_IMAGE_SIZE = '896x512' as const
export const STORYBOARD_PROMPT_REWRITE_IMAGE_MODELS = ['bfl/flux-2-klein-9b'] as const

const STORYBOARD_PROMPT_REWRITE_IMAGE_MODEL_SET = new Set<string>(
  STORYBOARD_PROMPT_REWRITE_IMAGE_MODELS,
)

export const STORYBOARD_STYLE_NOTES = [
  'single 16:9 storyboard thumbnail image',
  'black and white only',
  'rough graphite or pencil storyboard sketch',
  'loose previs linework with light grayscale shading',
  'clear staging and strong silhouettes',
  'readable spatial depth and one obvious focal point',
  'rough and iteration-friendly rather than a polished illustration or finished comic panel',
] as const

export const STORYBOARD_FLUX_KLEIN_REWRITE_SYSTEM_PROMPT = `You are a prompt engineer specializing in the FLUX.2 [klein] 4B image generation model. Your job is to take storyboard context and produce a single, optimized image generation prompt.

## Input you will receive:
- Story overview: The overall narrative, themes, and visual tone
- Shot description: What this specific storyboard frame depicts
- Characters: Descriptions of characters appearing in this frame
- Setting/location: Where the scene takes place
- Style notes: Any aesthetic direction (art style, color palette, mood)
- Shot context: What happens immediately before and after this frame (for visual continuity)
- Reference cues: How the attached image references should influence the frame, in priority order
- Edit direction: Optional approved change request when this is a regeneration of an existing frame

## FLUX.2 [klein] 4B prompting rules — follow these exactly:

1. Write flowing prose, not keyword lists. Klein interprets natural language paragraphs, not comma-separated tags. Every sentence should add visual information.

2. Front-load the subject. Klein pays more attention to what comes first. Structure: Main subject and their action → setting/environment → lighting and atmosphere → style annotation. Never bury the subject behind atmosphere or setting.

3. No negative prompts. Klein doesn't support them. Describe what IS in the scene, not what isn't. If something should be absent, imply it through what's present.

4. No prompt upsampling. Klein uses your prompt verbatim — it won't fill in gaps. Every visual dimension you leave unspecified defaults to generic. Be explicit about: lighting direction and quality, color palette, material textures, spatial relationships, facial expressions, body language, clothing details.

5. Use natural language for emphasis. No weight syntax. Use phrases like "prominently featuring," "with particular attention to," or "especially detailed" to signal priority elements.

6. Hex colors for precision. When exact colors matter, use #RRGGBB alongside the color name.

7. End with a style annotation. After the scene description, append a style/mood line. Format: Style: [aesthetic descriptors].

8. Quoted text for any in-frame text. If text appears in the image, use quotes and specify font style, color, and placement.

9. Optimal length: 2-4 sentences. Klein is a 4B model — dense and precise beats long and meandering. Every word should earn its place.

## Your output:
Return ONLY the prompt text. No explanation, no preamble, no markdown formatting. Just the raw prompt string ready to be sent to the model.

## Process:
1. Identify the single most important visual element of this frame — that's your opening.
2. Layer in character details, action, and spatial relationships.
3. Add environment, lighting, and color.
4. Close with a style annotation that matches the project's overall aesthetic.
5. If edit direction is provided, preserve the current frame as the baseline and integrate only the requested change unless the edit explicitly asks for a broader redesign.
6. Review: Is the subject front-loaded? Is every detail visual (not narrative)? Are there any gaps that would default to generic? Fix them.`

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

export interface StoryboardPromptRewriteInput {
  prompt: string
  imageModel: string
  rewriteModel: string
  storyboardImageId: string
  shotId: string
  frameType: FrameType
  goal: string
  previousFrameSummary?: string | null
  nextFrameSummary?: string | null
  references: GenerationReferenceEntry[]
  regenerateRequest?: string | null
  cwd?: string
}

export interface StoryboardPromptRewriteContext {
  storyOverview: string
  characters: string
  settingLocation: string
  styleNotes: string
  shotContext: string
  referenceCues: string
  generationMode: string
}

interface StoryboardPromptRewriteResult {
  prompt: string
  usage?: NonNullable<GenerationLogEntry['usage']>
  providerMetadata?: GenerationLogEntry['providerMetadata']
  finishReason?: string | null
  rawFinishReason?: string | null
  responseId?: string | null
}

export type StoryboardPromptRewriter = (
  input: StoryboardPromptRewriteInput,
) => Promise<string | StoryboardPromptRewriteResult>

function resolveDefaultLogFile(cwd = process.cwd()) {
  return path.resolve(cwd, 'workspace', 'GENERATION-LOG.jsonl')
}

async function appendGenerationLog(entry: GenerationLogEntry) {
  await mkdir(path.dirname(entry.logFile), { recursive: true })
  await appendFile(entry.logFile, `${JSON.stringify(entry)}\n`, 'utf8')
}

function normalizeStoryboardPromptRewriteResult(
  result: string | StoryboardPromptRewriteResult,
): StoryboardPromptRewriteResult {
  return typeof result === 'string' ? { prompt: result } : result
}

function createGatewayProvider() {
  const apiKey = process.env.AI_GATEWAY_API_KEY

  if (!apiKey) {
    throw new Error('AI_GATEWAY_API_KEY is required for storyboard prompt rewriting.')
  }

  return createGateway({ apiKey })
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
      `Storyboard image "${String(imageSelector)}" is missing from workspace/STORYBOARD.json.`,
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

async function readOptionalWorkspaceMarkdown(fileName: string, cwd = process.cwd()) {
  if (!(await workspacePathExists(fileName, cwd))) {
    return null
  }

  const raw = await readFile(resolveWorkflowPath(fileName, cwd), 'utf8')
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

async function loadCharacterSheetsOrEmpty(cwd = process.cwd()) {
  try {
    return await loadCharacterSheets(cwd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

function summarizeReferenceCue(
  reference: GenerationReferenceEntry,
  referenceNumber: number,
  shotId?: string,
) {
  return `- ${buildStoryboardReferenceInstruction(reference, referenceNumber, shotId)}`
}

function getReferenceCharacterId(referencePath: string) {
  return path.posix.basename(referencePath, path.posix.extname(referencePath))
}

async function loadStoryboardPromptRewriteContext(
  input: StoryboardPromptRewriteInput,
): Promise<StoryboardPromptRewriteContext> {
  const cwd = input.cwd ?? process.cwd()
  const [idea, story, charactersMarkdown, characterSheets] = await Promise.all([
    readOptionalWorkspaceMarkdown('IDEA.md', cwd),
    readOptionalWorkspaceMarkdown('STORY.md', cwd),
    readOptionalWorkspaceMarkdown('CHARACTERS.md', cwd),
    loadCharacterSheetsOrEmpty(cwd),
  ])

  const storyOverviewSections = [
    idea ? `workspace/IDEA.md\n${idea}` : null,
    story ? `workspace/STORY.md\n${story}` : null,
  ].filter((value): value is string => value !== null)

  const referencedCharacterIds = new Set(
    input.references
      .filter((reference) => reference.kind === 'character-sheet')
      .map((reference) => getReferenceCharacterId(reference.path)),
  )

  const referencedCharacterSections = characterSheets
    .filter((entry) => referencedCharacterIds.has(entry.characterId))
    .map(
      (entry) =>
        `${entry.displayName} (${entry.characterId})\nReference sheet prompt: ${entry.prompt.trim()}`,
    )

  return {
    storyOverview:
      storyOverviewSections.length > 0
        ? storyOverviewSections.join('\n\n')
        : 'No story overview file was available. Use only the shot description and reference cues.',
    characters:
      referencedCharacterSections.length > 0 || charactersMarkdown
        ? [
            referencedCharacterSections.length > 0
              ? `Referenced character sheets\n${referencedCharacterSections.join('\n\n')}`
              : null,
            charactersMarkdown ? `workspace/CHARACTERS.md\n${charactersMarkdown}` : null,
          ]
            .filter((value): value is string => value !== null)
            .join('\n\n')
        : 'No character canon file or character-sheet references were available. Use only characters explicitly implied by the shot description and references.',
    settingLocation:
      'Derive the setting only from explicit environment and location cues in the story overview, shot description, and attached references. Do not invent a new location.',
    styleNotes: STORYBOARD_STYLE_NOTES.join('; '),
    shotContext: [
      input.previousFrameSummary ? `Before: ${input.previousFrameSummary}` : 'Before: none',
      `Current: ${input.storyboardImageId} (${input.frameType}) — ${input.goal.trim()}`,
      input.nextFrameSummary ? `After: ${input.nextFrameSummary}` : 'After: none',
    ].join('\n'),
    referenceCues:
      input.references.length > 0
        ? [
            'Attached image references are passed to the image model in this exact order. Earlier references have higher priority.',
            ...input.references.map((reference, index) =>
              summarizeReferenceCue(reference, index + 1, input.shotId),
            ),
          ].join('\n')
        : 'No attached image references are available for this frame.',
    generationMode: input.regenerateRequest?.trim()
      ? `Regeneration of an existing storyboard frame. Approved change request: ${input.regenerateRequest.trim()}`
      : 'New storyboard frame generation.',
  }
}

export function modelUsesStoryboardPromptRewrite(imageModel: string) {
  return STORYBOARD_PROMPT_REWRITE_IMAGE_MODEL_SET.has(imageModel)
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
    '',
    'Use this camera plan for this frame:',
    formatKeyframeCameraPlan(current.entry.camera),
    'Treat this camera plan as the framing anchor for the storyboard thumbnail.',
  ].join('\n')
}

export function buildStoryboardRegeneratePrompt(
  generation: Pick<
    {
      storyboardImageId: string
      shotId: string
      frameType: StoryboardImageEntry['frameType']
      goal: string
      camera?: StoryboardImageEntry['camera']
    },
    'storyboardImageId' | 'shotId' | 'frameType' | 'goal' | 'camera'
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
    '',
    'Use this camera plan for this regeneration:',
    formatKeyframeCameraPlan(generation.camera),
    'Preserve the rest of the storyboard readability and continuity unless the direction below explicitly asks for broader changes.',
  ]

  if (trimmedRequest.length > 0) {
    lines.push('', 'Direction:', trimmedRequest)
  }

  return lines.join('\n')
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

export function buildStoryboardDirectPromptText(input: PromptTextBuilderInput) {
  return input.prompt
}

export async function buildStoryboardPromptRewritePrompt(input: StoryboardPromptRewriteInput) {
  const context = await loadStoryboardPromptRewriteContext(input)

  return [
    `Story overview:\n${context.storyOverview}`,
    `Shot description:\n${input.prompt}`,
    `Characters:\n${context.characters}`,
    `Setting/location:\n${context.settingLocation}`,
    `Style notes:\n${context.styleNotes}`,
    `Shot context:\n${context.shotContext}`,
    `Reference cues:\n${context.referenceCues}`,
    `Generation mode:\n${context.generationMode}`,
  ].join('\n\n')
}

function normalizeRewrittenPrompt(text: string) {
  let normalized = text.trim()

  if (normalized.startsWith('```')) {
    normalized = normalized
      .replace(/^```[a-zA-Z0-9_-]*\n?/, '')
      .replace(/\n?```$/, '')
      .trim()
  }

  normalized = normalized.replace(/^Prompt:\s*/i, '').trim()

  if (normalized.length === 0) {
    throw new Error('Storyboard prompt rewriter returned an empty prompt.')
  }

  return normalized
}

async function rewriteStoryboardPromptWithAgentPrompt(
  input: StoryboardPromptRewriteInput,
  rewritePrompt: string,
): Promise<StoryboardPromptRewriteResult> {
  const gateway = createGatewayProvider()
  const result = await generateText({
    model: gateway.languageModel(input.rewriteModel),
    system: STORYBOARD_FLUX_KLEIN_REWRITE_SYSTEM_PROMPT,
    prompt: rewritePrompt,
    temperature: 0.2,
    maxOutputTokens: 400,
  })

  return {
    prompt: normalizeRewrittenPrompt(result.text),
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
      reasoningTokens: result.usage.reasoningTokens,
      cacheReadInputTokens: result.usage.cachedInputTokens,
      cacheCreationInputTokens: result.usage.inputTokenDetails?.cacheWriteTokens,
    },
    providerMetadata: result.providerMetadata,
    finishReason: result.finishReason,
    rawFinishReason: result.rawFinishReason,
    responseId: result.response.id,
  }
}

export async function rewriteStoryboardPromptWithAgent(
  input: StoryboardPromptRewriteInput,
): Promise<StoryboardPromptRewriteResult> {
  return rewriteStoryboardPromptWithAgentPrompt(
    input,
    await buildStoryboardPromptRewritePrompt(input),
  )
}

export async function rewriteStoryboardPrompt(
  input: StoryboardPromptRewriteInput,
  options: {
    rewriter?: StoryboardPromptRewriter
    logFile?: string
  } = {},
) {
  if (!modelUsesStoryboardPromptRewrite(input.imageModel)) {
    return input.prompt
  }

  const startedAt = new Date().toISOString()
  const cwd = input.cwd ?? process.cwd()
  const logFile = options.logFile ? path.resolve(cwd, options.logFile) : resolveDefaultLogFile(cwd)
  const rewriter = options.rewriter
  let completedAt: string | null = null
  let errorDetails: GenerationLogEntry['error'] = null
  let rewriteResult: StoryboardPromptRewriteResult | null = null
  let rewritePrompt = input.prompt

  try {
    rewritePrompt = await buildStoryboardPromptRewritePrompt(input)
    rewriteResult = normalizeStoryboardPromptRewriteResult(
      rewriter
        ? await rewriter(input)
        : await rewriteStoryboardPromptWithAgentPrompt(input, rewritePrompt),
    )
    completedAt = new Date().toISOString()
    return rewriteResult.prompt
  } catch (error) {
    completedAt = new Date().toISOString()
    errorDetails = {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    }
    throw error
  } finally {
    await appendGenerationLog({
      generationId: randomUUID(),
      startedAt,
      completedAt,
      status: errorDetails ? 'error' : 'success',
      operation: 'storyboard-prompt-rewrite',
      model: input.rewriteModel,
      system: STORYBOARD_FLUX_KLEIN_REWRITE_SYSTEM_PROMPT,
      prompt: rewritePrompt,
      outputText: rewriteResult?.prompt ?? null,
      settings: {
        referenceImageCount: input.references.length,
        temperature: 0.2,
        maxOutputTokens: 400,
        targetModel: input.imageModel,
      },
      outputDir: path.dirname(logFile),
      outputPaths: [],
      keyframeId: null,
      shotId: input.shotId,
      frameType: input.frameType,
      promptId: null,
      artifactType: 'storyboard',
      artifactId: input.storyboardImageId,
      logFile,
      references: input.references,
      usage: rewriteResult?.usage ?? null,
      providerMetadata: rewriteResult?.providerMetadata,
      finishReason: rewriteResult?.finishReason ?? null,
      rawFinishReason: rewriteResult?.rawFinishReason ?? null,
      responseId: rewriteResult?.responseId ?? null,
      metadata: {
        rewriteKind: 'flux-klein-storyboard',
        storyboardImageId: input.storyboardImageId,
        regenerateRequest: input.regenerateRequest?.trim() || null,
      },
      error: errorDetails,
    })
  }
}
