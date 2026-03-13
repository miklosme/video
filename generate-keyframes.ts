import arg from 'arg'
import { generateImagenOptions } from './generate-imagen-options'
import { FRAME_TYPES, type FrameType, loadKeyframes } from './workflow-data'

interface GenerateKeyframesArgs {
  shotId?: string
  frameType?: FrameType
  promptId?: string
  outputRoot?: string
}

function parseArgs(): GenerateKeyframesArgs {
  const args = arg({
    '--shot-id': String,
    '--frame-type': String,
    '--prompt-id': String,
    '--output-root': String,
  })

  const frameTypeArg = args['--frame-type']

  if (frameTypeArg && !FRAME_TYPES.includes(frameTypeArg as FrameType)) {
    throw new Error(
      `Invalid --frame-type "${frameTypeArg}". Expected one of: ${FRAME_TYPES.join(', ')}.`,
    )
  }

  return {
    shotId: args['--shot-id'],
    frameType: frameTypeArg as FrameType | undefined,
    promptId: args['--prompt-id'],
    outputRoot: args['--output-root'],
  }
}

async function main() {
  const { shotId, frameType, promptId, outputRoot } = parseArgs()
  const keyframes = await loadKeyframes()
  const selectedShots = keyframes.shots.filter((shot) => (shotId ? shot.shotId === shotId : true))

  if (selectedShots.length === 0) {
    throw new Error(
      `No keyframe shot matched${shotId ? ` shot ${shotId}` : ' the provided filters'}.`,
    )
  }

  let generatedCount = 0

  for (const shot of selectedShots) {
    for (const frame of shot.frames) {
      if (frameType && frame.frameType !== frameType) {
        continue
      }

      if (promptId && frame.promptId !== promptId) {
        continue
      }

      const outputDir = outputRoot ? `${outputRoot}/${shot.shotId}` : `keyframes/${shot.shotId}`
      console.log(`Generating ${shot.shotId} ${frame.frameType} -> ${outputDir}`)

      await generateImagenOptions({
        prompt: frame.prompt,
        model: keyframes.activeModel.modelId,
        outputDir,
        namePrefix: frame.frameType,
        shotId: shot.shotId,
        frameType: frame.frameType,
        promptId: frame.promptId,
      })

      generatedCount += 1
    }
  }

  if (generatedCount === 0) {
    throw new Error('The provided filters matched no keyframe prompts.')
  }

  console.log(`Generated ${generatedCount} keyframe prompt${generatedCount === 1 ? '' : 's'}.`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
