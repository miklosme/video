import { Output, createGateway, generateText } from 'ai'
import arg from 'arg'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

const DEFAULT_MODEL = 'openai/gpt-5.4-mini'
const DEFAULT_STORYBOARD_PATH_CANDIDATES = [
  'workspace/STORYBOARD/STORYBOARD.json',
  'workspace/STORYBOARD.json',
] as const

const CameraSchema = z.object({
  shotSize: z.string(),
  cameraPosition: z.string(),
  cameraAngle: z.string(),
})

const StoryboardEntrySchema = z.object({
  frameType: z.string(),
  prompt: z.string(),
  camera: CameraSchema.optional(),
  imagePath: z.string().nullable(),
})

const StoryboardSchema = z.object({
  images: z.array(StoryboardEntrySchema),
})

const PromptOutputSchema = z.object({
  prompt: z.string().min(1),
})

const SYSTEM_PROMPT = [
  'You reconstruct concise storyboard prompt fields from storyboard images.',
  'Return only the requested JSON object.',
  'Do not add markdown, explanations, or extra keys.',
  'Keep prompts grounded in visible scene facts and the house style guidance.',
].join(' ')

export interface RecoverStoryboardPromptsArgs {
  input?: string
  output?: string
  model?: string
  limit?: number
  cwd?: string
}

export interface PromptPair {
  imagePath: string
  prompt: string
}

export interface PromptPairsDocument {
  generatedAt: string
  model: string
  storyboardPath: string
  pairs: PromptPair[]
}

function createGatewayProvider() {
  const apiKey = process.env.AI_GATEWAY_API_KEY

  if (!apiKey) {
    throw new Error('AI_GATEWAY_API_KEY is required to recover storyboard prompts.')
  }

  return createGateway({ apiKey })
}

async function fileExists(filePath: string) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function resolvePath(maybeRelativePath: string, cwd = process.cwd()) {
  return path.isAbsolute(maybeRelativePath)
    ? maybeRelativePath
    : path.resolve(cwd, maybeRelativePath)
}

export function getDefaultOutputPath(storyboardPath: string) {
  return path.join(path.dirname(storyboardPath), 'STORYBOOK.fixed.json')
}

function findWorkspaceRootFromStoryboardPath(storyboardPath: string) {
  const workspaceSegment = `${path.sep}workspace${path.sep}`
  const markerIndex = storyboardPath.lastIndexOf(workspaceSegment)

  if (markerIndex === -1) {
    return null
  }

  return storyboardPath.slice(0, markerIndex)
}

export function getImagePathCandidates(
  imagePath: string,
  storyboardPath: string,
  cwd = process.cwd(),
) {
  if (path.isAbsolute(imagePath)) {
    return [imagePath]
  }

  const workspaceRoot = findWorkspaceRootFromStoryboardPath(storyboardPath)
  const normalizedImagePath = imagePath.replaceAll('\\', '/')
  const candidates = [
    path.resolve(cwd, imagePath),
    workspaceRoot ? path.resolve(workspaceRoot, imagePath) : null,
    normalizedImagePath.startsWith('workspace/') || normalizedImagePath.startsWith('projects/')
      ? null
      : path.resolve(path.dirname(storyboardPath), imagePath),
  ].filter((candidate): candidate is string => candidate !== null)

  return [...new Set(candidates)]
}

async function resolveStoryboardPath(inputPath: string | undefined, cwd = process.cwd()) {
  if (inputPath) {
    const resolvedInputPath = resolvePath(inputPath, cwd)

    if (!(await fileExists(resolvedInputPath))) {
      throw new Error(`Storyboard file not found: ${resolvedInputPath}`)
    }

    return resolvedInputPath
  }

  for (const candidate of DEFAULT_STORYBOARD_PATH_CANDIDATES) {
    const resolvedCandidate = path.resolve(cwd, candidate)

    if (await fileExists(resolvedCandidate)) {
      return resolvedCandidate
    }
  }

  throw new Error(
    `Could not find a storyboard sidecar. Checked: ${DEFAULT_STORYBOARD_PATH_CANDIDATES.join(', ')}.`,
  )
}

async function resolveImagePath(imagePath: string, storyboardPath: string, cwd = process.cwd()) {
  for (const candidate of getImagePathCandidates(imagePath, storyboardPath, cwd)) {
    if (await fileExists(candidate)) {
      return candidate
    }
  }

  throw new Error(`Image file not found for ${imagePath}.`)
}

function getImageMediaType(imagePath: string) {
  const extension = path.extname(imagePath).toLowerCase()

  switch (extension) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    default:
      return 'image/png'
  }
}

function formatCameraHint(camera: z.infer<typeof CameraSchema> | undefined) {
  if (!camera) {
    return null
  }

  return `Camera metadata from JSON. Use only as framing context, not text to copy: shotSize=${camera.shotSize}, cameraPosition=${camera.cameraPosition}, cameraAngle=${camera.cameraAngle}.`
}

