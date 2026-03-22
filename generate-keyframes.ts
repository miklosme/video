import { access } from 'node:fs/promises'
import path from 'node:path'

import arg from 'arg'

import { generateImagenOptions } from './generate-imagen-options'
import {
  loadKeyframeArtifacts,
  loadKeyframes,
  type FrameType,
  type KeyframeArtifactEntry,
  type KeyframeEntry,
} from './workflow-data'

interface GenerateKeyframesArgs {
  keyframeId?: string
  shotId?: string
}

export interface PendingKeyframeGeneration {
  keyframeId: string
  shotId: string
  frameType: FrameType
  model: string
  prompt: string
  outputPath: string
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
  filters: GenerateKeyframesArgs = {},
) {
  const artifactById = new Map(artifacts.map((entry) => [entry.keyframeId, entry]))

  return keyframes
    .filter((entry) => {
      if (filters.keyframeId && entry.keyframeId !== filters.keyframeId) {
        return false
      }

      if (filters.shotId && entry.shotId !== filters.shotId) {
        return false
      }

      return artifactById.has(entry.keyframeId)
    })
    .map<PendingKeyframeGeneration>((entry) => {
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
      }
    })
}

async function main() {
  const filters = parseArgs()
  const [keyframes, artifacts] = await Promise.all([loadKeyframes(), loadKeyframeArtifacts()])
  const plannedGenerations = selectPendingKeyframeGenerations(keyframes, artifacts, filters)

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
        `Skipping ${generation.keyframeId}; image already exists at ${generation.outputPath}`,
      )
      skippedCount += 1
      continue
    }

    console.log(`Generating ${generation.keyframeId} -> ${generation.outputPath}`)

    await generateImagenOptions({
      prompt: generation.prompt,
      model: generation.model,
      outputPath: generation.outputPath,
      keyframeId: generation.keyframeId,
      shotId: generation.shotId,
      frameType: generation.frameType,
    })

    generatedCount += 1
  }

  console.log(
    `Keyframe sync complete. Generated ${generatedCount}; skipped ${skippedCount} existing image${skippedCount === 1 ? '' : 's'}.`,
  )
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
