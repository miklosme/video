import arg from 'arg'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import OpenAI from 'openai'
import { FRAME_TYPES, type FrameType, type GenerationLogEntry } from './workflow-data'

export interface GenerateImagenOptionsInput {
  prompt: string
  model?: string
  n?: number
  aspectRatio?: string
  safetyFilterLevel?: string
  outputDir?: string
  namePrefix?: string
  shotId?: string
  frameType?: FrameType
  promptId?: string
  logFile?: string
}

export interface GenerateImagenOptionsResult {
  generationId: string
  outputPaths: string[]
}

function resolvePath(maybeRelativePath: string) {
  return path.resolve(process.cwd(), maybeRelativePath)
}

function resolveDefaultLogFile() {
  return path.resolve(process.cwd(), 'workspace', 'GENERATION-LOG.jsonl')
}

async function appendGenerationLog(entry: GenerationLogEntry) {
  await mkdir(path.dirname(entry.logFile), { recursive: true })
  await appendFile(entry.logFile, `${JSON.stringify(entry)}\n`, 'utf8')
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
  const model = input.model ?? 'google/imagen-4.0-fast-generate-001'
  const imageCount = input.n ?? 1
  const aspectRatio = input.aspectRatio ?? '16:9'
  const safetyFilterLevel = input.safetyFilterLevel ?? 'OFF'
  const outputDir = resolvePath(input.outputDir ?? 'output')
  const logFile = input.logFile ? resolvePath(input.logFile) : resolveDefaultLogFile()
  const namePrefix = input.namePrefix ? `${input.namePrefix}-` : ''
  const createdAtPrefix = startedAt.replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
  const outputPaths: string[] = []

  const openai = new OpenAI({
    apiKey: process.env.AI_GATEWAY_API_KEY,
    baseURL: 'https://ai-gateway.vercel.sh/v1',
  })

  let completedAt: string | null = null
  let errorDetails: GenerationLogEntry['error'] = null

  try {
    const result = await openai.images.generate({
      model,
      prompt,
      n: imageCount,
      providerOptions: {
        googleVertex: {
          aspectRatio,
          safetyFilterLevel,
        },
      },
    } as any)

    await mkdir(outputDir, { recursive: true })

    for (const [index, image] of (result.data ?? []).entries()) {
      if (!image.b64_json) {
        continue
      }

      const outputPath = path.join(
        outputDir,
        `${namePrefix}${createdAtPrefix}-imagen-option-${index + 1}.png`,
      )
      const imageBuffer = Buffer.from(image.b64_json, 'base64')

      await writeFile(outputPath, imageBuffer)
      outputPaths.push(outputPath)
    }

    completedAt = new Date().toISOString()
    return {
      generationId,
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
      shotId: input.shotId ?? null,
      frameType: input.frameType ?? null,
      promptId: input.promptId ?? null,
      logFile,
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
    shotId: args['--shot-id'],
    frameType: frameType as FrameType | undefined,
    promptId: args['--prompt-id'],
    logFile: args['--log-file'],
  }
}

async function main() {
  const result = await generateImagenOptions(parseArgs())

  if (result.outputPaths.length > 0) {
    console.log(result.outputPaths.join('\n'))
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
