import { createGateway, generateImage, generateText } from 'ai'
import arg from 'arg'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  FRAME_TYPES,
  type FrameType,
  type GenerationLogEntry,
  type GenerationReferenceEntry,
} from './workflow-data'

const DEFAULT_IMAGE_MODEL = 'google/gemini-3.1-flash-image-preview'

export const REFERENCE_CAPABLE_IMAGE_MODELS = [
  'google/gemini-3.1-flash-image-preview',
  'google/gemini-3-pro-image',
  'bfl/flux-kontext-pro',
  'bfl/flux-kontext-max',
] as const

const REFERENCE_CAPABLE_IMAGE_MODEL_SET = new Set<string>(REFERENCE_CAPABLE_IMAGE_MODELS)
const IMAGE_ONLY_MODELS = new Set<string>(['bfl/flux-kontext-pro', 'bfl/flux-kontext-max'])
const LANGUAGE_IMAGE_MODELS = new Set<string>([
  'google/gemini-3.1-flash-image-preview',
  'google/gemini-3-pro-image',
])

export interface GenerateImagenOptionsInput {
  prompt: string
  model?: string
  n?: number
  aspectRatio?: string
  safetyFilterLevel?: string
  outputDir?: string
  outputPath?: string
  namePrefix?: string
  keyframeId?: string
  shotId?: string
  frameType?: FrameType
  promptId?: string
  logFile?: string
  references?: GenerationReferenceEntry[]
}

export interface GenerateImagenOptionsResult {
  generationId: string
  model: string
  outputPaths: string[]
}

function resolvePath(maybeRelativePath: string) {
  return path.resolve(process.cwd(), maybeRelativePath)
}

function resolveDefaultLogFile() {
  return path.resolve(process.cwd(), 'workspace', 'GENERATION-LOG.jsonl')
}

function createGatewayProvider() {
  const apiKey = process.env.AI_GATEWAY_API_KEY

  if (!apiKey) {
    throw new Error('AI_GATEWAY_API_KEY is required for still-image generation.')
  }

  return createGateway({ apiKey })
}

function assertSupportedStillImageModel(model: string) {
  if (REFERENCE_CAPABLE_IMAGE_MODEL_SET.has(model)) {
    return
  }

  throw new Error(
    `Unsupported still-image model "${model}". Expected one of: ${REFERENCE_CAPABLE_IMAGE_MODELS.join(', ')}.`,
  )
}

function mediaTypeToExtension(mediaType: string | undefined) {
  switch (mediaType) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    default:
      return 'png'
  }
}

function buildPromptText(
  prompt: string,
  references: GenerationReferenceEntry[],
  aspectRatio: string,
  model: string,
) {
  const promptLines = [prompt]

  if (references.length > 0) {
    const characterReferenceCount = references.filter(
      (reference) => reference.kind === 'character-sheet',
    ).length
    const hasStartFrameReference = references.some((reference) => reference.kind === 'start-frame')

    promptLines.push('')
    promptLines.push('Use the attached reference images to preserve visual consistency.')

    if (characterReferenceCount > 0) {
      promptLines.push(
        `Character identity references attached: ${characterReferenceCount}. Keep the same subject identity, markings, and silhouette.`,
      )
    }

    if (hasStartFrameReference) {
      promptLines.push(
        'A same-shot start frame reference is attached. Match its continuity for composition, setting, and subject identity while rendering the requested end beat.',
      )
    }
  }

  if (LANGUAGE_IMAGE_MODELS.has(model)) {
    promptLines.push(`Target aspect ratio: ${aspectRatio}.`)
  }

  return promptLines.join('\n')
}

async function appendGenerationLog(entry: GenerationLogEntry) {
  await mkdir(path.dirname(entry.logFile), { recursive: true })
  await appendFile(entry.logFile, `${JSON.stringify(entry)}\n`, 'utf8')
}

async function loadReferenceImages(references: GenerationReferenceEntry[]) {
  return Promise.all(
    references.map(async (reference) => ({
      ...reference,
      data: await readFile(resolvePath(reference.path)),
    })),
  )
}

async function generateImagesWithGateway(input: {
  prompt: string
  model: string
  n: number
  aspectRatio: string
  safetyFilterLevel: string
  references: GenerationReferenceEntry[]
}) {
  const gateway = createGatewayProvider()
  const promptText = buildPromptText(input.prompt, input.references, input.aspectRatio, input.model)
  const loadedReferences = await loadReferenceImages(input.references)

  if (IMAGE_ONLY_MODELS.has(input.model)) {
    const result = await generateImage({
      model: gateway.imageModel(input.model),
      prompt:
        loadedReferences.length === 0
          ? promptText
          : {
              text: promptText,
              images: loadedReferences.map((reference) => reference.data),
            },
      n: input.n,
      aspectRatio: input.aspectRatio as `${number}:${number}`,
    })

    return result.images.map((image) => ({
      data: image.uint8Array,
      mediaType: image.mediaType,
    }))
  }

  if (LANGUAGE_IMAGE_MODELS.has(input.model)) {
    const result = await generateText({
      model: gateway.languageModel(input.model),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: promptText },
            ...loadedReferences.map((reference) => ({
              type: 'image' as const,
              image: reference.data,
              mediaType: 'image/png',
            })),
          ],
          providerOptions:
            input.safetyFilterLevel === 'OFF'
              ? undefined
              : ({
                  google: {
                    safetyFilterLevel: input.safetyFilterLevel,
                  },
                } as any),
        },
      ],
    })

    const generatedImages = (result.files ?? []).filter((file) =>
      file.mediaType.startsWith('image/'),
    )

    if (generatedImages.length === 0) {
      throw new Error(`Model "${input.model}" did not return any images.`)
    }

    return generatedImages.map((file) => ({
      data: file.uint8Array,
      mediaType: file.mediaType,
    }))
  }

  throw new Error(`Unsupported still-image model "${input.model}".`)
}

