import { access, rm } from 'node:fs/promises'
import path from 'node:path'

import arg from 'arg'

import {
  buildApprovedActionSummary,
  getKeyframeArtifactDescriptor,
  prepareStagedArtifactVersion,
  recordArtifactVersionFromStage,
  resolveKeyframeGenerationReferences,
} from './artifact-control'
import { generateImagenOptions } from './generate-imagen-options'
import { captureWorkflowEvent, shutdownPostHog } from './posthog'
import {
  loadKeyframeArtifacts,
  loadKeyframes,
  loadShotPrompts,
  type ArtifactReferenceEntry,
  type FrameType,
  type GenerationReferenceEntry,
  type KeyframeArtifactEntry,
  type KeyframeEntry,
  type ShotEntry,
  type ShotIncomingTransitionEntry,
} from './workflow-data'

interface GenerateKeyframesArgs {
  keyframeId?: string
  shotId?: string
}

const DEFAULT_KEYFRAME_IMAGE_SIZE = '1024x576' as const

export interface PendingKeyframeGeneration {
  keyframeId: string
  shotId: string
  frameType: FrameType
  model: string
  prompt: string
  outputPath: string
  characterIds: string[]
  incomingTransition: ShotIncomingTransitionEntry
  userReferences?: ArtifactReferenceEntry[]
}

