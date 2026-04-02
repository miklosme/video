import { createGateway, experimental_generateVideo as generateVideo } from 'ai'
import arg from 'arg'
import { randomUUID } from 'node:crypto'
import { access, appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  getShotArtifactDescriptor,
  getVersionSeed,
  prepareStagedArtifactVersion,
  recordArtifactVersionFromStage,
  resolveShotGenerationAssets,
} from './artifact-control'
import { captureWorkflowEvent, shutdownPostHog } from './posthog'
import {
  loadCharacterSheets,
  loadConfig,
  loadKeyframes,
  loadShotArtifacts,
  loadShotPrompts,
  type ArtifactReferenceEntry,
  type CharacterSheetEntry,
  type GenerationLogEntry,
  type KeyframeEntry,
  type ShotArtifactEntry,
  type ShotEntry,
} from './workflow-data'

const DEFAULT_VIDEO_ASPECT_RATIO = '16:9'

interface GenerateShotsArgs {
  shotId?: string
  firstOnly: boolean
}

export interface PendingShotGeneration {
  shotId: string
  model: string
  prompt: string
  outputPath: string
  keyframeIds: string[]
  durationSeconds: number
  userReferences?: ArtifactReferenceEntry[]
}

export interface PlannedShotGenerationAssets {
  inputImagePath: string
  lastFramePath: string | null
  characterIds: string[]
  referenceImagePaths: string[]
  references: ReturnType<typeof resolveShotGenerationAssets>['references']
}

export interface GenerateShotVideoInput {
  shotId: string
  model: string
  prompt: string
  inputImagePath: string
  lastFramePath: string | null
  referenceImagePaths: string[]
  durationSeconds: number
  seed?: number
  cwd?: string
}

export interface GenerateShotVideoResult {
  data: Uint8Array
  mediaType: string | undefined
}

export interface ShotGenerationSummary {
  generatedCount: number
  skippedCount: number
}

export type ShotVideoGenerator = (input: GenerateShotVideoInput) => Promise<GenerateShotVideoResult>

function resolvePath(maybeRelativePath: string, cwd = process.cwd()) {
  return path.resolve(cwd, maybeRelativePath)
}

function selectPlannedShotsForGeneration(
  shots: ShotEntry[],
  filters: Pick<GenerateShotsArgs, 'shotId'> = {},
) {
  return shots.filter((entry) => !filters.shotId || entry.shotId === filters.shotId)
}

function buildMissingShotSidecarError(missingShots: ReadonlyArray<Pick<ShotEntry, 'shotId'>>) {
  const missingLines = missingShots.map((entry) => {
    const descriptor = getShotArtifactDescriptor(entry.shotId)
    return `- ${entry.shotId}: ${descriptor.sidecarPath}`
  })

  return [
    'Planned shots are missing generation sidecars in workspace/SHOTS/.',
    'Missing sidecars:',
    ...missingLines,
    'Write the missing shot prompt sidecars before running bun run generate:shots.',
  ].join('\n')
}

function buildEmptyShotGenerationError(
  shots: ShotEntry[],
  shotArtifacts: ShotArtifactEntry[],
  filters: Pick<GenerateShotsArgs, 'shotId'> = {},
) {
  const plannedShots = selectPlannedShotsForGeneration(shots, filters)

  if (plannedShots.length === 0) {
    if (filters.shotId) {
      return shots.some((entry) => entry.shotId === filters.shotId)
        ? `Shot "${filters.shotId}" is present but not planned for generation in workspace/SHOTS.json.`
        : `No planned shot matched shot "${filters.shotId}" in workspace/SHOTS.json.`
    }

    return 'workspace/SHOTS.json has no planned shots.'
  }

  const artifactIds = new Set(shotArtifacts.map((entry) => entry.shotId))
  const missingShots = plannedShots.filter((entry) => !artifactIds.has(entry.shotId))

  if (missingShots.length > 0) {
    return buildMissingShotSidecarError(missingShots)
  }

  return `No shot artifact matched${
    filters.shotId ? ` shot ${filters.shotId}` : ' the provided filters'
  }.`
}

function resolveDefaultLogFile(cwd = process.cwd()) {
  return path.resolve(cwd, 'workspace', 'GENERATION-LOG.jsonl')
}

function createGatewayProvider() {
  const apiKey = process.env.AI_GATEWAY_API_KEY

  if (!apiKey) {
    throw new Error('AI_GATEWAY_API_KEY is required for video generation.')
  }

  return createGateway({ apiKey })
}

function parseArgs(): GenerateShotsArgs {
  const args = arg({
    '--shot-id': String,
    '--first-only': Boolean,
  })

  return {
    shotId: args['--shot-id'],
    firstOnly: args['--first-only'] ?? false,
  }
}