export function normalizeRecoveredPrompt(value: string) {
  let nextValue = value.trim()

  if (
    (nextValue.startsWith('"') && nextValue.endsWith('"')) ||
    (nextValue.startsWith("'") && nextValue.endsWith("'"))
  ) {
    nextValue = nextValue.slice(1, -1).trim()
  }

  return nextValue.replace(/\s+/g, ' ')
}

export function buildPromptRecoveryRequest(entry: z.infer<typeof StoryboardEntrySchema>) {
  const lines = [
    'Write the correct storyboard prompt for the attached image.',
    'Match the style of the existing storyboard prompt field, not the literal image-generation prompt.',
    'Keep it concise and concrete: 1 to 3 short declarative sentences.',
    'Describe visible setting, subjects, action, major props, and obvious background details.',
    'Do not mention storyboard medium, sketch treatment, grayscale, or camera jargon unless truly necessary.',
    'If something is unclear, stay general instead of inventing detail.',
    `Frame type from JSON: ${entry.frameType}.`,
    `Original prompt from JSON. Use only as terminology and style reference, not as ground truth if the image contradicts it: ${entry.prompt}`,
  ]

  const cameraHint = formatCameraHint(entry.camera)

  if (cameraHint) {
    lines.push(cameraHint)
  }

  lines.push('Return JSON with this shape: {"prompt":"..."}')

  return lines.join('\n')
}

async function loadStoryboard(storyboardPath: string) {
  const rawStoryboard = await readFile(storyboardPath, 'utf8')
  return StoryboardSchema.parse(JSON.parse(rawStoryboard))
}

async function recoverPromptForEntry(input: {
  entry: z.infer<typeof StoryboardEntrySchema>
  storyboardPath: string
  model: string
  cwd?: string
}) {
  if (!input.entry.imagePath) {
    return null
  }

  const resolvedImagePath = await resolveImagePath(
    input.entry.imagePath,
    input.storyboardPath,
    input.cwd,
  )
  const imageData = await readFile(resolvedImagePath)
  const gateway = createGatewayProvider()
  const result = await generateText({
    model: gateway.languageModel(input.model),
    output: Output.object({
      schema: PromptOutputSchema,
    }),
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: buildPromptRecoveryRequest(input.entry),
          },
          {
            type: 'image',
            image: imageData,
            mediaType: getImageMediaType(resolvedImagePath),
          },
        ],
      },
    ],
  })

  return {
    imagePath: input.entry.imagePath,
    prompt: normalizeRecoveredPrompt(result.output.prompt),
  } satisfies PromptPair
}

export async function recoverStoryboardPrompts(
  input: RecoverStoryboardPromptsArgs = {},
): Promise<PromptPairsDocument> {
  const cwd = input.cwd ?? process.cwd()
  const storyboardPath = await resolveStoryboardPath(input.input, cwd)
  const storyboard = await loadStoryboard(storyboardPath)
  const model = input.model ?? DEFAULT_MODEL
  const pairs: PromptPair[] = []
  const entries =
    input.limit && input.limit > 0 ? storyboard.images.slice(0, input.limit) : storyboard.images

  for (const [index, entry] of entries.entries()) {
    if (!entry.imagePath) {
      console.error(`[${index + 1}/${entries.length}] Skipping entry with null imagePath.`)
      continue
    }

    console.error(`[${index + 1}/${entries.length}] Recovering prompt for ${entry.imagePath}`)
    const recoveredPair = await recoverPromptForEntry({
      entry,
      storyboardPath,
      model,
      cwd,
    })

    if (recoveredPair) {
      pairs.push(recoveredPair)
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    model,
    storyboardPath: path.relative(cwd, storyboardPath) || storyboardPath,
    pairs,
  }
}

function parseArgs() {
  const args = arg({
    '--input': String,
    '--output': String,
    '--model': String,
    '--limit': Number,
    '-i': '--input',
    '-o': '--output',
    '-m': '--model',
    '-n': '--limit',
  })

  const limit = args['--limit']

  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error('Invalid --limit value. Expected a positive integer.')
  }

  return {
    input: args['--input'],
    output: args['--output'],
    model: args['--model'],
    limit,
  } satisfies RecoverStoryboardPromptsArgs
}

async function main() {
  const args = parseArgs()
  const cwd = process.cwd()
  const storyboardPath = await resolveStoryboardPath(args.input, cwd)
  const result = await recoverStoryboardPrompts({
    ...args,
    input: storyboardPath,
    cwd,
  })
  const json = `${JSON.stringify(result, null, 2)}\n`
  const resolvedOutputPath = args.output
    ? resolvePath(args.output, cwd)
    : getDefaultOutputPath(storyboardPath)

  await mkdir(path.dirname(resolvedOutputPath), { recursive: true })
  await writeFile(resolvedOutputPath, json, 'utf8')
  console.error(`Wrote prompt pairs to ${resolvedOutputPath}`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
