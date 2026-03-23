import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { parseMedia } from '@remotion/media-parser'
import { nodeReader } from '@remotion/media-parser/node'

import {
  FINAL_CUT_VERSION,
  loadFinalCut,
  loadShotPrompts,
  resolveRepoPath,
  resolveWorkflowPath,
  WORKFLOW_FILES,
  workspacePathExists,
  type FinalCutData,
  type FinalCutShotEntry,
  type ShotEntry,
} from './workflow-data'

export interface ResolvedFinalCutShot {
  shotId: string
  assetPath: string
  assetUrl: string
  fps: number
  width: number
  height: number
  sourceDurationFrames: number
  trimStartFrames: number
  trimEndFrames: number
  durationFrames: number
  timelineStartFrame: number
  transition: FinalCutShotEntry['transition']
}

export interface ResolvedFinalCutProps {
  version: typeof FINAL_CUT_VERSION
  shots: ResolvedFinalCutShot[]
  soundtrack: {
    path: string
    assetUrl: string
    volume: number
  } | null
}

interface ResolveFinalCutOptions {
  assetBaseUrl: string
}

interface ParsedVideoMetadata {
  fps: number
  width: number
  height: number
  durationInFrames: number
}

function toRepoRelativePath(filePath: string) {
  return filePath.replace(/\\/g, '/').split(path.sep).join('/')
}