async function fileExists(filePath: string) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function imageMimeTypeForPath(filePath: string) {
  const extension = path.extname(filePath).toLowerCase()

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

async function encodeGoogleImageFile(filePath: string, cwd = process.cwd()) {
  const data = await readFile(resolvePath(filePath, cwd))

  return {
    mimeType: imageMimeTypeForPath(filePath),
    bytesBase64Encoded: Buffer.from(data).toString('base64'),
  }
}

async function appendGenerationLog(entry: GenerationLogEntry) {
  await mkdir(path.dirname(entry.logFile), { recursive: true })
  await appendFile(entry.logFile, `${JSON.stringify(entry)}\n`, 'utf8')
}

export function selectPendingShotGenerations(
  shots: ShotEntry[],
  artifacts: ShotArtifactEntry[],
  filters: Pick<GenerateShotsArgs, 'shotId'> = {},
) {
  const artifactById = new Map(artifacts.map((entry) => [entry.shotId, entry]))

  return shots
    .filter((entry) => !filters.shotId || entry.shotId === filters.shotId)
    .filter((entry) => artifactById.has(entry.shotId))
    .map<PendingShotGeneration>((entry) => {
      const artifact = artifactById.get(entry.shotId)

      if (!artifact) {
        throw new Error(`Missing shot artifact for "${entry.shotId}".`)
      }

      return {
        shotId: entry.shotId,
        model: artifact.model,
        prompt: artifact.prompt,
        outputPath: entry.videoPath,
        keyframeIds: entry.keyframeIds,
        durationSeconds: entry.durationSeconds,
        userReferences: artifact.references,
      }
    })
}

export function planShotGenerationAssets(
  generation: PendingShotGeneration,
  keyframes: KeyframeEntry[],
  options: {
    userReferences?: readonly ArtifactReferenceEntry[]
  } = {},
): PlannedShotGenerationAssets {
  const resolvedAssets = resolveShotGenerationAssets(generation, keyframes, {
    userReferences: options.userReferences ?? generation.userReferences ?? [],
  })

  return {
    inputImagePath: resolvedAssets.inputImagePath,
    lastFramePath: resolvedAssets.lastFramePath,
    characterIds: resolvedAssets.characterIds,
    referenceImagePaths: resolvedAssets.referenceImagePaths,
    references: resolvedAssets.references,
  }
}

async function assertReferenceFilesExist(
  assets: PlannedShotGenerationAssets,
  generation: PendingShotGeneration,
  cwd = process.cwd(),
) {
  const requiredPaths = [
    { kind: 'input frame', path: assets.inputImagePath },
    ...(assets.lastFramePath ? [{ kind: 'end frame', path: assets.lastFramePath }] : []),
    ...assets.referenceImagePaths.map((referencePath) => ({
      kind: 'reference image',
      path: referencePath,
    })),
  ]

  for (const reference of requiredPaths) {
    if (await fileExists(resolvePath(reference.path, cwd))) {
      continue
    }

    throw new Error(
      `Cannot generate ${generation.shotId}; required ${reference.kind} reference is missing at ${reference.path}.`,
    )
  }
}

function assertCharacterSidecarsExist(
  referenceImagePaths: string[],
  characterSheets: CharacterSheetEntry[],
  shotId: string,
) {
  const knownCharacters = new Set(characterSheets.map((entry) => entry.characterId))

  for (const referencePath of referenceImagePaths) {
    if (!referencePath.startsWith('workspace/CHARACTERS/')) {
      continue
    }

    const characterId = path.posix.basename(referencePath, path.posix.extname(referencePath))

    if (!knownCharacters.has(characterId)) {
      throw new Error(
        `Shot "${shotId}" references missing character sheet sidecar "${characterId}" in workspace/CHARACTERS/.`,
      )
    }
  }
}

export async function generateShotVideoWithGateway(
  input: GenerateShotVideoInput,
): Promise<GenerateShotVideoResult> {
  const gateway = createGatewayProvider()
  const inputImage = await readFile(resolvePath(input.inputImagePath, input.cwd))
  const referenceImages = await Promise.all(
    input.referenceImagePaths.map(async (referencePath) => ({
      image: await encodeGoogleImageFile(referencePath, input.cwd),
      referenceType: 'asset',
    })),
  )
  const lastFrame = input.lastFramePath
    ? await encodeGoogleImageFile(input.lastFramePath, input.cwd)
    : null
  const providerOptions =
    referenceImages.length > 0 || lastFrame
      ? ({
          google: {
            ...(lastFrame ? { lastFrame } : {}),
            ...(referenceImages.length > 0
              ? {
                  referenceImages,
                  personGeneration: 'allow_adult',
                }
              : {}),
          },
        } as const)
      : undefined

  const { video } = await generateVideo({
    model: gateway.videoModel(input.model),
    prompt: {
      text: input.prompt,
      image: inputImage,
    },
    aspectRatio: DEFAULT_VIDEO_ASPECT_RATIO,
    duration: input.durationSeconds,
    seed: input.seed,
    ...(providerOptions ? { providerOptions } : {}),
  })

  return {
    data: video.uint8Array,
    mediaType: video.mediaType,
  }
}

function buildShotRegeneratePrompt(prompt: string, regenerateRequest?: string | null) {
  if (!regenerateRequest) {
    return prompt
  }

  return [
    prompt,
    '',
    'Approved change:',
    regenerateRequest,
    '',
    'Apply only this approved change while preserving the rest of the current shot intent unless the edit explicitly asks for broader changes.',
  ].join('\n')
}

export async function runShotGeneration(
  generation: PendingShotGeneration,
  keyframes: KeyframeEntry[],
  characterSheets: CharacterSheetEntry[],
  options: {
    generator?: ShotVideoGenerator
    logFile?: string
    cwd?: string
    firstOnly?: boolean
    regenerateRequest?: string | null
    userReferences?: readonly ArtifactReferenceEntry[]
    outputPath?: string
    seed?: number
  } = {},
) {
  const generator = options.generator ?? generateShotVideoWithGateway
  const cwd = options.cwd ?? process.cwd()
  const logFile = options.logFile ? resolvePath(options.logFile, cwd) : resolveDefaultLogFile(cwd)
  const outputPath = options.outputPath ?? generation.outputPath
  const absoluteOutputPath = resolvePath(outputPath, cwd)
  const assets = resolveShotGenerationAssets(generation, keyframes, {
    userReferences: options.userReferences ?? generation.userReferences ?? [],
  })

  assertCharacterSidecarsExist(assets.referenceImagePaths, characterSheets, generation.shotId)
  await assertReferenceFilesExist(
    {
      inputImagePath: assets.inputImagePath,
      lastFramePath: assets.lastFramePath,
      characterIds: assets.characterIds,
      referenceImagePaths: assets.referenceImagePaths,
      references: assets.references,
    },
    generation,
    cwd,
  )

  console.log(`Generating ${generation.shotId} with model ${generation.model} -> ${outputPath}`)

  const generationId = randomUUID()
  const startedAt = new Date().toISOString()
  const outputPaths: string[] = []
  let completedAt: string | null = null
  let errorDetails: GenerationLogEntry['error'] = null
  // Shot regeneration still reuses the original shot prompt because the current
  // video path supports image-to-video anchoring, not a selected video baseline.
  const prompt = buildShotRegeneratePrompt(generation.prompt, options.regenerateRequest)

  try {
    const result = await generator({
      shotId: generation.shotId,
      model: generation.model,
      prompt,
      inputImagePath: assets.inputImagePath,
      lastFramePath: assets.lastFramePath,
      referenceImagePaths: assets.referenceImagePaths,
      durationSeconds: generation.durationSeconds,
      seed: options.seed,
      cwd,
    })

    await mkdir(path.dirname(absoluteOutputPath), { recursive: true })
    await writeFile(absoluteOutputPath, result.data)
    outputPaths.push(absoluteOutputPath)
    completedAt = new Date().toISOString()
    captureWorkflowEvent('shot_generated', {
      shotId: generation.shotId,
      model: generation.model,
    })
  } catch (error) {
    completedAt = new Date().toISOString()
    errorDetails = {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    }
    captureWorkflowEvent('shot_generation_failed', {
      shotId: generation.shotId,
      model: generation.model,
      error: errorDetails.message,
    })
    throw error
  } finally {
    await appendGenerationLog({
      generationId,
      startedAt,
      completedAt,
      status: errorDetails ? 'error' : 'success',
      model: generation.model,
      prompt,
      settings: {
        videoCount: 1,
        seed: options.seed,
        aspectRatio: DEFAULT_VIDEO_ASPECT_RATIO,
        durationSeconds: generation.durationSeconds,
        referenceImageCount: assets.referenceImagePaths.length,
      },
      outputDir: path.dirname(absoluteOutputPath),
      outputPaths,
      keyframeId: null,
      shotId: generation.shotId,
      frameType: null,
      promptId: null,
      artifactType: 'shot',
      artifactId: generation.shotId,
      logFile,
      references: assets.references,
      error: errorDetails,
    })
  }

  return {
    generationId,
    prompt,
    references: assets.references,
    resolvedReferences: assets.resolvedReferences,
    droppedReferences: assets.droppedReferences,
    outputPath,
    completedAt,
  }
}

export async function generateShotArtifactVersion(
  generation: PendingShotGeneration,
  keyframes: KeyframeEntry[],
  characterSheets: CharacterSheetEntry[],
  options: {
    generator?: ShotVideoGenerator
    logFile?: string
    cwd?: string
    regenerateRequest?: string | null
    userReferences?: readonly ArtifactReferenceEntry[]
    baseVersionId?: string | null
    seed?: number
    autoSelect?: boolean
  } = {},
) {
  const descriptor = getShotArtifactDescriptor(generation.shotId)
  const cwd = options.cwd ?? process.cwd()
  const stagedVersion = await prepareStagedArtifactVersion(descriptor, cwd)
  const seed = options.seed ?? getVersionSeed(stagedVersion.versionId)

  try {
    const result = await runShotGeneration(generation, keyframes, characterSheets, {
      generator: options.generator,
      logFile: options.logFile,
      cwd,
      regenerateRequest: options.regenerateRequest,
      userReferences: options.userReferences,
      outputPath: stagedVersion.stagedPath,
      seed: seed ?? undefined,
    })
    const recorded = await recordArtifactVersionFromStage({
      descriptor,
      stagedPath: stagedVersion.stagedPath,
      autoSelect: options.autoSelect,
      cwd,
    })

    return {
      ...result,
      descriptor,
      seed,
      versionId: recorded.versionId,
    }
  } catch (error) {
    await rm(path.resolve(cwd, stagedVersion.stagedPath), { force: true }).catch(() => undefined)
    throw error
  }
}

export async function regenerateShotArtifactVersion(
  generation: PendingShotGeneration,
  keyframes: KeyframeEntry[],
  characterSheets: CharacterSheetEntry[],
  options: {
    generator?: ShotVideoGenerator
    logFile?: string
    cwd?: string
    regenerateRequest?: string | null
    userReferences?: readonly ArtifactReferenceEntry[]
    baseVersionId?: string | null
    seed?: number
    autoSelect?: boolean
  } = {},
) {
  return generateShotArtifactVersion(generation, keyframes, characterSheets, options)
}

export async function syncShotGenerations(
  plannedGenerations: PendingShotGeneration[],
  keyframes: KeyframeEntry[],
  characterSheets: CharacterSheetEntry[],
  options: {
    firstOnly?: boolean
    generator?: ShotVideoGenerator
    logFile?: string
    cwd?: string
    variantCount?: number
  } = {},
): Promise<ShotGenerationSummary> {
  const generator = options.generator ?? generateShotVideoWithGateway
  const cwd = options.cwd ?? process.cwd()
  const logFile = options.logFile ? resolvePath(options.logFile, cwd) : resolveDefaultLogFile(cwd)
  let generatedCount = 0
  let skippedCount = 0

  for (const generation of plannedGenerations) {
    const absoluteOutputPath = resolvePath(generation.outputPath, cwd)

    if (await fileExists(absoluteOutputPath)) {
      console.log(
        `Skipping ${generation.shotId} with model ${generation.model}; video already exists at ${generation.outputPath}`,
      )
      skippedCount += 1
      continue
    }

    const variantCount = options.variantCount ?? 1

    for (let variantIndex = 0; variantIndex < variantCount; variantIndex += 1) {
      await generateShotArtifactVersion(generation, keyframes, characterSheets, {
        generator,
        logFile,
        cwd,
        autoSelect: variantIndex === variantCount - 1,
      })
    }

    generatedCount += 1

    if (options.firstOnly) {
      break
    }
  }

  console.log(
    `Shot sync complete. Generated ${generatedCount}; skipped ${skippedCount} existing video${skippedCount === 1 ? '' : 's'}.`,
  )

  return {
    generatedCount,
    skippedCount,
  }
}

async function main() {
  const filters = parseArgs()
  const config = await loadConfig()
  const [shots, shotArtifacts, keyframes, characterSheets] = await Promise.all([
    loadShotPrompts(),
    loadShotArtifacts(),
    loadKeyframes(),
    loadCharacterSheets(),
  ])
  const plannedGenerations = selectPendingShotGenerations(shots, shotArtifacts, filters)

  if (plannedGenerations.length === 0) {
    throw new Error(buildEmptyShotGenerationError(shots, shotArtifacts, filters))
  }

  await syncShotGenerations(plannedGenerations, keyframes, characterSheets, {
    firstOnly: filters.firstOnly,
    variantCount: config.variantCount,
  })
}

if (import.meta.main) {
  main()
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(() => shutdownPostHog())
}
