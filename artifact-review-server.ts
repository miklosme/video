import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import {
  deleteArtifactVersion,
  getArtifactKey,
  getArtifactVersionMediaPath,
  getCharacterArtifactDescriptor,
  getKeyframeArtifactDescriptor,
  getShotArtifactDescriptor,
  getStoryboardArtifactDescriptor,
  loadArtifactHistoryState,
  promoteArtifactVersion,
  summarizeReference,
  type ArtifactDescriptor,
  type ArtifactHistoryState,
} from './artifact-control'
import {
  regenerateCharacterSheetArtifactVersion,
  selectPendingCharacterSheetGenerations,
  type PendingCharacterSheetGeneration,
} from './generate-character-sheets'
import type {
  GenerateImagenOptionsInput,
  GenerateImagenOptionsResult,
} from './generate-imagen-options'
import {
  generateKeyframeArtifactVersion,
  regenerateKeyframeArtifactVersion,
  selectPendingKeyframeGenerations,
  type PendingKeyframeGeneration,
} from './generate-keyframes'
import {
  regenerateShotArtifactVersion,
  selectPendingShotGenerations,
  type PendingShotGeneration,
  type ShotVideoGenerator,
} from './generate-shots'
import { regenerateStoryboardArtifactVersion } from './generate-storyboard'
import { renderTimelineContent } from './timeline-component'
import {
  AUTHORED_REFERENCE_KINDS,
  getCharacterSheetImagePath,
  getKeyframeArtifactJsonPath,
  getKeyframeImagePath,
  getShotVideoPath,
  getStoryboardImagePath,
  loadCharacterSheets,
  loadConfig,
  loadKeyframeArtifacts,
  loadKeyframes,
  loadShotArtifacts,
  loadShotPrompts,
  loadStoryboardSidecar,
  normalizeRepoRelativePath,
  resolveRepoPath,
  resolveWorkflowPath,
  WORKFLOW_FILES,
  type ArtifactReferenceEntry,
  type CharacterSheetEntry,
  type FrameType,
  type KeyframeEntry,
  type ResolvedArtifactReference,
  type ShotEntry,
} from './workflow-data'

const FRAME_ORDER: Record<FrameType, number> = {
  start: 0,
  end: 1,
}

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

const CURRENT_BASE_VERSION_ID = 'current'

type Tab = 'idea' | 'story' | 'characters' | 'storyboard' | 'timeline'

type ArtifactJobStatus = 'running' | 'success' | 'error'

interface ArtifactJobState {
  status: ArtifactJobStatus
  startedAt: string
  completedAt: string | null
  message: string
  versionId: string | null
}

type PlaceholderVariant = 'missing' | 'omitted'

type ImageGenerator = (input: GenerateImagenOptionsInput) => Promise<GenerateImagenOptionsResult>

interface RegenerateActionGeneratorOverrides {
  imageGenerator?: ImageGenerator
  shotVideoGenerator?: ShotVideoGenerator
}

interface CharacterReviewCard {
  characterId: string
  displayName: string
  prompt: string
  status: string
  imageUrl: string
  imageExists: boolean
}

interface VersionRailItem {
  versionId: string
  label: string
  href: string
  mediaUrl: string | null
  mediaExists: boolean
  isActive: boolean
  isCurrent: boolean
}

interface ArtifactPrimaryAction {
  kind: 'regenerate' | 'create-keyframe'
  actionUrl: string
  enabled: boolean
}

interface KeyframeRemovalAction {
  actionUrl: string
  enabled: boolean
  helpText: string
  confirmMessage?: string
}

interface ArtifactDetailContext {
  descriptor: ArtifactDescriptor
  activeTab: Tab
  title: string
  subtitle: string
  summaryHref: string
  summaryLabel: string
  mediaType: 'image' | 'video'
  mediaUrl: string | null
  mediaExists: boolean
  mediaPlaceholder: string
  mediaPlaceholderVariant: PlaceholderVariant
  sourceReferences: ArtifactReferenceEntry[]
  sourcePrompt: string | null
  sourceModel: string | null
  sourceStatus: string | null
  historyState: ArtifactHistoryState
  notesHtml: string
  canEdit: boolean
  canEditReferences: boolean
  primaryAction: ArtifactPrimaryAction
  removeAction: KeyframeRemovalAction | null
}