function encodeRepoAssetPath(filePath: string) {
  return filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function buildAssetUrl(assetBaseUrl: string, repoRelativePath: string) {
  return `${assetBaseUrl.replace(/\/+$/, '')}/repo/${encodeRepoAssetPath(repoRelativePath)}`
}

function createDefaultShotEntry(shot: ShotEntry): FinalCutShotEntry {
  return {
    shotId: shot.shotId,
    enabled: true,
    trimStartFrames: 0,
    trimEndFrames: 0,
    transition: {
      type: 'cut',
      durationFrames: 0,
    },
  }
}

export function createDefaultFinalCutManifest(shots: ShotEntry[]): FinalCutData {
  return {
    version: FINAL_CUT_VERSION,
    shots: shots.map((shot) => createDefaultShotEntry(shot)),
    soundtrack: null,
  }
}

async function loadVideoMetadata(filePath: string): Promise<ParsedVideoMetadata> {
  const metadata = await parseMedia({
    acknowledgeRemotionLicense: true,
    src: filePath,
    reader: nodeReader,
    fields: {
      durationInSeconds: true,
      fps: true,
      dimensions: true,
    },
  })

  if (metadata.fps === null) {
    throw new Error(`Could not determine FPS for "${filePath}".`)
  }

  if (metadata.dimensions === null) {
    throw new Error(`Could not determine dimensions for "${filePath}".`)
  }

  if (metadata.durationInSeconds === null) {
    throw new Error(`Could not determine duration for "${filePath}".`)
  }

  const durationInFrames = Math.max(1, Math.round(metadata.durationInSeconds * metadata.fps))

  return {
    fps: metadata.fps,
    width: metadata.dimensions.width,
    height: metadata.dimensions.height,
    durationInFrames,
  }
}

export async function ensureFinalCutManifest(cwd = process.cwd()) {
  if (await workspacePathExists(WORKFLOW_FILES.finalCut, cwd)) {
    return false
  }

  const shots = await loadShotPrompts(cwd)
  const manifest = createDefaultFinalCutManifest(shots)
  const finalCutPath = resolveWorkflowPath(WORKFLOW_FILES.finalCut, cwd)

  await mkdir(path.dirname(finalCutPath), { recursive: true })
  await writeFile(finalCutPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  return true
}

export async function resolveFinalCutProps(
  cwd = process.cwd(),
  options: ResolveFinalCutOptions,
): Promise<ResolvedFinalCutProps> {
  const [manifest, shotPrompts] = await Promise.all([loadFinalCut(cwd), loadShotPrompts(cwd)])
  const shotPromptById = new Map(shotPrompts.map((entry) => [entry.shotId, entry]))
  const seenShotIds = new Set<string>()

  if (manifest.shots.length !== shotPrompts.length) {
    throw new Error(
      `FINAL-CUT.json must include exactly one entry for each shot in ${WORKFLOW_FILES.shotPrompts}.`,
    )
  }

  for (const shot of manifest.shots) {
    if (seenShotIds.has(shot.shotId)) {
      throw new Error(`FINAL-CUT.json contains duplicate shotId "${shot.shotId}".`)
    }

    seenShotIds.add(shot.shotId)

    if (!shotPromptById.has(shot.shotId)) {
      throw new Error(
        `FINAL-CUT.json references unknown shotId "${shot.shotId}" from ${WORKFLOW_FILES.shotPrompts}.`,
      )
    }
  }

  for (const shotPrompt of shotPrompts) {
    if (!seenShotIds.has(shotPrompt.shotId)) {
      throw new Error(
        `FINAL-CUT.json is missing shotId "${shotPrompt.shotId}" from ${WORKFLOW_FILES.shotPrompts}.`,
      )
    }
  }

  const enabledShots = manifest.shots.filter((shot) => shot.enabled)

  if (enabledShots.length === 0) {
    throw new Error('FINAL-CUT.json must enable at least one shot.')
  }

  const resolvedShots: ResolvedFinalCutShot[] = []
  let expectedFps: number | null = null
  let expectedWidth: number | null = null
  let expectedHeight: number | null = null
  let timelineStartFrame = 0

  for (const [enabledIndex, shot] of enabledShots.entries()) {
    const shotPrompt = shotPromptById.get(shot.shotId)

    if (!shotPrompt) {
      throw new Error(`Missing shot prompt for "${shot.shotId}".`)
    }

    const assetPath = toRepoRelativePath(shotPrompt.videoPath)
    const absoluteAssetPath = resolveRepoPath(assetPath, cwd)
    const metadata = await loadVideoMetadata(absoluteAssetPath)

    if (shot.trimStartFrames + shot.trimEndFrames >= metadata.durationInFrames) {
      throw new Error(`FINAL-CUT.json trims remove the full duration of shot "${shot.shotId}".`)
    }

    if (expectedFps === null) {
      expectedFps = metadata.fps
      expectedWidth = metadata.width
      expectedHeight = metadata.height
    } else if (
      metadata.fps !== expectedFps ||
      metadata.width !== expectedWidth ||
      metadata.height !== expectedHeight
    ) {
      throw new Error(
        `Enabled shots must all share the same fps and dimensions. Shot "${shot.shotId}" is incompatible with the first enabled shot.`,
      )
    }

    if (
      enabledIndex > 0 &&
      shot.transition.type === 'fade' &&
      shot.transition.durationFrames >=
        metadata.durationInFrames - shot.trimStartFrames - shot.trimEndFrames
    ) {
      throw new Error(
        `Fade transition for shot "${shot.shotId}" is too long for the trimmed shot duration.`,
      )
    }

    const durationFrames = metadata.durationInFrames - shot.trimStartFrames - shot.trimEndFrames
    const overlapFrames = enabledIndex === 0 ? 0 : shot.transition.durationFrames
    timelineStartFrame = Math.max(0, timelineStartFrame - overlapFrames)

    const resolvedShot: ResolvedFinalCutShot = {
      shotId: shot.shotId,
      assetPath,
      assetUrl: buildAssetUrl(options.assetBaseUrl, assetPath),
      fps: metadata.fps,
      width: metadata.width,
      height: metadata.height,
      sourceDurationFrames: metadata.durationInFrames,
      trimStartFrames: shot.trimStartFrames,
      trimEndFrames: shot.trimEndFrames,
      durationFrames,
      timelineStartFrame,
      transition: shot.transition,
    }

    if (enabledIndex > 0 && shot.transition.type === 'fade') {
      const previousShot = resolvedShots[resolvedShots.length - 1]

      if (!previousShot) {
        throw new Error(`Missing previous shot for fade into "${shot.shotId}".`)
      }

      if (shot.transition.durationFrames >= previousShot.durationFrames) {
        throw new Error(
          `Fade transition for shot "${shot.shotId}" is too long for the previous shot duration.`,
        )
      }
    }

    resolvedShots.push(resolvedShot)
    timelineStartFrame += durationFrames
  }

  let soundtrack: ResolvedFinalCutProps['soundtrack'] = null

  if (manifest.soundtrack !== null) {
    const normalizedSoundtrackPath = path.posix.normalize(
      manifest.soundtrack.path.replace(/\\/g, '/'),
    )

    if (
      path.posix.isAbsolute(normalizedSoundtrackPath) ||
      normalizedSoundtrackPath === '..' ||
      normalizedSoundtrackPath.startsWith('../')
    ) {
      throw new Error('FINAL-CUT.json soundtrack.path must be a repo-relative path.')
    }

    const soundtrackAssetPath = toRepoRelativePath(normalizedSoundtrackPath)
    const absoluteSoundtrackPath = resolveRepoPath(soundtrackAssetPath, cwd)
    await access(absoluteSoundtrackPath)

    soundtrack = {
      path: soundtrackAssetPath,
      assetUrl: buildAssetUrl(options.assetBaseUrl, soundtrackAssetPath),
      volume: manifest.soundtrack.volume,
    }
  }

  return {
    version: manifest.version,
    shots: resolvedShots,
    soundtrack,
  }
}
