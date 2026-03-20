import path from 'node:path'

import arg from 'arg'

import { generateImagenOptions } from './generate-imagen-options'
import { loadKeyframePrompts } from './workflow-data'

interface GenerateKeyframesArgs {
  keyframeId?: string
  shotId?: string
  promptId?: string
  outputRoot?: string
}

function parseArgs(): GenerateKeyframesArgs {
  const args = arg({
    '--keyframe-id': String,
    '--shot-id': String,
    '--prompt-id': String,
    '--output-root': String,
  })

  return {
    keyframeId: args['--keyframe-id'],
    shotId: args['--shot-id'],
    promptId: args['--prompt-id'],
    outputRoot: args['--output-root'],
  }
}

function sanitizeLabel(label: string) {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function main() {
  const { keyframeId, shotId, promptId, outputRoot } = parseArgs()
  const prompts = await loadKeyframePrompts()
  const selectedPrompts = prompts.filter((entry) => {
    if (keyframeId && entry.keyframeId !== keyframeId) {
      return false
    }

    if (shotId && entry.shotId !== shotId) {
      return false
    }

    if (promptId && entry.promptId !== promptId) {
      return false
    }

    return true
  })

  if (selectedPrompts.length === 0) {
    throw new Error(
      `No keyframe prompt matched${
        promptId
          ? ` prompt ${promptId}`
          : keyframeId
            ? ` keyframe ${keyframeId}`
            : shotId
              ? ` shot ${shotId}`
              : ' the provided filters'
      }.`,
    )
  }

  let generatedCount = 0

  for (const entry of selectedPrompts) {
    const preferredOutputPath = outputRoot
      ? path.resolve(outputRoot, entry.shotId, `${entry.promptId}.png`)
      : path.resolve(process.cwd(), entry.outputPath)
    const outputDir = path.dirname(preferredOutputPath)
    const namePrefix = sanitizeLabel(entry.label) || entry.promptId

    console.log(`Generating ${entry.shotId} ${entry.keyframeId} ${entry.promptId} -> ${outputDir}`)

    await generateImagenOptions({
      prompt: entry.prompt,
      model: entry.model,
      outputDir,
      namePrefix,
      keyframeId: entry.keyframeId,
      shotId: entry.shotId,
      frameType: entry.frameType,
      promptId: entry.promptId,
    })

    generatedCount += 1
  }

  console.log(`Generated ${generatedCount} keyframe prompt${generatedCount === 1 ? '' : 's'}.`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