export async function generateImagenOptions(
  input: GenerateImagenOptionsInput,
): Promise<GenerateImagenOptionsResult> {
  const prompt = input.prompt

  if (!prompt) {
    throw new Error('Missing required prompt.')
  }

  const generationId = randomUUID()
  const startedAt = new Date().toISOString()
  const model = input.model ?? DEFAULT_IMAGE_MODEL
  const imageCount = input.n ?? 1
  const aspectRatio = input.aspectRatio ?? '16:9'
  const safetyFilterLevel = input.safetyFilterLevel ?? 'OFF'
  const references = input.references ?? []
  const explicitOutputPath = input.outputPath ? resolvePath(input.outputPath) : null
  const outputDir = explicitOutputPath
    ? path.dirname(explicitOutputPath)
    : resolvePath(input.outputDir ?? 'output')
  const logFile = input.logFile ? resolvePath(input.logFile) : resolveDefaultLogFile()
  const namePrefix = input.namePrefix ? `${input.namePrefix}-` : ''
  const createdAtPrefix = startedAt.replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
  const outputPaths: string[] = []

  assertSupportedStillImageModel(model)

  let completedAt: string | null = null
  let errorDetails: GenerationLogEntry['error'] = null

  try {
    const generatedImages = await generateImagesWithGateway({
      prompt,
      model,
      n: imageCount,
      aspectRatio,
      safetyFilterLevel,
      references,
    })

    await mkdir(outputDir, { recursive: true })

    for (const [index, image] of generatedImages.entries()) {
      const outputPath =
        explicitOutputPath ??
        path.join(
          outputDir,
          `${namePrefix}${createdAtPrefix}-imagen-option-${index + 1}.${mediaTypeToExtension(image.mediaType)}`,
        )

      await writeFile(outputPath, image.data)
      outputPaths.push(outputPath)
    }

    completedAt = new Date().toISOString()
    return {
      generationId,
      model,
      outputPaths,
    }
  } catch (error) {
    completedAt = new Date().toISOString()
    errorDetails = {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    }
    throw error
  } finally {
    await appendGenerationLog({
      generationId,
      startedAt,
      completedAt,
      status: errorDetails ? 'error' : 'success',
      model,
      prompt,
      settings: {
        imageCount,
        aspectRatio,
        safetyFilterLevel,
      },
      outputDir,
      outputPaths,
      keyframeId: input.keyframeId ?? null,
      shotId: input.shotId ?? null,
      frameType: input.frameType ?? null,
      promptId: input.promptId ?? null,
      logFile,
      references,
      error: errorDetails,
    })
  }
}

function parseArgs() {
  const args = arg({
    '--prompt': String,
    '--model': String,
    '--n': Number,
    '--aspect-ratio': String,
    '--safety-filter-level': String,
    '--output-dir': String,
    '--name-prefix': String,
    '--keyframe-id': String,
    '--shot-id': String,
    '--frame-type': String,
    '--prompt-id': String,
    '--log-file': String,
    '-p': '--prompt',
    '-m': '--model',
    '-n': '--n',
  })

  const prompt = args['--prompt']
  const frameType = args['--frame-type']

  if (!prompt) {
    throw new Error('Missing required --prompt option.')
  }

  if (frameType && !FRAME_TYPES.includes(frameType as FrameType)) {
    throw new Error(
      `Invalid --frame-type "${frameType}". Expected one of: ${FRAME_TYPES.join(', ')}.`,
    )
  }

  return {
    prompt,
    model: args['--model'],
    n: args['--n'],
    aspectRatio: args['--aspect-ratio'],
    safetyFilterLevel: args['--safety-filter-level'],
    outputDir: args['--output-dir'],
    namePrefix: args['--name-prefix'],
    keyframeId: args['--keyframe-id'],
    shotId: args['--shot-id'],
    frameType: frameType as FrameType | undefined,
    promptId: args['--prompt-id'],
    logFile: args['--log-file'],
  }
}

async function main() {
  const result = await generateImagenOptions(parseArgs())

  if (result.outputPaths.length > 0) {
    console.log(
      result.outputPaths
        .map((outputPath) => `Generated ${outputPath} with model ${result.model}`)
        .join('\n'),
    )
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