function parseArgs(): GenerateKeyframesArgs {
  const args = arg({
    '--keyframe-id': String,
    '--shot-id': String,
  })

  return {
    keyframeId: args['--keyframe-id'],
    shotId: args['--shot-id'],
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

export function selectPendingKeyframeGenerations(
  keyframes: KeyframeEntry[],
  artifacts: KeyframeArtifactEntry[],
  shots: ShotEntry[],
  filters: GenerateKeyframesArgs = {},
) {
  const artifactById = new Map(artifacts.map((entry) => [entry.keyframeId, entry]))
  const keyframeById = new Map(keyframes.map((entry) => [entry.keyframeId, entry]))

  return shots.flatMap<PendingKeyframeGeneration>((shot) => {
    const orderedKeyframes = orderShotKeyframesForGeneration(shot, keyframeById)

    return orderedKeyframes
      .filter((entry) => {
        if (filters.keyframeId && entry.keyframeId !== filters.keyframeId) {
          return false
        }

        if (filters.shotId && entry.shotId !== filters.shotId) {
          return false
        }

        return artifactById.has(entry.keyframeId)
      })
      .map((entry) => {
        const artifact = artifactById.get(entry.keyframeId)

        if (!artifact) {
          throw new Error(`Missing keyframe artifact for "${entry.keyframeId}".`)
        }

        return {
          keyframeId: entry.keyframeId,
          shotId: entry.shotId,
          frameType: entry.frameType,
          model: artifact.model,
          prompt: artifact.prompt,
          outputPath: entry.imagePath,
          characterIds: entry.characterIds,
          incomingTransition: shot.incomingTransition,
          userReferences: artifact.references,
        }
      })
  })
}

function orderShotKeyframesForGeneration(
  shot: ShotEntry,
  keyframeById: ReadonlyMap<string, KeyframeEntry>,
) {
  const shotKeyframes = shot.keyframeIds.map((keyframeId) => {
    const keyframe = keyframeById.get(keyframeId)

    if (!keyframe) {
      throw new Error(`Shot "${shot.shotId}" references missing keyframe "${keyframeId}".`)
    }

    return keyframe
  })

  if (shotKeyframes.length === 1) {
    if (shotKeyframes[0]?.frameType !== 'single') {
      throw new Error(
        `Shot "${shot.shotId}" references one keyframe, so it must use frameType "single".`,
      )
    }

    return shotKeyframes
  }

  const start = shotKeyframes.find((entry) => entry.frameType === 'start')
  const end = shotKeyframes.find((entry) => entry.frameType === 'end')

  if (!start || !end || shotKeyframes.some((entry) => entry.frameType === 'single')) {
    throw new Error(
      `Shot "${shot.shotId}" must reference one "start" and one "end" keyframe for generation.`,
    )
  }

  return [start, end]
}

function getPreviousShot(shots: ShotEntry[], shotId: string) {
  const shotIndex = shots.findIndex((entry) => entry.shotId === shotId)

  if (shotIndex === -1) {
    throw new Error(`Cannot find shot "${shotId}" in workspace/SHOTS.json.`)
  }

  return shotIndex === 0 ? null : shots[shotIndex - 1]!
}
export function resolveKeyframeGenerationPrompt(
  generation: Pick<PendingKeyframeGeneration, 'frameType' | 'incomingTransition' | 'prompt'>,
) {
  if (generation.frameType === 'end' || generation.incomingTransition.type !== 'continuity') {
    return generation.prompt
  }

  return `${generation.prompt}\n\nContinuity handoff: ${generation.incomingTransition.notes}`
}

export function planKeyframeGenerationReferences(
  generation: Pick<
    PendingKeyframeGeneration,
    'keyframeId' | 'shotId' | 'frameType' | 'incomingTransition'
  > & {
    characterIds: readonly string[]
  },
  keyframes: KeyframeEntry[],
  shots: ShotEntry[],
  options: {
    selectedVersionPath?: string | null
    userReferences?: readonly ArtifactReferenceEntry[]
  } = {},
): GenerationReferenceEntry[] {
  return resolveKeyframeGenerationReferences(generation, keyframes, shots, options).references
}

async function assertReferenceFilesExist(
  references: GenerationReferenceEntry[],
  keyframeId: string,
  cwd = process.cwd(),
) {
  for (const reference of references) {
    const absoluteReferencePath = path.resolve(cwd, reference.path)

    if (await fileExists(absoluteReferencePath)) {
      continue
    }

    throw new Error(
      `Cannot generate ${keyframeId}; required ${reference.kind} reference is missing at ${reference.path}.`,
    )
  }
}

function applyKeyframeEditInstruction(prompt: string, editInstruction?: string | null) {
  if (!editInstruction) {
    return prompt
  }

  return [
    prompt,
    '',
    'Requested edit:',
    editInstruction,
    '',
    'Apply only this approved change while preserving the rest of the current keyframe unless the edit explicitly requests broader changes.',
  ].join('\n')
}

export async function runKeyframeGeneration(
  generation: PendingKeyframeGeneration,
  keyframes: KeyframeEntry[],
  shots: ShotEntry[],
  options: {
    outputPath?: string
    editInstruction?: string | null
    selectedVersionPath?: string | null
    userReferences?: readonly ArtifactReferenceEntry[]
    logFile?: string
    cwd?: string
  } = {},
) {
  const { resolvedReferences, references } = resolveKeyframeGenerationReferences(
    generation,
    keyframes,
    shots,
    {
      selectedVersionPath: options.selectedVersionPath,
      userReferences: options.userReferences ?? generation.userReferences ?? [],
    },
  )
  await assertReferenceFilesExist(references, generation.keyframeId, options.cwd)

  const prompt = applyKeyframeEditInstruction(
    resolveKeyframeGenerationPrompt(generation),
    options.editInstruction,
  )
  const result = await generateImagenOptions({
    prompt,
    model: generation.model,
    size: DEFAULT_KEYFRAME_IMAGE_SIZE,
    outputPath: options.outputPath ?? generation.outputPath,
    keyframeId: generation.keyframeId,
    shotId: generation.shotId,
    frameType: generation.frameType,
    references,
    logFile: options.logFile,
    cwd: options.cwd,
    artifactType: 'keyframe',
    artifactId: generation.keyframeId,
  })

  return {
    ...result,
    prompt,
    resolvedReferences,
    references,
  }
}

export async function generateKeyframeArtifactVersion(
  generation: PendingKeyframeGeneration,
  keyframes: KeyframeEntry[],
  shots: ShotEntry[],
  options: {
    editInstruction?: string | null
    selectedVersionPath?: string | null
    baseVersionId?: string | null
    userReferences?: readonly ArtifactReferenceEntry[]
    logFile?: string
    cwd?: string
  } = {},
) {
  const descriptor = getKeyframeArtifactDescriptor(generation)
  const cwd = options.cwd ?? process.cwd()
  const stagedVersion = await prepareStagedArtifactVersion(descriptor, cwd)

  try {
    const result = await runKeyframeGeneration(generation, keyframes, shots, {
      outputPath: stagedVersion.stagedPath,
      editInstruction: options.editInstruction,
      selectedVersionPath: options.selectedVersionPath,
      userReferences: options.userReferences,
      logFile: options.logFile,
      cwd,
    })
    const recorded = await recordArtifactVersionFromStage({
      descriptor,
      stagedPath: stagedVersion.stagedPath,
      baseVersionId: options.baseVersionId ?? null,
      generationId: result.generationId,
      editInstruction: options.editInstruction ?? null,
      approvedActionSummary: buildApprovedActionSummary({
        descriptor,
        baseVersionId: options.baseVersionId ?? null,
        editInstruction: options.editInstruction ?? null,
        references: result.resolvedReferences,
      }),
      references: result.resolvedReferences,
      cwd,
    })

    return {
      ...result,
      descriptor,
      versionId: recorded.version.versionId,
    }
  } catch (error) {
    await rm(path.resolve(cwd, stagedVersion.stagedPath), { force: true }).catch(() => undefined)
    throw error
  }
}

async function main() {
  const filters = parseArgs()
  const [keyframes, artifacts, shots] = await Promise.all([
    loadKeyframes(),
    loadKeyframeArtifacts(),
    loadShotPrompts(),
  ])
  const plannedGenerations = selectPendingKeyframeGenerations(keyframes, artifacts, shots, filters)

  if (plannedGenerations.length === 0) {
    throw new Error(
      `No keyframe artifact matched${
        filters.keyframeId
          ? ` keyframe ${filters.keyframeId}`
          : filters.shotId
            ? ` shot ${filters.shotId}`
            : ' the provided filters'
      }.`,
    )
  }

  let generatedCount = 0
  let skippedCount = 0

  for (const generation of plannedGenerations) {
    const absoluteOutputPath = path.resolve(process.cwd(), generation.outputPath)

    if (await fileExists(absoluteOutputPath)) {
      console.log(
        `Skipping ${generation.keyframeId} with model ${generation.model}; image already exists at ${generation.outputPath}`,
      )
      captureWorkflowEvent('keyframe_generation_skipped', {
        keyframeId: generation.keyframeId,
        shotId: generation.shotId,
      })
      skippedCount += 1
      continue
    }

    console.log(
      `Generating ${generation.keyframeId} with model ${generation.model} -> ${generation.outputPath}`,
    )

    await generateKeyframeArtifactVersion(generation, keyframes, shots)

    captureWorkflowEvent('keyframe_generated', {
      keyframeId: generation.keyframeId,
      shotId: generation.shotId,
      model: generation.model,
    })
    generatedCount += 1
  }

  console.log(
    `Keyframe sync complete. Generated ${generatedCount}; skipped ${skippedCount} existing image${skippedCount === 1 ? '' : 's'}.`,
  )
}

if (import.meta.main) {
  main()
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(() => shutdownPostHog())
}