export interface ArtifactReviewServer {
  port: number
  url: string
  stop: () => Promise<void>
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function encodeAssetUrl(assetPath: string) {
  return assetPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

async function fileExists(filePath: string) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function frameTypeLabel(frameType: FrameType) {
  return frameType === 'start' ? 'Start' : 'End'
}

function getCanonicalKeyframeId(shotId: string, frameType: FrameType) {
  return `${shotId}-${frameType.toUpperCase()}`
}

function parseCanonicalKeyframeId(keyframeId: string): {
  shotId: string
  frameType: FrameType
} | null {
  if (keyframeId.endsWith('-START')) {
    return {
      shotId: keyframeId.slice(0, -'-START'.length),
      frameType: 'start',
    }
  }

  if (keyframeId.endsWith('-END')) {
    return {
      shotId: keyframeId.slice(0, -'-END'.length),
      frameType: 'end',
    }
  }

  return null
}

function sortShotKeyframes(
  keyframes: ReadonlyArray<Pick<KeyframeEntry, 'frameType' | 'keyframeId' | 'imagePath'>>,
) {
  return [...keyframes].sort(
    (left, right) =>
      FRAME_ORDER[left.frameType] - FRAME_ORDER[right.frameType] ||
      left.keyframeId.localeCompare(right.keyframeId),
  )
}

async function loadCharacterSheetsOrEmpty(cwd: string) {
  try {
    return await loadCharacterSheets(cwd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

async function loadKeyframesOrEmpty(cwd: string) {
  try {
    return await loadKeyframes(cwd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

async function loadKeyframeArtifactsOrEmpty(cwd: string) {
  try {
    return await loadKeyframeArtifacts(cwd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

async function loadShotPromptsOrEmpty(cwd: string) {
  try {
    return await loadShotPrompts(cwd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

function serializeShotEntry(shot: ShotEntry) {
  return {
    shotId: shot.shotId,
    status: shot.status,
    videoPath: shot.videoPath,
    durationSeconds: shot.durationSeconds,
    incomingTransition: shot.incomingTransition,
    keyframes: sortShotKeyframes(shot.keyframes ?? []).map((entry) => ({
      keyframeId: entry.keyframeId,
      frameType: entry.frameType,
      imagePath: entry.imagePath,
    })),
  }
}

async function writeShotPromptsFile(shots: ShotEntry[], cwd: string) {
  const outputPath = resolveWorkflowPath(WORKFLOW_FILES.shotPrompts, cwd)
  const serialized = shots.map((shot) => serializeShotEntry(shot))

  await writeFile(outputPath, `${JSON.stringify(serialized, null, 2)}\n`, 'utf8')
}

function buildEmbeddedKeyframeDetailUrl(keyframeId: string) {
  return `/keyframes/${encodeURIComponent(keyframeId)}?embed=1`
}

function buildEmbeddedShotDetailUrl(shotId: string) {
  return `/shots/${encodeURIComponent(shotId)}?embed=1`
}

async function buildTimelineData(shots: ShotEntry[], cwd: string) {
  if (shots.length === 0) {
    return {
      pointers: [],
      sections: [],
      keyframeGroups: [],
      saveUrl: '/timeline/update',
    }
  }

  let position = 0
  const pointers: Array<{
    id: string
    position: number
    canDrag: boolean
    left: {
      keyframeId: string
      detailUrl: string
      omitted: boolean
    } | null
    right: {
      keyframeId: string
      detailUrl: string
      omitted: boolean
    } | null
  }> = [
    {
      id: 'pointer-0',
      position: 0,
      canDrag: false,
      left: null,
      right: {
        keyframeId: getCanonicalKeyframeId(shots[0]!.shotId, 'start'),
        detailUrl: buildEmbeddedKeyframeDetailUrl(
          getCanonicalKeyframeId(shots[0]!.shotId, 'start'),
        ),
        omitted: !shots[0]!.keyframeIds.includes(getCanonicalKeyframeId(shots[0]!.shotId, 'start')),
      },
    },
  ]
  const sections = shots.map((shot) => ({
    shotId: shot.shotId,
    detailUrl: buildEmbeddedShotDetailUrl(shot.shotId),
  }))

  for (let index = 0; index < shots.length; index += 1) {
    const currentShot = shots[index]!
    const nextShot = shots[index + 1] ?? null
    const currentEndId = getCanonicalKeyframeId(currentShot.shotId, 'end')
    position += currentShot.durationSeconds

    pointers.push({
      id: `pointer-${index + 1}`,
      position,
      canDrag: true,
      left: {
        keyframeId: currentEndId,
        detailUrl: buildEmbeddedKeyframeDetailUrl(currentEndId),
        omitted: !currentShot.keyframeIds.includes(currentEndId),
      },
      right: nextShot
        ? {
            keyframeId: getCanonicalKeyframeId(nextShot.shotId, 'start'),
            detailUrl: buildEmbeddedKeyframeDetailUrl(
              getCanonicalKeyframeId(nextShot.shotId, 'start'),
            ),
            omitted: !nextShot.keyframeIds.includes(
              getCanonicalKeyframeId(nextShot.shotId, 'start'),
            ),
          }
        : null,
    })
  }

  const keyframeGroups = (
    await Promise.all(
      shots.map(async (shot, index) => {
        const plannedEntriesById = new Map(
          (shot.keyframes ?? []).map((entry) => [entry.keyframeId, entry]),
        )
        const items = await Promise.all(
          (['start', 'end'] as const)
            .filter((frameType) =>
              shot.keyframeIds.includes(getCanonicalKeyframeId(shot.shotId, frameType)),
            )
            .map(async (frameType) => {
              const keyframeId = getCanonicalKeyframeId(shot.shotId, frameType)
              const plannedEntry = plannedEntriesById.get(keyframeId)
              const imagePath =
                plannedEntry?.imagePath ?? getKeyframeImagePath({ shotId: shot.shotId, keyframeId })

              return {
                keyframeId,
                shotId: shot.shotId,
                frameType,
                pointerId: frameType === 'start' ? `pointer-${index}` : `pointer-${index + 1}`,
                side: frameType === 'start' ? 'right' : 'left',
                detailUrl: buildEmbeddedKeyframeDetailUrl(keyframeId),
                imageUrl: `/${encodeAssetUrl(imagePath)}`,
                imageExists: await fileExists(resolveRepoPath(imagePath, cwd)),
              } as const
            }),
        )

        return items.length > 0
          ? {
              shotId: shot.shotId,
              items,
            }
          : null
      }),
    )
  ).filter((group): group is NonNullable<typeof group> => group !== null)

  return {
    pointers,
    sections,
    keyframeGroups,
    saveUrl: '/timeline/update',
  }
}

function getShotByCanonicalKeyframeId(shots: ShotEntry[], keyframeId: string) {
  const parsed = parseCanonicalKeyframeId(keyframeId)

  if (!parsed) {
    return null
  }

  const shot = shots.find((entry) => entry.shotId === parsed.shotId)

  if (!shot) {
    return null
  }

  return {
    shot,
    frameType: parsed.frameType,
    shotId: parsed.shotId,
  }
}

async function createOmittedKeyframe(
  keyframeId: string,
  prompt: string,
  cwd: string,
): Promise<ArtifactDescriptor> {
  const trimmedPrompt = prompt.trim()

  if (trimmedPrompt.length === 0) {
    throw new Error('A prompt is required to create a keyframe.')
  }

  const shots = await loadShotPrompts(cwd)
  const match = getShotByCanonicalKeyframeId(shots, keyframeId)

  if (!match) {
    throw new Error(`Keyframe "${keyframeId}" does not map to an existing shot.`)
  }

  const { shot, frameType, shotId } = match

  if (shot.keyframeIds.includes(keyframeId)) {
    throw new Error(`Keyframe "${keyframeId}" is already planned.`)
  }

  const nextKeyframes = sortShotKeyframes([
    ...(shot.keyframes ?? []),
    {
      keyframeId,
      frameType,
      imagePath: getKeyframeImagePath({ shotId, keyframeId }),
    },
  ])

  const nextShots = shots.map((entry) =>
    entry.shotId === shotId
      ? {
          ...entry,
          keyframes: nextKeyframes,
          keyframeIds: nextKeyframes.map((item) => item.keyframeId),
        }
      : entry,
  )
  const descriptor = getKeyframeArtifactDescriptor({ keyframeId, shotId })
  const sidecarAbsolutePath = resolveRepoPath(
    getKeyframeArtifactJsonPath({ shotId, keyframeId }),
    cwd,
  )

  await writeShotPromptsFile(nextShots, cwd)
  await mkdir(path.dirname(sidecarAbsolutePath), { recursive: true })
  await writeFile(
    sidecarAbsolutePath,
    `${JSON.stringify(
      {
        keyframeId,
        shotId,
        frameType,
        prompt: trimmedPrompt,
        status: 'draft',
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  return descriptor
}

async function removePlannedKeyframe(keyframeId: string, cwd: string): Promise<ArtifactDescriptor> {
  const shots = await loadShotPrompts(cwd)
  const shot = shots.find((entry) => entry.keyframeIds.includes(keyframeId))

  if (!shot) {
    throw new Error(`Keyframe "${keyframeId}" is not planned in workspace/SHOTS.json.`)
  }

  if (shot.keyframeIds.length <= 1) {
    throw new Error(`Shot "${shot.shotId}" must keep at least one planned anchor.`)
  }

  const nextKeyframes = (shot.keyframes ?? []).filter((entry) => entry.keyframeId !== keyframeId)

  if (nextKeyframes.length === (shot.keyframes ?? []).length) {
    throw new Error(`Keyframe "${keyframeId}" is missing from shot "${shot.shotId}".`)
  }

  const nextShots = shots.map((entry) =>
    entry.shotId === shot.shotId
      ? {
          ...entry,
          keyframes: nextKeyframes,
          keyframeIds: nextKeyframes.map((item) => item.keyframeId),
        }
      : entry,
  )
  const descriptor = getKeyframeArtifactDescriptor({
    keyframeId,
    shotId: shot.shotId,
  })

  await writeShotPromptsFile(nextShots, cwd)
  if (!descriptor.sidecarPath) {
    throw new Error(`Keyframe "${keyframeId}" is missing its source sidecar path.`)
  }

  await rm(resolveRepoPath(descriptor.sidecarPath, cwd), { force: true })
  await rm(resolveRepoPath(descriptor.publicPath, cwd), { force: true })
  await rm(resolveRepoPath(descriptor.historyDir, cwd), { recursive: true, force: true })

  return descriptor
}

async function loadShotArtifactsOrEmpty(cwd: string) {
  try {
    return await loadShotArtifacts(cwd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

function renderTabs(activeTab: Tab) {
  const tabs: { id: Tab; label: string; href: string }[] = [
    { id: 'idea', label: 'Idea', href: '/idea' },
    { id: 'story', label: 'Story', href: '/story' },
    { id: 'characters', label: 'Characters', href: '/' },
    { id: 'storyboard', label: 'Storyboard', href: '/storyboard' },
    { id: 'timeline', label: 'Timeline', href: '/timeline' },
  ]

  return `
    <nav class="tabs">
      ${tabs
        .map(
          (tab) =>
            `<a class="tab${tab.id === activeTab ? ' tab-active' : ''}" href="${tab.href}">${escapeHtml(tab.label)}</a>`,
        )
        .join('')}
    </nav>
  `
}

function renderPage(
  activeTab: Tab,
  content: string,
  options: { autoRefresh?: boolean; embedded?: boolean } = {},
) {
  const refreshTag = options.autoRefresh ? '<meta http-equiv="refresh" content="2">' : ''
  const bodyClass = options.embedded ? 'page-embedded' : ''
  const boardClass = options.embedded ? 'board board-embedded' : 'board'

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${refreshTag}
    <title>Artifact Review</title>
    <style>
      :root {
        --bg: #090b0f;
        --panel: #11151d;
        --panel-strong: #171c26;
        --line: rgba(255,255,255,0.08);
        --text: #e7eef7;
        --muted: #94a4ba;
        --soft: #6c7c92;
        --accent: #9fe870;
        --accent-2: #7dd3fc;
        --warn: #f8c44f;
        --error: #f87373;
      }

      * { box-sizing: border-box; margin: 0; padding: 0; }

      body {
        min-height: 100vh;
        background:
          radial-gradient(circle at top left, rgba(125,211,252,0.14), transparent 35%),
          radial-gradient(circle at top right, rgba(159,232,112,0.09), transparent 32%),
          linear-gradient(180deg, #0b0f15 0%, #090b0f 100%);
        color: var(--text);
        font-family: "Helvetica Neue", Helvetica, sans-serif;
        -webkit-font-smoothing: antialiased;
      }

      body.page-embedded {
        min-height: auto;
        background: transparent;
      }

      a { color: inherit; }

      .board {
        max-width: 1320px;
        margin: 0 auto;
        padding: 28px 20px 36px;
        display: flex;
        flex-direction: column;
        gap: 20px;
      }

      .board-embedded {
        max-width: none;
        margin: 0;
        padding: 0;
      }

      .tabs {
        display: flex;
        gap: 6px;
        padding: 6px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: rgba(255,255,255,0.02);
        width: fit-content;
      }

      .tab {
        padding: 10px 16px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        text-decoration: none;
        color: var(--soft);
        border-radius: 999px;
      }

      .tab:hover { color: var(--text); }

      .tab-active {
        background: rgba(159,232,112,0.12);
        color: var(--accent);
      }

      .stack {
        display: flex;
        flex-direction: column;
        gap: 18px;
      }

      .hero {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 16px;
        padding: 20px;
        border: 1px solid var(--line);
        border-radius: 18px;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01)),
          var(--panel);
      }

      .hero-copy {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .hero-label {
        font-size: 11px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--soft);
      }

      .hero-title {
        font-size: clamp(24px, 3vw, 34px);
        line-height: 1.05;
        letter-spacing: -0.04em;
      }

      .hero-subtitle {
        max-width: 760px;
        color: var(--muted);
        font-size: 14px;
        line-height: 1.55;
      }

      .summary-grid {
        display: grid;
        gap: 18px;
      }

      .character-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 18px;
      }

      .shot-review-grid {
        display: flex;
        flex-direction: column;
        gap: 18px;
      }

      .character-card,
      .shot-review-card,
      .summary-card,
      .detail-layout,
      .panel,
      .storyboard-panel,
      .job-banner {
        border: 1px solid var(--line);
        border-radius: 18px;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01)),
          var(--panel);
        overflow: hidden;
      }

      .detail-layout {
        display: grid;
        grid-template-columns: minmax(0, 1.45fr) minmax(320px, 0.85fr);
      }

      .panel,
      .summary-card,
      .job-banner {
        padding: 18px;
      }

      .character-card {
        text-decoration: none;
        display: flex;
        flex-direction: column;
      }

      .character-visual,
      .detail-visual,
      .storyboard-visual,
      .shot-review-visual,
      .slot-visual {
        position: relative;
        background: var(--panel-strong);
        border: 1px solid rgba(255,255,255,0.05);
        overflow: hidden;
      }

      .character-visual { aspect-ratio: 1; margin: 14px 14px 0; border-radius: 14px; }
      .detail-visual,
      .storyboard-visual,
      .shot-review-visual,
      .slot-visual { aspect-ratio: 16 / 9; border-radius: 16px; }

      .detail-main {
        padding: 18px;
        display: flex;
        flex-direction: column;
        gap: 18px;
        min-width: 0;
      }

      .detail-side {
        padding: 18px;
        border-left: 1px solid var(--line);
        display: flex;
        flex-direction: column;
        gap: 18px;
      }

      img,
      video {
        display: block;
        width: 100%;
        height: 100%;
      }

      img { object-fit: cover; }

      .storyboard-visual img,
      .detail-visual img,
      .shot-review-visual video { object-fit: contain; background: #080a0d; }

      .placeholder {
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
        padding: 18px;
        text-align: center;
        color: var(--soft);
        font-size: 13px;
        background-color: #0d1116;
      }

      .placeholder-missing {
        color: rgba(215, 227, 241, 0.84);
        background:
          linear-gradient(135deg, rgba(159,232,112,0.12), transparent 38%),
          repeating-linear-gradient(
            -45deg,
            rgba(255,255,255,0.05),
            rgba(255,255,255,0.05) 10px,
            transparent 10px,
            transparent 20px
          ),
          linear-gradient(180deg, rgba(12,15,20,0.98), rgba(9,12,16,0.98));
        box-shadow:
          inset 0 0 0 1px rgba(159,232,112,0.14),
          inset 0 24px 40px rgba(255,255,255,0.02);
      }

      .placeholder-omitted {
        color: rgba(168, 181, 165, 0.72);
        background:
          radial-gradient(circle at 22% 20%, rgba(126, 146, 120, 0.08), transparent 0 24%),
          radial-gradient(circle at 78% 78%, rgba(98, 116, 96, 0.06), transparent 0 22%),
          linear-gradient(180deg, rgba(11,14,15,0.97), rgba(9,11,12,0.97));
        box-shadow: inset 0 0 0 1px rgba(168, 181, 165, 0.05);
      }

      .card-copy,
      .meta-stack,
      .storyboard-copy {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .card-copy {
        padding: 14px;
      }

      .eyebrow {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--soft);
      }

      .title {
        font-size: 16px;
        font-weight: 700;
        line-height: 1.2;
      }

      .muted {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.55;
      }

      .small {
        color: var(--soft);
        font-size: 12px;
        line-height: 1.45;
      }

      .pill-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 7px 10px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.03);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }

      .pill-accent { color: var(--accent); background: rgba(159,232,112,0.1); }
      .pill-info { color: var(--accent-2); background: rgba(125,211,252,0.1); }
      .pill-warn { color: var(--warn); background: rgba(248,196,79,0.12); }
      .pill-error { color: var(--error); background: rgba(248,115,115,0.12); }

      .summary-actions,
      .form-actions,
      .version-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .button,
      button {
        appearance: none;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.03);
        color: var(--text);
        font: inherit;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        padding: 11px 14px;
        border-radius: 999px;
        text-decoration: none;
        cursor: pointer;
      }

      .button-primary,
      button.button-primary {
        background: rgba(159,232,112,0.12);
        color: var(--accent);
      }

      .button-secondary,
      button.button-secondary {
        background: rgba(125,211,252,0.11);
        color: var(--accent-2);
      }

      .button-danger,
      button.button-danger {
        background: rgba(248,115,115,0.12);
        color: var(--error);
      }

      button:disabled { opacity: 0.45; cursor: not-allowed; }

      .storyboard-panel {
        display: grid;
        grid-template-columns: minmax(0, 1.25fr) minmax(300px, 0.9fr);
      }

      .storyboard-visual,
      .storyboard-copy {
        padding: 18px;
      }

      .storyboard-markdown {
        min-height: 280px;
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,0.05);
        background: rgba(255,255,255,0.02);
        padding: 14px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.6;
      }

      .artifact-meta-bar {
        padding: 14px 16px;
        border: 1px solid rgba(255,255,255,0.05);
        border-radius: 16px;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02)),
          rgba(255,255,255,0.015);
      }

      .version-rail-shell {
        padding: 12px;
      }

      .version-rail {
        display: flex;
        gap: 12px;
        overflow-x: auto;
        overscroll-behavior-x: contain;
        padding-bottom: 2px;
        scrollbar-width: thin;
      }

      .version-tile {
        flex: 0 0 196px;
        display: block;
        padding: 0;
        border-radius: 16px;
        border: 1px solid rgba(255,255,255,0.06);
        background:
          linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02)),
          rgba(255,255,255,0.02);
        text-decoration: none;
        transition:
          transform 120ms ease,
          border-color 120ms ease,
          background-color 120ms ease;
      }

      .version-tile:hover {
        border-color: rgba(125,211,252,0.34);
      }

      .version-tile-active {
        border-color: rgba(159,232,112,0.42);
        background:
          linear-gradient(180deg, rgba(159,232,112,0.14), rgba(255,255,255,0.02)),
          rgba(255,255,255,0.025);
      }

      .version-tile-current {
        box-shadow: inset 0 0 0 1px rgba(125,211,252,0.12);
      }

      .version-visual {
        position: relative;
        aspect-ratio: 16 / 9;
        border-radius: 15px;
        background: var(--panel-strong);
        overflow: hidden;
      }

      .version-media {
        object-fit: contain;
        background: #080a0d;
      }

      .version-badges {
        position: absolute;
        top: 10px;
        right: 10px;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 6px;
        z-index: 1;
      }

      .version-badges .pill {
        padding: 6px 8px;
        font-size: 10px;
        background: rgba(17,21,29,0.78);
        backdrop-filter: blur(8px);
      }

      .detail-side-nav {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .shot {
        display: grid;
        grid-template-columns: 90px 1fr;
        gap: 16px;
      }

      .shot-id {
        padding-top: 8px;
        color: var(--soft);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        text-align: right;
      }

      .shot-frames {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
        gap: 14px;
      }

      .slot {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .slot-link,
      .card-link {
        text-decoration: none;
      }

      .shot-review-layout {
        display: grid;
        grid-template-columns: minmax(0, 1.2fr) minmax(260px, 0.9fr);
        gap: 18px;
        padding: 18px;
      }

      .shot-review-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding: 16px 18px 0;
      }

      .shot-meta-grid {
        display: grid;
        gap: 10px;
      }

      .shot-meta-item {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding-bottom: 10px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }

      .section-title {
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--soft);
      }

      .reference-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .reference-item {
        padding: 14px;
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,0.05);
        background: rgba(255,255,255,0.02);
      }

      .reference-item-title {
        font-size: 13px;
        font-weight: 700;
        color: var(--text);
      }

      .reference-item-path {
        color: var(--accent-2);
        font-size: 12px;
        word-break: break-word;
      }

      form {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      textarea,
      input[type="text"] {
        width: 100%;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 14px;
        background: rgba(255,255,255,0.02);
        color: var(--text);
        font: inherit;
        padding: 14px;
      }

      textarea {
        min-height: 150px;
        resize: vertical;
        line-height: 1.55;
      }

      .job-banner {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }

      .empty-state {
        padding: 20px;
        border: 1px dashed rgba(255,255,255,0.12);
        border-radius: 14px;
        color: var(--soft);
        background: rgba(255,255,255,0.015);
      }

      .form-note {
        color: var(--soft);
        font-size: 12px;
        line-height: 1.45;
      }

      .spacer {
        height: 4px;
      }

      @media (max-width: 980px) {
        .detail-layout,
        .storyboard-panel,
        .shot-review-layout {
          grid-template-columns: 1fr;
        }

        .detail-side {
          border-left: none;
          border-top: 1px solid var(--line);
        }

        .artifact-meta-bar { padding: 14px; }
      }

      @media (max-width: 720px) {
        .board { padding: 16px; }
        .hero { flex-direction: column; }
        .shot { grid-template-columns: 1fr; }
        .shot-id { text-align: left; }
        .character-grid { grid-template-columns: 1fr 1fr; }
        .version-tile { flex-basis: 170px; }
      }
    </style>
  </head>
  <body class="${bodyClass}">
    <div class="${boardClass}">
      ${options.embedded ? '' : renderTabs(activeTab)}
      ${content}
    </div>
  </body>
</html>`
}

function redirectTo(location: string, status = 303) {
  return new Response(null, {
    status,
    headers: {
      location,
    },
  })
}

function renderHero(title: string, subtitle: string, eyebrow: string, actions = '') {
  return `
    <section class="hero">
      <div class="hero-copy">
        <p class="hero-label">${escapeHtml(eyebrow)}</p>
        <h1 class="hero-title">${escapeHtml(title)}</h1>
        <p class="hero-subtitle">${escapeHtml(subtitle)}</p>
      </div>
      ${actions}
    </section>
  `
}

function renderErrorPage(activeTab: Tab, title: string, message: string, backHref: string) {
  return new Response(
    renderPage(
      activeTab,
      `<div class="stack">
        ${renderHero(title, message, 'Review Error', `<div class="summary-actions"><a class="button button-secondary" href="${backHref}">Back</a></div>`)}
      </div>`,
    ),
    {
      status: 404,
      headers: HTML_HEADERS,
    },
  )
}

function formatDurationSeconds(durationSeconds: number) {
  return Number.isInteger(durationSeconds)
    ? `${durationSeconds}s`
    : `${durationSeconds.toFixed(1)}s`
}

function renderPlaceholder(label: string, variant: PlaceholderVariant = 'missing') {
  return `<div class="placeholder placeholder-${variant}">${escapeHtml(label)}</div>`
}

function renderMediaBlock(options: {
  mediaType: 'image' | 'video'
  mediaUrl: string | null
  mediaExists: boolean
  alt: string
  placeholder: string
  placeholderVariant?: PlaceholderVariant
  className: string
}) {
  if (!options.mediaUrl || !options.mediaExists) {
    return renderPlaceholder(options.placeholder, options.placeholderVariant)
  }

  if (options.mediaType === 'video') {
    return `<video class="${options.className}" src="${options.mediaUrl}" controls preload="metadata" playsinline></video>`
  }

  return `<img class="${options.className}" src="${options.mediaUrl}" alt="${escapeHtml(options.alt)}" loading="lazy">`
}

function buildReferenceEditorValue(references: ArtifactReferenceEntry[]) {
  return `${JSON.stringify(references, null, 2)}`
}

function buildVersionRailItems(context: ArtifactDetailContext): VersionRailItem[] {
  return [
    {
      versionId: CURRENT_BASE_VERSION_ID,
      label: 'Current',
      href: getArtifactDetailPath(context.descriptor),
      mediaUrl: getCanonicalMediaUrl(context.descriptor),
      mediaExists: context.historyState.currentExists,
      isActive: context.historyState.isViewingCurrent,
      isCurrent: true,
    },
    ...context.historyState.versions.map((version) => ({
      versionId: version.versionId,
      label: version.versionId.toUpperCase(),
      href: `${getArtifactDetailPath(context.descriptor)}?version=${encodeURIComponent(version.versionId)}`,
      mediaUrl: getArtifactVersionMediaUrl(context.descriptor, version.versionId),
      mediaExists: true,
      isActive: context.historyState.activeVersionId === version.versionId,
      isCurrent: false,
    })),
  ]
}

function renderVersionRailMedia(context: ArtifactDetailContext, item: VersionRailItem) {
  if (!item.mediaUrl || !item.mediaExists) {
    return renderPlaceholder(context.mediaPlaceholder, context.mediaPlaceholderVariant)
  }

  if (context.mediaType === 'video') {
    return `<video class="version-media" src="${item.mediaUrl}" muted autoplay loop playsinline preload="metadata"></video>`
  }

  return `<img class="version-media" src="${item.mediaUrl}" alt="${escapeHtml(`${context.title} ${item.label}`)}" loading="lazy">`
}

function renderVersionRail(context: ArtifactDetailContext) {
  const items = buildVersionRailItems(context)

  return `
    <section class="panel version-rail-shell">
      <div class="version-rail">
        ${items
          .map((item) => {
            const tileClass = [
              'version-tile',
              item.isActive ? 'version-tile-active' : '',
              item.isCurrent ? 'version-tile-current' : '',
            ]
              .filter(Boolean)
              .join(' ')

            return `
              <a
                class="${tileClass}"
                href="${item.href}"
                data-version-id="${escapeHtml(item.versionId)}"
              >
                <div class="version-visual">
                  <div class="version-badges">
                    <span class="pill ${item.isCurrent ? 'pill-info' : ''}">${escapeHtml(item.label)}</span>
                    ${item.isActive ? '<span class="pill pill-accent">Viewing</span>' : ''}
                  </div>
                  ${renderVersionRailMedia(context, item)}
                </div>
              </a>
            `
          })
          .join('')}
      </div>
    </section>
  `
}

function renderReferenceList(references: readonly ResolvedArtifactReference[]) {
  if (references.length === 0) {
    return '<div class="empty-state">No retained references recorded for this version yet.</div>'
  }

  return `
    <div class="reference-list">
      ${references
        .map((reference) => {
          const summary = summarizeReference(reference)
          const toneClass = reference.source === 'user' ? 'pill-info' : 'pill'

          return `
            <div class="reference-item">
              <div class="pill-row">
                <span class="pill ${toneClass}">${escapeHtml(reference.source)}</span>
                ${reference.kind ? `<span class="pill">${escapeHtml(reference.kind)}</span>` : ''}
              </div>
              <div class="spacer"></div>
              <p class="reference-item-title">${escapeHtml(summary.title)}</p>
              <p class="reference-item-path">${escapeHtml(summary.subtitle)}</p>
              <p class="small">${escapeHtml(summary.detail)}</p>
            </div>
          `
        })
        .join('')}
    </div>
  `
}

function renderReferenceEditor(
  actionUrl: string,
  references: ArtifactReferenceEntry[],
  editable: boolean,
  helpText: string,
) {
  return `
    <section class="panel">
      <p class="section-title">Source References</p>
      <p class="form-note">${escapeHtml(helpText)}</p>
      <form method="post" action="${actionUrl}">
        <textarea name="referencesJson" spellcheck="false" ${editable ? '' : 'disabled'}>${escapeHtml(buildReferenceEditorValue(references))}</textarea>
        <div class="form-actions">
          <button class="button-primary" type="submit" ${editable ? '' : 'disabled'}>Save references</button>
        </div>
      </form>
    </section>
  `
}

function renderArtifactMeta(context: ArtifactDetailContext) {
  return `
    <section class="artifact-meta-bar">
      <p class="muted">${escapeHtml(context.subtitle)}</p>
    </section>
  `
}

function renderDetailSideNav(context: ArtifactDetailContext, options: { embedded?: boolean } = {}) {
  if (options.embedded) {
    return ''
  }

  if (context.summaryHref === getArtifactDetailPath(context.descriptor)) {
    return ''
  }

  return `
    <div class="detail-side-nav">
      <a class="button button-secondary" href="${context.summaryHref}">${escapeHtml(context.summaryLabel)}</a>
    </div>
  `
}

function renderJobBanner(job: ArtifactJobState | null) {
  if (!job) {
    return ''
  }

  const toneClass =
    job.status === 'running' ? 'pill-info' : job.status === 'success' ? 'pill-accent' : 'pill-error'

  return `
    <section class="job-banner">
      <div class="pill-row">
        <span class="pill ${toneClass}">${escapeHtml(job.status)}</span>
        ${job.versionId ? `<span class="pill">${escapeHtml(job.versionId)}</span>` : ''}
      </div>
      <p class="muted">${escapeHtml(job.message)}</p>
      <p class="small">Started ${escapeHtml(job.startedAt)}${job.completedAt ? ` • Finished ${escapeHtml(job.completedAt)}` : ''}</p>
    </section>
  `
}

function renderHistoricalVersionActions(context: ArtifactDetailContext) {
  const activeVersion = context.historyState.activeVersion

  if (!activeVersion || context.historyState.isViewingCurrent) {
    return ''
  }

  const deleteMessage = `Delete retained version ${activeVersion.versionId}? This cannot be undone.`

  return `
    <section class="panel">
      <p class="section-title">Historical Version</p>
      <p class="form-note">You are viewing retained ${escapeHtml(activeVersion.versionId)} from ${escapeHtml(activeVersion.createdAt)}. Promote it to the public artifact, return to the current selection, or delete this retained version.</p>
      <div class="version-actions">
        <form method="post" action="${getArtifactSelectActionPath(context.descriptor)}">
          <input type="hidden" name="versionId" value="${escapeHtml(activeVersion.versionId)}">
          <button class="button-primary" type="submit">Make current</button>
        </form>
        <a class="button button-secondary" href="${getArtifactDetailPath(context.descriptor)}">Go to current</a>
        <form method="post" action="${getArtifactDeleteActionPath(context.descriptor)}" onsubmit="return window.confirm(${escapeHtml(JSON.stringify(deleteMessage))})">
          <input type="hidden" name="versionId" value="${escapeHtml(activeVersion.versionId)}">
          <button class="button-danger" type="submit">Delete</button>
        </form>
      </div>
    </section>
  `
}

function renderEditComposer(context: ArtifactDetailContext) {
  if (context.primaryAction.kind === 'create-keyframe') {
    return `
      <section class="panel">
        <p class="section-title">Create Keyframe</p>
        <p class="form-note">Add this omitted anchor by writing a full fresh prompt. The prompt is saved to the new sidecar before generation starts.</p>
        <form method="post" action="${context.primaryAction.actionUrl}">
          <textarea name="prompt" placeholder="Write the full prompt for this new keyframe." required></textarea>
          <div class="form-actions">
            <button class="button-primary" type="submit">Create keyframe</button>
          </div>
        </form>
      </section>
    `
  }

  if (!context.primaryAction.enabled) {
    return `
      <section class="panel">
        <p class="section-title">Regenerate</p>
        <div class="empty-state">A current or retained artifact is required before regeneration can start.</div>
      </section>
    `
  }

  return `
    <section class="panel">
      <p class="section-title">Regenerate</p>
      <form method="post" action="${context.primaryAction.actionUrl}">
        <input type="hidden" name="baseVersionId" value="${escapeHtml(context.historyState.activeVersionId ?? CURRENT_BASE_VERSION_ID)}">
        <textarea name="regenerateRequest" placeholder="Describe the precise change you want from the version you are viewing." required></textarea>
        <div class="form-actions">
          <button class="button-primary" type="submit">Regenerate</button>
        </div>
      </form>
    </section>
  `
}

function renderRemoveAction(context: ArtifactDetailContext) {
  if (!context.removeAction) {
    return ''
  }

  return `
    <section class="panel">
      <p class="section-title">Anchor Planning</p>
      <p class="form-note">${escapeHtml(context.removeAction.helpText)}</p>
      <form
        method="post"
        action="${context.removeAction.actionUrl}"
        ${context.removeAction.confirmMessage ? `onsubmit="return window.confirm(${escapeHtml(JSON.stringify(context.removeAction.confirmMessage))})"` : ''}
      >
        <button class="button-danger" type="submit" ${context.removeAction.enabled ? '' : 'disabled'}>Remove keyframe</button>
      </form>
    </section>
  `
}

function renderDetailPage(
  context: ArtifactDetailContext,
  job: ArtifactJobState | null,
  options: { embedded?: boolean } = {},
) {
  const content = `
    <div class="stack">
      ${renderVersionRail(context)}
      ${renderJobBanner(job)}
      <section class="detail-layout">
        <div class="detail-main">
          <div class="detail-visual">
            ${renderMediaBlock({
              mediaType: context.mediaType,
              mediaUrl: context.mediaUrl,
              mediaExists: context.mediaExists,
              alt: context.title,
              placeholder: context.mediaPlaceholder,
              placeholderVariant: context.mediaPlaceholderVariant,
              className: '',
            })}
          </div>
          ${renderArtifactMeta(context)}
          <section class="panel">
            <p class="section-title">Source Prompt</p>
            <div class="meta-stack">
              <p class="muted">${escapeHtml(context.sourcePrompt ?? 'No source prompt available for this artifact.')}</p>
              ${context.sourceModel ? `<p class="small">Model: ${escapeHtml(context.sourceModel)}</p>` : ''}
            </div>
          </section>
          ${context.notesHtml}
        </div>
        <div class="detail-side">
          ${renderDetailSideNav(context, options)}
          ${renderHistoricalVersionActions(context)}
          ${renderEditComposer(context)}
          ${renderRemoveAction(context)}
          ${renderReferenceEditor(
            getArtifactReferencesActionPath(context.descriptor),
            context.sourceReferences,
            context.canEditReferences,
            'Edit the source sidecar references as JSON. Use repo-relative paths, required kind, and optional label and notes fields.',
          )}
        </div>
      </section>
    </div>
  `

  return new Response(
    renderPage(context.activeTab, content, {
      autoRefresh: job?.status === 'running',
      embedded: options.embedded,
    }),
    {
      headers: HTML_HEADERS,
    },
  )
}

function renderCharacterCard(card: CharacterReviewCard) {
  return `
    <a class="character-card" href="/characters/${encodeURIComponent(card.characterId)}">
      <div class="character-visual">
        ${renderMediaBlock({
          mediaType: 'image',
          mediaUrl: card.imageUrl,
          mediaExists: card.imageExists,
          alt: card.displayName,
          placeholder: 'No image',
          className: '',
        })}
      </div>
      <div class="card-copy">
        <p class="eyebrow">${escapeHtml(card.status)}</p>
        <p class="title">${escapeHtml(card.displayName)}</p>
        <p class="muted">${escapeHtml(card.prompt)}</p>
      </div>
    </a>
  `
}

function renderCharactersSummary(cards: CharacterReviewCard[]) {
  return new Response(
    renderPage(
      'characters',
      `<div class="stack">
        ${renderHero('Characters', 'Open a character to inspect the current image, retained history, and source references.', 'Review Surface')}
        ${
          cards.length === 0
            ? '<div class="empty-state">No characters yet.</div>'
            : `<div class="character-grid">${cards.map(renderCharacterCard).join('')}</div>`
        }
      </div>`,
    ),
    {
      headers: HTML_HEADERS,
    },
  )
}

async function loadWorkspaceMarkdownDocument(fileName: string, cwd: string) {
  try {
    return await readFile(resolveWorkflowPath(fileName, cwd), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

function renderWorkspaceMarkdownDocumentPage(options: {
  activeTab: Tab
  title: string
  eyebrow: string
  subtitle: string
  sectionTitle: string
  markdown: string | null
  emptyState: string
}) {
  return new Response(
    renderPage(
      options.activeTab,
      `<div class="stack">
        ${renderHero(options.title, options.subtitle, options.eyebrow)}
        <section class="panel">
          <p class="section-title">${escapeHtml(options.sectionTitle)}</p>
          ${
            options.markdown
              ? `<pre class="storyboard-markdown">${escapeHtml(options.markdown.trim())}</pre>`
              : `<div class="empty-state">${escapeHtml(options.emptyState)}</div>`
          }
        </section>
      </div>`,
    ),
    {
      headers: HTML_HEADERS,
    },
  )
}

function getArtifactDetailPath(descriptor: ArtifactDescriptor) {
  switch (descriptor.artifactType) {
    case 'storyboard':
      return '/storyboard'
    case 'character':
      return `/characters/${encodeURIComponent(descriptor.artifactId)}`
    case 'keyframe':
      return `/keyframes/${encodeURIComponent(descriptor.artifactId)}`
    case 'shot':
      return `/shots/${encodeURIComponent(descriptor.artifactId)}`
  }
}

function getArtifactReferencesActionPath(descriptor: ArtifactDescriptor) {
  return `${getArtifactDetailPath(descriptor)}/references`
}

function getArtifactRegenerateActionPath(descriptor: ArtifactDescriptor) {
  return `${getArtifactDetailPath(descriptor)}/regenerate`
}

function getArtifactCreateActionPath(descriptor: ArtifactDescriptor) {
  return `${getArtifactDetailPath(descriptor)}/create`
}

function getArtifactSelectActionPath(descriptor: ArtifactDescriptor) {
  return `${getArtifactDetailPath(descriptor)}/select`
}

function getArtifactDeleteActionPath(descriptor: ArtifactDescriptor) {
  return `${getArtifactDetailPath(descriptor)}/delete`
}

function getArtifactRemoveActionPath(descriptor: ArtifactDescriptor) {
  return `${getArtifactDetailPath(descriptor)}/remove`
}

function getArtifactVersionMediaUrl(descriptor: ArtifactDescriptor, versionId: string) {
  return `${getArtifactDetailPath(descriptor)}/versions/${encodeURIComponent(versionId)}/media`
}

function getCanonicalMediaUrl(descriptor: ArtifactDescriptor) {
  return `/${encodeAssetUrl(descriptor.publicPath)}`
}

function isCurrentBaseVersionId(versionId: string) {
  return versionId === CURRENT_BASE_VERSION_ID
}

function getBaseVersionMediaPath(descriptor: ArtifactDescriptor, versionId: string) {
  return isCurrentBaseVersionId(versionId)
    ? descriptor.publicPath
    : getArtifactVersionMediaPath(descriptor, versionId)
}

function parseReferenceEditorInput(rawValue: string) {
  const parsed = JSON.parse(rawValue) as unknown

  if (!Array.isArray(parsed)) {
    throw new Error('Reference editor input must be a JSON array.')
  }

  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Reference ${index + 1} must be an object.`)
    }

    const object = entry as Record<string, unknown>

    if (typeof object.path !== 'string' || object.path.trim().length === 0) {
      throw new Error(`Reference ${index + 1} must include a non-empty path.`)
    }

    if (typeof object.kind !== 'string' || !AUTHORED_REFERENCE_KINDS.includes(object.kind as any)) {
      throw new Error(
        `Reference ${index + 1} must include a kind from: ${AUTHORED_REFERENCE_KINDS.join(', ')}.`,
      )
    }

    return {
      path: normalizeRepoRelativePath(object.path, `Reference ${index + 1} path`),
      kind: object.kind as ArtifactReferenceEntry['kind'],
      label: typeof object.label === 'string' ? object.label : undefined,
      notes: typeof object.notes === 'string' ? object.notes : undefined,
    } satisfies ArtifactReferenceEntry
  })
}

async function writeArtifactSidecarReferences(
  descriptor: ArtifactDescriptor,
  references: ArtifactReferenceEntry[],
  cwd: string,
) {
  if (!descriptor.sidecarPath) {
    throw new Error(`${descriptor.displayName} does not expose a writable sidecar.`)
  }

  const sidecarAbsolutePath = resolveRepoPath(descriptor.sidecarPath, cwd)
  const raw = await readFile(sidecarAbsolutePath, 'utf8').catch(() => null)
  const existing = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}

  if (descriptor.artifactType !== 'storyboard' && raw === null) {
    throw new Error(`${descriptor.displayName} is missing its source sidecar.`)
  }

  if (references.length === 0) {
    delete existing.references
  } else {
    existing.references = references
  }

  await writeFile(sidecarAbsolutePath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8')
}

async function buildCharacterCards(cwd: string) {
  const characters = await loadCharacterSheetsOrEmpty(cwd)

  return Promise.all(
    characters.map(async (entry) => {
      const imagePath = getCharacterSheetImagePath(entry.characterId)

      return {
        characterId: entry.characterId,
        displayName: entry.displayName,
        prompt: entry.prompt,
        status: entry.status,
        imageUrl: `/${encodeAssetUrl(imagePath)}`,
        imageExists: await fileExists(resolveRepoPath(imagePath, cwd)),
      } satisfies CharacterReviewCard
    }),
  )
}

async function loadCharacterDetail(
  characterId: string,
  cwd: string,
  requestedVersionId?: string | null,
) {
  const [config, characters] = await Promise.all([
    loadConfig(cwd).catch(() => null),
    loadCharacterSheetsOrEmpty(cwd),
  ])
  const character = characters.find((entry) => entry.characterId === characterId)

  if (!character) {
    return null
  }

  const descriptor = getCharacterArtifactDescriptor(characterId)
  const historyState = await loadArtifactHistoryState(descriptor, cwd, {
    activeVersionId: requestedVersionId,
  })
  const activeVersionId = historyState.activeVersionId

  return {
    descriptor,
    activeTab: 'characters' as const,
    title: character.displayName,
    subtitle:
      'Review the current artifact, browse retained versions, update the source reference stack, and request targeted edits.',
    summaryHref: '/',
    summaryLabel: 'Back to characters',
    mediaType: 'image' as const,
    mediaUrl: activeVersionId
      ? getArtifactVersionMediaUrl(descriptor, activeVersionId)
      : getCanonicalMediaUrl(descriptor),
    mediaExists: activeVersionId !== null ? true : historyState.currentExists,
    mediaPlaceholder: 'No character image yet',
    mediaPlaceholderVariant: 'missing',
    sourceReferences: character.references ?? [],
    sourcePrompt: character.prompt,
    sourceModel: config?.imageModel ?? null,
    sourceStatus: character.status,
    historyState,
    notesHtml: `<section class="panel"><p class="section-title">Current Prompt</p><p class="muted">${escapeHtml(character.prompt)}</p></section>`,
    canEdit: historyState.currentExists || historyState.activeVersionId !== null,
    canEditReferences: true,
    primaryAction: {
      kind: 'regenerate',
      actionUrl: getArtifactRegenerateActionPath(descriptor),
      enabled: historyState.currentExists || historyState.activeVersionId !== null,
    },
    removeAction: null,
  } satisfies ArtifactDetailContext
}

async function loadKeyframeDetail(
  keyframeId: string,
  cwd: string,
  requestedVersionId?: string | null,
) {
  const [config, keyframes, artifacts, shots] = await Promise.all([
    loadConfig(cwd).catch(() => null),
    loadKeyframesOrEmpty(cwd),
    loadKeyframeArtifactsOrEmpty(cwd),
    loadShotPromptsOrEmpty(cwd),
  ])
  const keyframe = keyframes.find((entry) => entry.keyframeId === keyframeId)

  if (!keyframe) {
    return null
  }

  const artifact = artifacts.find((entry) => entry.keyframeId === keyframeId)
  const descriptor = getKeyframeArtifactDescriptor(keyframe)
  const historyState = await loadArtifactHistoryState(descriptor, cwd, {
    activeVersionId: requestedVersionId,
  })
  const activeVersionId = historyState.activeVersionId
  const shot = shots.find((entry) => entry.shotId === keyframe.shotId) ?? null
  const canRemoveAnchor = (shot?.keyframeIds.length ?? 0) > 1

  return {
    descriptor,
    activeTab: 'timeline' as const,
    title: keyframe.keyframeId,
    subtitle:
      'Use the current artifact, retained versions, and explicit references to iterate on a single keyframe without manual file copying.',
    summaryHref: '/timeline',
    summaryLabel: 'Back to timeline',
    mediaType: 'image' as const,
    mediaUrl: activeVersionId
      ? getArtifactVersionMediaUrl(descriptor, activeVersionId)
      : getCanonicalMediaUrl(descriptor),
    mediaExists: activeVersionId !== null ? true : historyState.currentExists,
    mediaPlaceholder: 'No keyframe image yet',
    mediaPlaceholderVariant: 'missing',
    sourceReferences: artifact?.references ?? [],
    sourcePrompt: artifact?.prompt ?? null,
    sourceModel: config?.imageModel ?? null,
    sourceStatus: artifact?.status ?? 'planned',
    historyState,
    notesHtml: `<section class="panel"><p class="section-title">Keyframe Plan</p><p class="muted">Shot: ${escapeHtml(keyframe.shotId)}</p><p class="small">Frame type: ${escapeHtml(keyframe.frameType)}</p></section>`,
    canEdit:
      (historyState.currentExists || historyState.activeVersionId !== null) &&
      artifact !== undefined,
    canEditReferences: artifact !== undefined,
    primaryAction: {
      kind: 'regenerate',
      actionUrl: getArtifactRegenerateActionPath(descriptor),
      enabled:
        (historyState.currentExists || historyState.activeVersionId !== null) &&
        artifact !== undefined,
    },
    removeAction: {
      actionUrl: getArtifactRemoveActionPath(descriptor),
      enabled: canRemoveAnchor,
      helpText: canRemoveAnchor
        ? `Remove this ${frameTypeLabel(keyframe.frameType).toLowerCase()} anchor and collapse the shot back to its remaining planned keyframe.`
        : 'This is the only planned anchor for the shot, so it cannot be removed.',
      confirmMessage: canRemoveAnchor
        ? `Remove planned keyframe ${keyframe.keyframeId} and delete its sidecar, current image, and retained history?`
        : undefined,
    },
  } satisfies ArtifactDetailContext
}

async function loadOmittedKeyframeDetail(
  keyframeId: string,
  cwd: string,
  requestedVersionId?: string | null,
) {
  const [config, shots] = await Promise.all([
    loadConfig(cwd).catch(() => null),
    loadShotPromptsOrEmpty(cwd),
  ])
  const match = getShotByCanonicalKeyframeId(shots, keyframeId)

  if (!match || match.shot.keyframeIds.includes(keyframeId)) {
    return null
  }

  const descriptor = getKeyframeArtifactDescriptor({
    keyframeId,
    shotId: match.shotId,
  })
  const historyState = await loadArtifactHistoryState(descriptor, cwd, {
    activeVersionId: requestedVersionId,
  })

  return {
    descriptor,
    activeTab: 'timeline' as const,
    title: keyframeId,
    subtitle:
      'This anchor is currently omitted from the shot plan. Create it only when the shot needs a distinct extra start or end frame.',
    summaryHref: '/timeline',
    summaryLabel: 'Back to timeline',
    mediaType: 'image' as const,
    mediaUrl: null,
    mediaExists: false,
    mediaPlaceholder: `No ${match.frameType} keyframe planned`,
    mediaPlaceholderVariant: 'omitted',
    sourceReferences: [],
    sourcePrompt: null,
    sourceModel: config?.imageModel ?? null,
    sourceStatus: 'omitted',
    historyState,
    notesHtml: `<section class="panel"><p class="section-title">Keyframe Plan</p><p class="muted">Shot: ${escapeHtml(match.shotId)}</p><p class="small">Frame type: ${escapeHtml(match.frameType)}</p><p class="small">Current planned anchors: ${escapeHtml(match.shot.keyframeIds.join(' -> '))}</p></section>`,
    canEdit: false,
    canEditReferences: false,
    primaryAction: {
      kind: 'create-keyframe',
      actionUrl: getArtifactCreateActionPath(descriptor),
      enabled: true,
    },
    removeAction: null,
  } satisfies ArtifactDetailContext
}

async function loadShotDetail(shotId: string, cwd: string, requestedVersionId?: string | null) {
  const [config, shots, artifacts] = await Promise.all([
    loadConfig(cwd).catch(() => null),
    loadShotPromptsOrEmpty(cwd),
    loadShotArtifactsOrEmpty(cwd),
  ])
  const shot = shots.find((entry) => entry.shotId === shotId)

  if (!shot) {
    return null
  }

  const artifact = artifacts.find((entry) => entry.shotId === shotId)
  const descriptor = getShotArtifactDescriptor(shotId)
  const historyState = await loadArtifactHistoryState(descriptor, cwd, {
    activeVersionId: requestedVersionId,
  })
  const activeVersionId = historyState.activeVersionId

  return {
    descriptor,
    activeTab: 'timeline' as const,
    title: shotId,
    subtitle:
      'Review the current motion artifact, edit the source reference stack, and promote any retained version back to the stable public MP4 path.',
    summaryHref: '/timeline',
    summaryLabel: 'Back to timeline',
    mediaType: 'video' as const,
    mediaUrl: activeVersionId
      ? getArtifactVersionMediaUrl(descriptor, activeVersionId)
      : getCanonicalMediaUrl(descriptor),
    mediaExists: activeVersionId !== null ? true : historyState.currentExists,
    mediaPlaceholder: 'No shot video yet',
    mediaPlaceholderVariant: 'missing',
    sourceReferences: artifact?.references ?? [],
    sourcePrompt: artifact?.prompt ?? null,
    sourceModel: config?.videoModel ?? null,
    sourceStatus: artifact?.status ?? shot.status,
    historyState,
    notesHtml: `<section class="panel"><p class="section-title">Shot Plan</p><p class="muted">Anchors: ${escapeHtml(shot.keyframeIds.join(' -> '))}</p><p class="small">Duration: ${escapeHtml(formatDurationSeconds(shot.durationSeconds))}</p></section>`,
    canEdit:
      (historyState.currentExists || historyState.activeVersionId !== null) &&
      artifact !== undefined,
    canEditReferences: artifact !== undefined,
    primaryAction: {
      kind: 'regenerate',
      actionUrl: getArtifactRegenerateActionPath(descriptor),
      enabled:
        (historyState.currentExists || historyState.activeVersionId !== null) &&
        artifact !== undefined,
    },
    removeAction: null,
  } satisfies ArtifactDetailContext
}

async function loadStoryboardDetail(cwd: string, requestedVersionId?: string | null) {
  const [config, markdown, storyboardSidecar] = await Promise.all([
    loadConfig(cwd).catch(() => null),
    readFile(resolveWorkflowPath(WORKFLOW_FILES.storyboard, cwd), 'utf8').catch(() => null),
    loadStoryboardSidecar(cwd),
  ])
  const descriptor = getStoryboardArtifactDescriptor()
  const historyState = await loadArtifactHistoryState(descriptor, cwd, {
    activeVersionId: requestedVersionId,
  })
  const activeVersionId = historyState.activeVersionId

  return {
    descriptor,
    activeTab: 'storyboard' as const,
    title: 'Storyboard',
    subtitle:
      'The storyboard board acts as a retained visual artifact with explicit references and simple filesystem-based history.',
    summaryHref: '/storyboard',
    summaryLabel: 'Storyboard overview',
    mediaType: 'image' as const,
    mediaUrl: activeVersionId
      ? getArtifactVersionMediaUrl(descriptor, activeVersionId)
      : getCanonicalMediaUrl(descriptor),
    mediaExists: activeVersionId !== null ? true : historyState.currentExists,
    mediaPlaceholder: 'No storyboard image yet',
    mediaPlaceholderVariant: 'missing',
    sourceReferences: storyboardSidecar?.references ?? [],
    sourcePrompt: markdown,
    sourceModel: config?.imageModel ?? null,
    sourceStatus: historyState.currentExists ? 'ready' : 'missing',
    historyState,
    notesHtml: `<section class="panel"><p class="section-title">Source Storyboard</p>${markdown ? `<pre class="storyboard-markdown">${escapeHtml(markdown.trim())}</pre>` : '<div class="empty-state">No storyboard markdown yet.</div>'}</section>`,
    canEdit: historyState.currentExists || historyState.activeVersionId !== null,
    canEditReferences: true,
    primaryAction: {
      kind: 'regenerate',
      actionUrl: getArtifactRegenerateActionPath(descriptor),
      enabled: historyState.currentExists || historyState.activeVersionId !== null,
    },
    removeAction: null,
  } satisfies ArtifactDetailContext
}

async function getDetailContext(pathname: string, cwd: string, requestedVersionId?: string | null) {
  if (pathname === '/storyboard') {
    return loadStoryboardDetail(cwd, requestedVersionId)
  }

  const characterMatch = /^\/characters\/([^/]+)$/.exec(pathname)

  if (characterMatch) {
    return loadCharacterDetail(decodeURIComponent(characterMatch[1]!), cwd, requestedVersionId)
  }

  const keyframeMatch = /^\/keyframes\/([^/]+)$/.exec(pathname)

  if (keyframeMatch) {
    const keyframeId = decodeURIComponent(keyframeMatch[1]!)

    return (
      (await loadKeyframeDetail(keyframeId, cwd, requestedVersionId)) ??
      (await loadOmittedKeyframeDetail(keyframeId, cwd, requestedVersionId))
    )
  }

  const shotMatch = /^\/shots\/([^/]+)$/.exec(pathname)

  if (shotMatch) {
    return loadShotDetail(decodeURIComponent(shotMatch[1]!), cwd, requestedVersionId)
  }

  return null
}

async function assertBaseVersionExists(
  descriptor: ArtifactDescriptor,
  cwd: string,
  baseVersionId: string,
) {
  const state = await loadArtifactHistoryState(descriptor, cwd, {
    activeVersionId: isCurrentBaseVersionId(baseVersionId) ? null : baseVersionId,
  })

  if (isCurrentBaseVersionId(baseVersionId) ? state.currentExists : state.activeVersion) {
    return
  }

  throw new Error(
    `${descriptor.displayName} is missing the selected base version ${baseVersionId}.`,
  )
}

async function buildCharacterPendingGeneration(
  characterId: string,
  cwd: string,
): Promise<PendingCharacterSheetGeneration | null> {
  const [config, characterSheets] = await Promise.all([
    loadConfig(cwd),
    loadCharacterSheetsOrEmpty(cwd),
  ])
  const generations = selectPendingCharacterSheetGenerations(characterSheets, config.imageModel, {
    characterId,
  })

  return generations[0] ?? null
}

async function buildKeyframePendingGeneration(
  keyframeId: string,
  cwd: string,
): Promise<{
  generation: PendingKeyframeGeneration
  keyframes: KeyframeEntry[]
  shots: ShotEntry[]
} | null> {
  const [config, keyframes, artifacts, shots] = await Promise.all([
    loadConfig(cwd),
    loadKeyframesOrEmpty(cwd),
    loadKeyframeArtifactsOrEmpty(cwd),
    loadShotPromptsOrEmpty(cwd),
  ])
  const generations = selectPendingKeyframeGenerations(
    keyframes,
    artifacts,
    shots,
    config.imageModel,
    {
      keyframeId,
    },
  )

  return generations[0]
    ? {
        generation: generations[0],
        keyframes,
        shots,
      }
    : null
}

async function buildShotPendingGeneration(
  shotId: string,
  cwd: string,
): Promise<{
  generation: PendingShotGeneration
  keyframes: KeyframeEntry[]
  characterSheets: CharacterSheetEntry[]
} | null> {
  const [config, shots, artifacts, keyframes, characterSheets] = await Promise.all([
    loadConfig(cwd),
    loadShotPromptsOrEmpty(cwd),
    loadShotArtifactsOrEmpty(cwd),
    loadKeyframesOrEmpty(cwd),
    loadCharacterSheetsOrEmpty(cwd),
  ])
  const generations = selectPendingShotGenerations(shots, artifacts, config.videoModel, { shotId })

  return generations[0]
    ? {
        generation: generations[0],
        keyframes,
        characterSheets,
      }
    : null
}

export async function runApprovedRegenerateAction(
  pathname: string,
  cwd: string,
  baseVersionId: string,
  regenerateRequest: string,
  overrides: RegenerateActionGeneratorOverrides = {},
) {
  if (pathname === '/storyboard') {
    const config = await loadConfig(cwd)
    const descriptor = getStoryboardArtifactDescriptor()

    return regenerateStoryboardArtifactVersion({
      model: config.imageModel,
      regenerateRequest,
      selectedVersionPath: getBaseVersionMediaPath(descriptor, baseVersionId),
      cwd,
      generator: overrides.imageGenerator,
    })
  }

  const characterMatch = /^\/characters\/([^/]+)$/.exec(pathname)

  if (characterMatch) {
    const characterId = decodeURIComponent(characterMatch[1]!)
    const generation = await buildCharacterPendingGeneration(characterId, cwd)

    if (!generation) {
      throw new Error(`Character "${characterId}" is missing a valid generation sidecar.`)
    }

    const descriptor = getCharacterArtifactDescriptor(characterId)

    return regenerateCharacterSheetArtifactVersion(generation, {
      regenerateRequest,
      selectedVersionPath: getBaseVersionMediaPath(descriptor, baseVersionId),
      cwd,
      generator: overrides.imageGenerator,
    })
  }

  const keyframeMatch = /^\/keyframes\/([^/]+)$/.exec(pathname)

  if (keyframeMatch) {
    const keyframeId = decodeURIComponent(keyframeMatch[1]!)
    const pending = await buildKeyframePendingGeneration(keyframeId, cwd)

    if (!pending) {
      throw new Error(`Keyframe "${keyframeId}" is missing a valid generation sidecar.`)
    }

    const descriptor = getKeyframeArtifactDescriptor(pending.generation)

    return regenerateKeyframeArtifactVersion(pending.generation, pending.keyframes, pending.shots, {
      regenerateRequest,
      selectedVersionPath: getBaseVersionMediaPath(descriptor, baseVersionId),
      cwd,
      generator: overrides.imageGenerator,
    })
  }

  const shotMatch = /^\/shots\/([^/]+)$/.exec(pathname)

  if (shotMatch) {
    const shotId = decodeURIComponent(shotMatch[1]!)
    const pending = await buildShotPendingGeneration(shotId, cwd)

    if (!pending) {
      throw new Error(`Shot "${shotId}" is missing a valid generation sidecar.`)
    }

    // Shot regeneration still uses the existing image-to-video anchor flow.
    // The current SDK path does not support passing the selected .mp4 back as
    // a true regeneration baseline.
    return regenerateShotArtifactVersion(
      pending.generation,
      pending.keyframes,
      pending.characterSheets,
      {
        regenerateRequest,
        baseVersionId,
        userReferences: pending.generation.userReferences ?? [],
        cwd,
        generator: overrides.shotVideoGenerator,
      },
    )
  }

  throw new Error('Unsupported regenerate route.')
}

async function serveCanonicalCharacterImage(requestPath: string, cwd: string) {
  const decodedPath = decodeURIComponent(requestPath.slice(1))
  const characters = await loadCharacterSheetsOrEmpty(cwd)
  const matchingEntry = characters.find(
    (entry) => getCharacterSheetImagePath(entry.characterId) === decodedPath,
  )

  if (!matchingEntry) {
    return new Response('Not Found', { status: 404 })
  }

  const absolutePath = resolveRepoPath(getCharacterSheetImagePath(matchingEntry.characterId), cwd)

  if (!(await fileExists(absolutePath))) {
    return new Response('Not Found', { status: 404 })
  }

  return new Response(Bun.file(absolutePath))
}

async function serveCanonicalStoryboardImage(requestPath: string, cwd: string) {
  const decodedPath = decodeURIComponent(requestPath.slice(1))

  if (decodedPath !== getStoryboardImagePath()) {
    return new Response('Not Found', { status: 404 })
  }

  const absolutePath = resolveRepoPath(getStoryboardImagePath(), cwd)

  if (!(await fileExists(absolutePath))) {
    return new Response('Not Found', { status: 404 })
  }

  return new Response(Bun.file(absolutePath))
}

async function serveCanonicalKeyframeImage(requestPath: string, cwd: string) {
  const decodedPath = decodeURIComponent(requestPath.slice(1))
  const keyframes = await loadKeyframesOrEmpty(cwd)
  const matchingEntry = keyframes.find((entry) => entry.imagePath === decodedPath)

  if (!matchingEntry) {
    return new Response('Not Found', { status: 404 })
  }

  const absolutePath = resolveRepoPath(matchingEntry.imagePath, cwd)

  if (!(await fileExists(absolutePath))) {
    return new Response('Not Found', { status: 404 })
  }

  return new Response(Bun.file(absolutePath))
}

async function serveCanonicalShotVideo(requestPath: string, cwd: string) {
  const decodedPath = decodeURIComponent(requestPath.slice(1))
  const shots = await loadShotPromptsOrEmpty(cwd)
  const matchingEntry = shots.find((entry) => entry.videoPath === decodedPath)

  if (!matchingEntry) {
    return new Response('Not Found', { status: 404 })
  }

  const absolutePath = resolveRepoPath(getShotVideoPath(matchingEntry), cwd)

  if (!(await fileExists(absolutePath))) {
    return new Response('Not Found', { status: 404 })
  }

  return new Response(Bun.file(absolutePath))
}

async function serveArtifactVersionMedia(
  descriptor: ArtifactDescriptor,
  versionId: string,
  cwd: string,
) {
  const absolutePath = resolveRepoPath(getArtifactVersionMediaPath(descriptor, versionId), cwd)

  if (!(await fileExists(absolutePath))) {
    return new Response('Not Found', { status: 404 })
  }

  return new Response(Bun.file(absolutePath))
}

function getJobState(jobs: Map<string, ArtifactJobState>, descriptor: ArtifactDescriptor) {
  return jobs.get(getArtifactKey(descriptor)) ?? null
}

function startArtifactJob(
  jobs: Map<string, ArtifactJobState>,
  descriptor: ArtifactDescriptor,
  run: () => Promise<{ versionId: string | null }>,
) {
  const key = getArtifactKey(descriptor)
  const current = jobs.get(key)

  if (current?.status === 'running') {
    throw new Error(`${descriptor.displayName} already has an active generation job.`)
  }

  jobs.set(key, {
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    message: `Generating a new retained version for ${descriptor.displayName}.`,
    versionId: null,
  })

  void run()
    .then((result) => {
      const message = result.versionId
        ? `Generation completed. Previous current archived as ${result.versionId}.`
        : 'Generation completed.'
      jobs.set(key, {
        status: 'success',
        startedAt: jobs.get(key)?.startedAt ?? new Date().toISOString(),
        completedAt: new Date().toISOString(),
        message,
        versionId: result.versionId,
      })
    })
    .catch((error) => {
      jobs.set(key, {
        status: 'error',
        startedAt: jobs.get(key)?.startedAt ?? new Date().toISOString(),
        completedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
        versionId: null,
      })
    })
}

async function handleReferenceSave(pathname: string, request: Request, cwd: string) {
  const detail = await getDetailContext(pathname, cwd)

  if (!detail) {
    return renderErrorPage('characters', 'Missing Artifact', 'Artifact not found.', '/')
  }

  const formData = await request.formData()
  const referencesJson = String(formData.get('referencesJson') ?? '[]')
  const references = parseReferenceEditorInput(referencesJson)

  await writeArtifactSidecarReferences(detail.descriptor, references, cwd)
  return redirectTo(getArtifactDetailPath(detail.descriptor))
}

async function handleRegenerate(
  pathname: string,
  request: Request,
  cwd: string,
  jobs: Map<string, ArtifactJobState>,
  overrides: RegenerateActionGeneratorOverrides,
) {
  const formData = await request.formData()
  const baseVersionId = String(formData.get('baseVersionId') ?? '').trim()
  const regenerateRequest = String(formData.get('regenerateRequest') ?? '').trim()
  const detail = await getDetailContext(pathname, cwd)

  if (!detail) {
    return renderErrorPage('characters', 'Missing Artifact', 'Artifact not found.', '/')
  }

  if (baseVersionId.length === 0 || regenerateRequest.length === 0) {
    throw new Error('Base version and regenerate request are required.')
  }

  await assertBaseVersionExists(detail.descriptor, cwd, baseVersionId)

  startArtifactJob(jobs, detail.descriptor, async () => {
    const result = await runApprovedRegenerateAction(
      pathname,
      cwd,
      baseVersionId,
      regenerateRequest,
      overrides,
    )

    return {
      versionId: result.versionId,
    }
  })

  return redirectTo(getArtifactDetailPath(detail.descriptor))
}

async function handleCreate(
  pathname: string,
  request: Request,
  cwd: string,
  jobs: Map<string, ArtifactJobState>,
  overrides: RegenerateActionGeneratorOverrides,
) {
  const detail = await getDetailContext(pathname, cwd)

  if (!detail) {
    return renderErrorPage('timeline', 'Missing Keyframe', 'Keyframe not found.', '/timeline')
  }

  if (detail.primaryAction.kind !== 'create-keyframe') {
    throw new Error(`Keyframe "${detail.descriptor.artifactId}" is already planned.`)
  }

  const formData = await request.formData()
  const prompt = String(formData.get('prompt') ?? '').trim()

  if (prompt.length === 0) {
    throw new Error('A prompt is required to create a keyframe.')
  }

  const descriptor = await createOmittedKeyframe(detail.descriptor.artifactId, prompt, cwd)

  startArtifactJob(jobs, descriptor, async () => {
    const pending = await buildKeyframePendingGeneration(descriptor.artifactId, cwd)

    if (!pending) {
      throw new Error(`Keyframe "${descriptor.artifactId}" is missing a valid generation sidecar.`)
    }

    const result = await generateKeyframeArtifactVersion(
      pending.generation,
      pending.keyframes,
      pending.shots,
      {
        cwd,
        generator: overrides.imageGenerator,
      },
    )

    return {
      versionId: result.versionId,
    }
  })

  return redirectTo(getArtifactDetailPath(descriptor))
}

async function handleSelect(pathname: string, request: Request, cwd: string) {
  const detail = await getDetailContext(pathname, cwd)

  if (!detail) {
    return renderErrorPage('characters', 'Missing Artifact', 'Artifact not found.', '/')
  }

  const formData = await request.formData()
  const versionId = String(formData.get('versionId') ?? '').trim()

  if (versionId.length === 0) {
    throw new Error('A retained versionId is required to reselect a version.')
  }

  await promoteArtifactVersion(detail.descriptor, versionId, cwd)
  return redirectTo(getArtifactDetailPath(detail.descriptor))
}

async function handleDelete(pathname: string, request: Request, cwd: string) {
  const detail = await getDetailContext(pathname, cwd)

  if (!detail) {
    return renderErrorPage('characters', 'Missing Artifact', 'Artifact not found.', '/')
  }

  const formData = await request.formData()
  const versionId = String(formData.get('versionId') ?? '').trim()

  if (versionId.length === 0) {
    throw new Error('A retained versionId is required to delete a version.')
  }

  await deleteArtifactVersion(detail.descriptor, versionId, cwd)
  return redirectTo(getArtifactDetailPath(detail.descriptor))
}

async function handleRemove(pathname: string, cwd: string) {
  const detail = await getDetailContext(pathname, cwd)

  if (!detail) {
    return renderErrorPage('timeline', 'Missing Keyframe', 'Keyframe not found.', '/timeline')
  }

  const descriptor = await removePlannedKeyframe(detail.descriptor.artifactId, cwd)
  return redirectTo(getArtifactDetailPath(descriptor))
}

async function handleTimelineUpdate(request: Request, cwd: string) {
  const payload = (await request.json()) as unknown

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Timeline update payload must be an object.')
  }

  const rawShots = (payload as { shots?: unknown }).shots

  if (!Array.isArray(rawShots)) {
    throw new Error('Timeline update payload must include a shots array.')
  }

  const shots = await loadShotPrompts(cwd)

  if (rawShots.length !== shots.length) {
    throw new Error('Timeline update must include exactly one duration for each shot.')
  }

  const nextShots = shots.map((shot, index) => {
    const rawEntry = rawShots[index]

    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
      throw new Error(`Timeline shot ${index + 1} must be an object.`)
    }

    const entry = rawEntry as {
      shotId?: unknown
      durationSeconds?: unknown
    }

    if (entry.shotId !== shot.shotId) {
      throw new Error('Timeline update must preserve shot order and identity.')
    }

    if (
      typeof entry.durationSeconds !== 'number' ||
      !Number.isFinite(entry.durationSeconds) ||
      !Number.isInteger(entry.durationSeconds) ||
      entry.durationSeconds < 1
    ) {
      throw new Error(`Timeline duration for shot "${shot.shotId}" must be a positive integer.`)
    }

    return {
      ...shot,
      durationSeconds: entry.durationSeconds,
    }
  })

  await writeShotPromptsFile(nextShots, cwd)

  return new Response(JSON.stringify({ status: 'ok' }), {
    headers: JSON_HEADERS,
  })
}

export function startArtifactReviewServer(
  options: {
    cwd?: string
    preferredPort?: number
    imageGenerator?: ImageGenerator
    shotVideoGenerator?: ShotVideoGenerator
  } = {},
) {
  const { cwd = process.cwd(), preferredPort = 3000, imageGenerator, shotVideoGenerator } = options
  const activeJobs = new Map<string, ArtifactJobState>()
  const generatorOverrides: RegenerateActionGeneratorOverrides = {
    imageGenerator,
    shotVideoGenerator,
  }

  const createServer = (port: number) =>
    Bun.serve({
      port,
      async fetch(request) {
        const url = new URL(request.url)
        const isEmbedded = url.searchParams.get('embed') === '1'

        if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
          return new Response('Method Not Allowed', {
            status: 405,
            headers: {
              allow: 'GET, HEAD, POST',
            },
          })
        }

        try {
          if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/') {
            return renderCharactersSummary(await buildCharacterCards(cwd))
          }

          if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/idea') {
            return renderWorkspaceMarkdownDocumentPage({
              activeTab: 'idea',
              title: 'Idea',
              eyebrow: 'Creative Brief',
              subtitle:
                'Review the current project idea and brief before moving into story, storyboard, and downstream artifact work.',
              sectionTitle: 'workspace/IDEA.md',
              markdown: await loadWorkspaceMarkdownDocument('IDEA.md', cwd),
              emptyState: 'No idea markdown yet.',
            })
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            url.pathname === '/story'
          ) {
            return renderWorkspaceMarkdownDocumentPage({
              activeTab: 'story',
              title: 'Story',
              eyebrow: 'Narrative Draft',
              subtitle:
                'Review the current story draft in its canonical workspace file before locking storyboard and shot planning.',
              sectionTitle: 'workspace/STORY.md',
              markdown: await loadWorkspaceMarkdownDocument('STORY.md', cwd),
              emptyState: 'No story markdown yet.',
            })
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            (url.pathname === '/keyframes' || url.pathname === '/shots')
          ) {
            return redirectTo('/timeline', 302)
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            url.pathname === '/timeline'
          ) {
            const shots = await loadShotPromptsOrEmpty(cwd)

            return new Response(
              renderPage(
                'timeline',
                `<div class="stack">
                  ${renderTimelineContent(await buildTimelineData(shots, cwd))}
                </div>`,
              ),
              { headers: HTML_HEADERS },
            )
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            url.pathname === '/storyboard'
          ) {
            const detail = await loadStoryboardDetail(cwd, url.searchParams.get('version'))

            return renderDetailPage(detail, getJobState(activeJobs, detail.descriptor), {
              embedded: isEmbedded,
            })
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            /^\/characters\/[^/]+$/.test(url.pathname)
          ) {
            const detail = await loadCharacterDetail(
              decodeURIComponent(url.pathname.split('/')[2]!),
              cwd,
              url.searchParams.get('version'),
            )

            if (!detail) {
              return renderErrorPage('characters', 'Missing Character', 'Character not found.', '/')
            }

            return renderDetailPage(detail, getJobState(activeJobs, detail.descriptor), {
              embedded: isEmbedded,
            })
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            /^\/keyframes\/[^/]+$/.test(url.pathname)
          ) {
            const detail = await getDetailContext(
              url.pathname,
              cwd,
              url.searchParams.get('version'),
            )

            if (!detail) {
              return renderErrorPage(
                'timeline',
                'Missing Keyframe',
                'Keyframe not found.',
                '/timeline',
              )
            }

            return renderDetailPage(detail, getJobState(activeJobs, detail.descriptor), {
              embedded: isEmbedded,
            })
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            /^\/shots\/[^/]+$/.test(url.pathname)
          ) {
            const detail = await loadShotDetail(
              decodeURIComponent(url.pathname.split('/')[2]!),
              cwd,
              url.searchParams.get('version'),
            )

            if (!detail) {
              return renderErrorPage('timeline', 'Missing Shot', 'Shot not found.', '/timeline')
            }

            return renderDetailPage(detail, getJobState(activeJobs, detail.descriptor), {
              embedded: isEmbedded,
            })
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            /^\/storyboard\/versions\/[^/]+\/media$/.test(url.pathname)
          ) {
            return serveArtifactVersionMedia(
              getStoryboardArtifactDescriptor(),
              decodeURIComponent(url.pathname.split('/')[3]!),
              cwd,
            )
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            /^\/characters\/[^/]+\/versions\/[^/]+\/media$/.test(url.pathname)
          ) {
            return serveArtifactVersionMedia(
              getCharacterArtifactDescriptor(decodeURIComponent(url.pathname.split('/')[2]!)),
              decodeURIComponent(url.pathname.split('/')[4]!),
              cwd,
            )
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            /^\/keyframes\/[^/]+\/versions\/[^/]+\/media$/.test(url.pathname)
          ) {
            const keyframeId = decodeURIComponent(url.pathname.split('/')[2]!)
            const keyframe = (await loadKeyframesOrEmpty(cwd)).find(
              (entry) => entry.keyframeId === keyframeId,
            )

            if (!keyframe) {
              return new Response('Not Found', { status: 404 })
            }

            return serveArtifactVersionMedia(
              getKeyframeArtifactDescriptor(keyframe),
              decodeURIComponent(url.pathname.split('/')[4]!),
              cwd,
            )
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            /^\/shots\/[^/]+\/versions\/[^/]+\/media$/.test(url.pathname)
          ) {
            return serveArtifactVersionMedia(
              getShotArtifactDescriptor(decodeURIComponent(url.pathname.split('/')[2]!)),
              decodeURIComponent(url.pathname.split('/')[4]!),
              cwd,
            )
          }

          if (request.method === 'POST' && url.pathname === '/timeline/update') {
            try {
              return await handleTimelineUpdate(request, cwd)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)

              return new Response(JSON.stringify({ error: message }), {
                status: 400,
                headers: JSON_HEADERS,
              })
            }
          }

          if (request.method === 'POST' && /\/references$/.test(url.pathname)) {
            return await handleReferenceSave(
              url.pathname.replace(/\/references$/, ''),
              request,
              cwd,
            )
          }

          if (request.method === 'POST' && /\/create$/.test(url.pathname)) {
            return await handleCreate(
              url.pathname.replace(/\/create$/, ''),
              request,
              cwd,
              activeJobs,
              generatorOverrides,
            )
          }

          if (request.method === 'POST' && /\/regenerate$/.test(url.pathname)) {
            return await handleRegenerate(
              url.pathname.replace(/\/regenerate$/, ''),
              request,
              cwd,
              activeJobs,
              generatorOverrides,
            )
          }

          if (request.method === 'POST' && /\/select$/.test(url.pathname)) {
            return await handleSelect(url.pathname.replace(/\/select$/, ''), request, cwd)
          }

          if (request.method === 'POST' && /\/delete$/.test(url.pathname)) {
            return await handleDelete(url.pathname.replace(/\/delete$/, ''), request, cwd)
          }

          if (request.method === 'POST' && /\/remove$/.test(url.pathname)) {
            return await handleRemove(url.pathname.replace(/\/remove$/, ''), cwd)
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            url.pathname.startsWith('/workspace/CHARACTERS/')
          ) {
            return serveCanonicalCharacterImage(url.pathname, cwd)
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            url.pathname === `/${getStoryboardImagePath()}`
          ) {
            return serveCanonicalStoryboardImage(url.pathname, cwd)
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            url.pathname.startsWith('/workspace/KEYFRAMES/')
          ) {
            return serveCanonicalKeyframeImage(url.pathname, cwd)
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            url.pathname.startsWith('/workspace/SHOTS/')
          ) {
            return serveCanonicalShotVideo(url.pathname, cwd)
          }

          return new Response('Not Found', { status: 404 })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const activeTab: Tab = url.pathname.startsWith('/timeline')
            ? 'timeline'
            : url.pathname.startsWith('/shots') || url.pathname.startsWith('/keyframes')
              ? 'timeline'
              : url.pathname.startsWith('/storyboard')
                ? 'storyboard'
                : url.pathname.startsWith('/story')
                  ? 'story'
                  : url.pathname.startsWith('/idea')
                    ? 'idea'
                    : 'characters'

          return new Response(
            renderPage(
              activeTab,
              `<div class="stack">
                ${renderHero('Artifact Review Error', message, 'Server Error')}
              </div>`,
              { embedded: isEmbedded },
            ),
            {
              status: 400,
              headers: HTML_HEADERS,
            },
          )
        }
      },
    })

  let server: Bun.Server<undefined>

  try {
    server = createServer(preferredPort)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    if (!message.toLowerCase().includes('port') && !message.toLowerCase().includes('address')) {
      throw error
    }

    server = createServer(0)
  }

  let stopped = false
  const activePort = server.port

  if (activePort === undefined) {
    throw new Error('Artifact review server started without a bound port.')
  }

  return {
    port: activePort,
    url: server.url.toString(),
    stop: async () => {
      if (stopped) {
        return
      }

      stopped = true
      await server.stop(true)
    },
  } satisfies ArtifactReviewServer
}
