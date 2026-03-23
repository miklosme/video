import { access, readFile } from 'node:fs/promises'
import process from 'node:process'

import {
  getCharacterSheetImagePath,
  getShotVideoPath,
  getStoryboardImagePath,
  loadCharacterSheets,
  loadKeyframes,
  loadShotArtifacts,
  loadShotPrompts,
  resolveRepoPath,
  resolveWorkflowPath,
  WORKFLOW_FILES,
  type CharacterSheetEntry,
  type FrameType,
  type KeyframeEntry,
  type ShotArtifactEntry,
  type ShotEntry,
} from './workflow-data'

const FRAME_ORDER: Record<FrameType, number> = {
  start: 0,
  end: 1,
  single: 2,
}

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
}

interface KeyframeReviewSlot {
  keyframeId: string
  frameType: FrameType
  title: string
  goal: string
  status: string
  imageUrl: string
  imageExists: boolean
  missingLabel: string | null
}

interface KeyframeReviewShot {
  shotId: string
  slots: KeyframeReviewSlot[]
}

interface StoryboardReviewState {
  imageUrl: string
  imageExists: boolean
  markdown: string | null
}

interface ShotReviewCard {
  shotId: string
  status: string
  durationSeconds: number
  keyframeIds: string[]
  prompt: string | null
  model: string | null
  videoUrl: string
  videoExists: boolean
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

function encodeImageUrl(imagePath: string) {
  return imagePath
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

async function buildReviewShots(cwd: string): Promise<KeyframeReviewShot[]> {
  const keyframes = await loadKeyframesOrEmpty(cwd)
  const shots = new Map<string, KeyframeEntry[]>()

  for (const entry of keyframes) {
    const existingShot = shots.get(entry.shotId) ?? []
    existingShot.push(entry)
    shots.set(entry.shotId, existingShot)
  }

  return Promise.all(
    [...shots.entries()].map(async ([shotId, entries]) => ({
      shotId,
      slots: await buildShotSlots(entries, cwd),
    })),
  )
}

async function buildShotSlots(entries: KeyframeEntry[], cwd: string) {
  const slotsByType = new Map<FrameType, KeyframeReviewSlot>()

  for (const entry of entries) {
    slotsByType.set(entry.frameType, await buildReviewSlot(entry, cwd))
  }

  const orderedSlots: KeyframeReviewSlot[] = []
  const hasPairFrame = slotsByType.has('start') || slotsByType.has('end')

  if (hasPairFrame) {
    orderedSlots.push(
      slotsByType.get('start') ?? buildMissingSlot(entries[0]!.shotId, 'start'),
      slotsByType.get('end') ?? buildMissingSlot(entries[0]!.shotId, 'end'),
    )
  }

  const singleSlot = slotsByType.get('single')

  if (singleSlot) {
    orderedSlots.push(singleSlot)
  }

  return orderedSlots.sort(
    (left, right) =>
      FRAME_ORDER[left.frameType] - FRAME_ORDER[right.frameType] ||
      left.keyframeId.localeCompare(right.keyframeId),
  )
}

async function buildReviewSlot(entry: KeyframeEntry, cwd: string): Promise<KeyframeReviewSlot> {
  const absoluteImagePath = resolveRepoPath(entry.imagePath, cwd)

  return {
    keyframeId: entry.keyframeId,
    frameType: entry.frameType,
    title: entry.title,
    goal: entry.goal,
    status: entry.status,
    imageUrl: `/${encodeImageUrl(entry.imagePath)}`,
    imageExists: await fileExists(absoluteImagePath),
    missingLabel: null,
  }
}

function buildMissingSlot(
  shotId: string,
  frameType: Extract<FrameType, 'start' | 'end'>,
): KeyframeReviewSlot {
  return {
    keyframeId: `${shotId}-${frameType.toUpperCase()}`,
    frameType,
    title: `${frameType === 'start' ? 'Start' : 'End'} keyframe missing`,
    goal: '',
    status: 'missing',
    imageUrl: '',
    imageExists: false,
    missingLabel: `Missing ${frameType} frame`,
  }
}

interface CharacterReviewCard {
  characterId: string
  displayName: string
  prompt: string
  status: string
  imageUrl: string
  imageExists: boolean
}

async function buildCharacterCards(cwd: string): Promise<CharacterReviewCard[]> {
  const characters = await loadCharacterSheets(cwd)

  return Promise.all(
    characters.map(async (entry) => {
      const imagePath = getCharacterSheetImagePath(entry.characterId)
      const absolutePath = resolveRepoPath(imagePath, cwd)

      return {
        characterId: entry.characterId,
        displayName: entry.displayName,
        prompt: entry.prompt,
        status: entry.status,
        imageUrl: `/${encodeImageUrl(imagePath)}`,
        imageExists: await fileExists(absolutePath),
      }
    }),
  )
}

async function buildStoryboardReviewState(cwd: string): Promise<StoryboardReviewState> {
  const imagePath = getStoryboardImagePath()
  const absoluteImagePath = resolveRepoPath(imagePath, cwd)
  const markdown = await readFile(
    resolveWorkflowPath(WORKFLOW_FILES.storyboard, cwd),
    'utf8',
  ).catch(() => null)

  return {
    imageUrl: `/${encodeImageUrl(imagePath)}`,
    imageExists: await fileExists(absoluteImagePath),
    markdown,
  }
}

async function buildShotReviewCards(cwd: string): Promise<ShotReviewCard[]> {
  const [shots, artifacts] = await Promise.all([
    loadShotPromptsOrEmpty(cwd),
    loadShotArtifactsOrEmpty(cwd),
  ])
  const artifactsByShotId = new Map(artifacts.map((entry) => [entry.shotId, entry]))

  return Promise.all(
    shots.map(async (entry) =>
      buildShotReviewCard(entry, artifactsByShotId.get(entry.shotId), cwd),
    ),
  )
}

async function buildShotReviewCard(
  entry: ShotEntry,
  artifact: ShotArtifactEntry | undefined,
  cwd: string,
): Promise<ShotReviewCard> {
  const absoluteVideoPath = resolveRepoPath(entry.videoPath, cwd)

  return {
    shotId: entry.shotId,
    status: artifact?.status ?? entry.status,
    durationSeconds: entry.durationSeconds,
    keyframeIds: entry.keyframeIds,
    prompt: artifact?.prompt ?? null,
    model: artifact?.model ?? null,
    videoUrl: `/${encodeImageUrl(entry.videoPath)}`,
    videoExists: await fileExists(absoluteVideoPath),
  }
}

function renderCharacterCard(card: CharacterReviewCard) {
  const visual = card.imageExists
    ? `<img src="${card.imageUrl}" alt="${escapeHtml(card.displayName)}" loading="lazy">`
    : `<div class="placeholder">No image</div>`

  return `
    <div class="character-card">
      <div class="character-visual">${visual}</div>
      <p class="character-name">${escapeHtml(card.displayName)}</p>
      <p class="character-prompt">${escapeHtml(card.prompt)}</p>
    </div>
  `
}

function renderCharacterSheet(cards: CharacterReviewCard[]) {
  if (cards.length === 0) {
    return '<p style="color:#555;text-align:center;padding:48px 0;">No characters yet.</p>'
  }

  return `
    <div class="character-grid">
      ${cards.map(renderCharacterCard).join('')}
    </div>
  `
}

function renderStoryboard(review: StoryboardReviewState) {
  const visual = review.imageExists
    ? `<img src="${review.imageUrl}" alt="Storyboard" loading="lazy">`
    : '<div class="placeholder">No storyboard image yet</div>'

  const markdown = review.markdown?.trim()
  const markdownHtml = markdown
    ? `<pre class="storyboard-markdown">${escapeHtml(markdown)}</pre>`
    : '<div class="storyboard-empty">No storyboard markdown yet.</div>'

  return `
    <section class="storyboard-panel">
      <div class="storyboard-visual">${visual}</div>
      <div class="storyboard-copy">
        <p class="storyboard-heading">Source Storyboard</p>
        ${markdownHtml}
      </div>
    </section>
  `
}

function renderSlot(slot: KeyframeReviewSlot) {
  const visual = slot.imageExists
    ? `<img src="${slot.imageUrl}" alt="${escapeHtml(slot.keyframeId)}" loading="lazy">`
    : `<div class="placeholder">${escapeHtml(slot.missingLabel ?? 'No image')}</div>`

  const goalHtml = slot.goal ? `<p class="slot-goal">${escapeHtml(slot.goal)}</p>` : ''

  return `
    <div class="slot">
      <div class="slot-visual">${visual}</div>
      <p class="slot-title">${escapeHtml(slot.title)}</p>
      ${goalHtml}
    </div>
  `
}

function renderShot(shot: KeyframeReviewShot) {
  return `
    <section class="shot">
      <div class="shot-id">${escapeHtml(shot.shotId)}</div>
      <div class="shot-frames">
        ${shot.slots.map(renderSlot).join('')}
      </div>
    </section>
  `
}

function renderKeyframes(shots: KeyframeReviewShot[]) {
  if (shots.length === 0) {
    return '<p style="color:#555;text-align:center;padding:48px 0;">No keyframes yet.</p>'
  }

  return shots.map(renderShot).join('')
}

function formatDurationSeconds(durationSeconds: number) {
  return Number.isInteger(durationSeconds)
    ? `${durationSeconds}s`
    : `${durationSeconds.toFixed(1)}s`
}

function renderShotMeta(label: string, value: string) {
  return `
    <div class="shot-meta-item">
      <span class="shot-meta-label">${escapeHtml(label)}</span>
      <span class="shot-meta-value">${escapeHtml(value)}</span>
    </div>
  `
}

function renderShotCard(card: ShotReviewCard) {
  const visual = card.videoExists
    ? `<video src="${card.videoUrl}" controls preload="metadata" playsinline></video>`
    : '<div class="placeholder">No video yet</div>'
  const promptHtml = card.prompt
    ? `<p class="shot-review-prompt">${escapeHtml(card.prompt)}</p>`
    : '<p class="shot-review-empty">No shot sidecar prompt yet.</p>'

  return `
    <section class="shot-review-card">
      <div class="shot-review-header">
        <p class="shot-review-id">${escapeHtml(card.shotId)}</p>
        <span class="shot-review-status">${escapeHtml(card.status)}</span>
      </div>
      <div class="shot-review-layout">
        <div class="shot-review-visual">${visual}</div>
        <div class="shot-review-copy">
          <div class="shot-review-meta">
            ${renderShotMeta('Duration', formatDurationSeconds(card.durationSeconds))}
            ${renderShotMeta('Anchors', card.keyframeIds.join(' -> '))}
            ${renderShotMeta('Model', card.model ?? 'No sidecar yet')}
          </div>
          <div class="shot-review-prompt-block">
            <p class="shot-review-heading">Motion Prompt</p>
            ${promptHtml}
          </div>
        </div>
      </div>
    </section>
  `
}

function renderShots(cards: ShotReviewCard[]) {
  if (cards.length === 0) {
    return '<p style="color:#555;text-align:center;padding:48px 0;">No shots yet.</p>'
  }

  return `<div class="shot-review-grid">${cards.map(renderShotCard).join('')}</div>`
}

type Tab = 'characters' | 'storyboard' | 'keyframes' | 'shots'

function renderTabs(activeTab: Tab) {
  const tabs: { id: Tab; label: string; href: string }[] = [
    { id: 'characters', label: 'Characters', href: '/' },
    { id: 'storyboard', label: 'Storyboard', href: '/storyboard' },
    { id: 'keyframes', label: 'Keyframes', href: '/keyframes' },
    { id: 'shots', label: 'Shots', href: '/shots' },
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

function renderPage(activeTab: Tab, content: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Artifact Review</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }

      body {
        background: #0e0e0e;
        color: #bbb;
        font-family: -apple-system, "Helvetica Neue", Helvetica, sans-serif;
        -webkit-font-smoothing: antialiased;
      }

      .board {
        max-width: 1200px;
        margin: 0 auto;
        padding: 32px 24px;
        display: flex;
        flex-direction: column;
        gap: 24px;
      }

      /* Tabs */

      .tabs {
        display: flex;
        gap: 0;
        border-bottom: 1px solid #222;
      }

      .tab {
        padding: 10px 20px;
        font-size: 13px;
        font-weight: 500;
        color: #666;
        text-decoration: none;
        border-bottom: 2px solid transparent;
        transition: color 0.15s, border-color 0.15s;
      }

      .tab:hover {
        color: #aaa;
      }

      .tab-active {
        color: #ddd;
        border-bottom-color: #ddd;
      }

      /* Characters */

      .character-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 20px;
      }

      .character-card {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .character-visual {
        aspect-ratio: 1;
        border-radius: 6px;
        overflow: hidden;
        background: #181818;
        border: 1px solid #222;
      }

      .character-visual img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .character-name {
        font-size: 14px;
        font-weight: 600;
        color: #ddd;
      }

      .character-prompt {
        font-size: 12px;
        color: #666;
        line-height: 1.4;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }

      /* Keyframes */

      .storyboard-panel {
        display: grid;
        grid-template-columns: minmax(0, 2fr) minmax(320px, 1fr);
        gap: 20px;
        align-items: start;
      }

      .storyboard-visual {
        aspect-ratio: 16 / 9;
        border-radius: 8px;
        overflow: hidden;
        background: #181818;
        border: 1px solid #222;
      }

      .storyboard-visual img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: contain;
        background: #101010;
      }

      .storyboard-copy {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .storyboard-heading {
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.08em;
        color: #777;
        text-transform: uppercase;
      }

      .storyboard-markdown,
      .storyboard-empty {
        min-height: 240px;
        border-radius: 8px;
        border: 1px solid #222;
        background: #141414;
        padding: 14px;
      }

      .storyboard-markdown {
        color: #bbb;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px;
        line-height: 1.5;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      .storyboard-empty {
        display: grid;
        place-items: center;
        color: #555;
        font-size: 12px;
      }

      .shot {
        display: grid;
        grid-template-columns: 80px 1fr;
        gap: 16px;
        align-items: start;
      }

      .shot-id {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.08em;
        color: #555;
        padding-top: 6px;
        text-align: right;
        white-space: nowrap;
      }

      .shot-frames {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 12px;
      }

      .slot {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .slot-visual {
        aspect-ratio: 16 / 9;
        border-radius: 6px;
        overflow: hidden;
        background: #181818;
        border: 1px solid #222;
      }

      .slot-visual img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .placeholder {
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
        background: repeating-linear-gradient(
          -45deg,
          #151515,
          #151515 6px,
          #1a1a1a 6px,
          #1a1a1a 12px
        );
        color: #444;
        font-size: 12px;
        font-weight: 500;
      }

      .slot-title {
        font-size: 13px;
        font-weight: 500;
        color: #ddd;
        line-height: 1.3;
      }

      .slot-goal {
        font-size: 12px;
        color: #666;
        line-height: 1.4;
      }

      /* Shots */

      .shot-review-grid {
        display: flex;
        flex-direction: column;
        gap: 18px;
      }

      .shot-review-card {
        border: 1px solid #222;
        border-radius: 10px;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0)),
          #111;
        overflow: hidden;
      }

      .shot-review-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding: 14px 16px;
        border-bottom: 1px solid #1d1d1d;
      }

      .shot-review-id {
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.08em;
        color: #ddd;
        text-transform: uppercase;
      }

      .shot-review-status {
        border: 1px solid #2f2f2f;
        border-radius: 999px;
        padding: 4px 10px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.08em;
        color: #8f8f8f;
        text-transform: uppercase;
      }

      .shot-review-layout {
        display: grid;
        grid-template-columns: minmax(0, 1.35fr) minmax(320px, 1fr);
        gap: 18px;
        padding: 16px;
      }

      .shot-review-visual {
        aspect-ratio: 16 / 9;
        border-radius: 8px;
        overflow: hidden;
        border: 1px solid #222;
        background: #181818;
      }

      .shot-review-visual video {
        display: block;
        width: 100%;
        height: 100%;
        background: #0b0b0b;
      }

      .shot-review-copy {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }

      .shot-review-meta {
        display: grid;
        gap: 8px;
      }

      .shot-meta-item {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        padding-bottom: 8px;
        border-bottom: 1px solid #1f1f1f;
      }

      .shot-meta-label {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.08em;
        color: #666;
        text-transform: uppercase;
      }

      .shot-meta-value {
        font-size: 12px;
        color: #bbb;
        text-align: right;
      }

      .shot-review-prompt-block {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-height: 100%;
      }

      .shot-review-heading {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.08em;
        color: #777;
        text-transform: uppercase;
      }

      .shot-review-prompt,
      .shot-review-empty {
        border-radius: 8px;
        border: 1px solid #222;
        background: #141414;
        padding: 14px;
        font-size: 12px;
        line-height: 1.55;
      }

      .shot-review-prompt {
        color: #bbb;
        white-space: pre-wrap;
      }

      .shot-review-empty {
        color: #555;
      }

      @media (max-width: 700px) {
        .board { padding: 16px; }

        .storyboard-panel {
          grid-template-columns: 1fr;
        }

        .shot {
          grid-template-columns: 1fr;
          gap: 8px;
        }

        .shot-id {
          text-align: left;
        }

        .shot-frames {
          grid-template-columns: 1fr 1fr;
        }

        .character-grid {
          grid-template-columns: 1fr 1fr;
        }

        .shot-review-layout {
          grid-template-columns: 1fr;
        }

        .shot-review-header,
        .shot-meta-item {
          align-items: flex-start;
          flex-direction: column;
        }

        .shot-meta-value {
          text-align: left;
        }
      }
    </style>
  </head>
  <body>
    <div class="board">
      ${renderTabs(activeTab)}
      ${content}
    </div>
  </body>
</html>`
}

async function serveKeyframeImage(requestPath: string, cwd: string) {
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

async function serveCharacterImage(requestPath: string, cwd: string) {
  const decodedPath = decodeURIComponent(requestPath.slice(1))
  const characters = await loadCharacterSheets(cwd)
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

async function serveStoryboardImage(requestPath: string, cwd: string) {
  const decodedPath = decodeURIComponent(requestPath.slice(1))
  const storyboardImagePath = getStoryboardImagePath()

  if (decodedPath !== storyboardImagePath) {
    return new Response('Not Found', { status: 404 })
  }

  const absolutePath = resolveRepoPath(storyboardImagePath, cwd)

  if (!(await fileExists(absolutePath))) {
    return new Response('Not Found', { status: 404 })
  }

  return new Response(Bun.file(absolutePath))
}

async function serveShotVideo(requestPath: string, cwd: string) {
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

async function serveCharactersPage(cwd: string) {
  const cards = await buildCharacterCards(cwd)

  return new Response(renderPage('characters', renderCharacterSheet(cards)), {
    headers: HTML_HEADERS,
  })
}

async function serveKeyframesPage(cwd: string) {
  const shots = await buildReviewShots(cwd)

  return new Response(renderPage('keyframes', renderKeyframes(shots)), {
    headers: HTML_HEADERS,
  })
}

async function serveStoryboardPage(cwd: string) {
  const review = await buildStoryboardReviewState(cwd)

  return new Response(renderPage('storyboard', renderStoryboard(review)), {
    headers: HTML_HEADERS,
  })
}

async function serveShotsPage(cwd: string) {
  const cards = await buildShotReviewCards(cwd)

  return new Response(renderPage('shots', renderShots(cards)), {
    headers: HTML_HEADERS,
  })
}

export function startArtifactReviewServer(options: { cwd?: string; preferredPort?: number } = {}) {
  const { cwd = process.cwd(), preferredPort = 3000 } = options

  const createServer = (port: number) =>
    Bun.serve({
      port,
      fetch(request) {
        const url = new URL(request.url)

        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return new Response('Method Not Allowed', {
            status: 405,
            headers: {
              allow: 'GET, HEAD',
            },
          })
        }

        if (url.pathname === '/') {
          return serveCharactersPage(cwd)
        }

        if (url.pathname === '/keyframes') {
          return serveKeyframesPage(cwd)
        }

        if (url.pathname === '/storyboard') {
          return serveStoryboardPage(cwd)
        }

        if (url.pathname === '/shots') {
          return serveShotsPage(cwd)
        }

        if (url.pathname.startsWith('/workspace/CHARACTERS/')) {
          return serveCharacterImage(url.pathname, cwd)
        }

        if (url.pathname === `/${getStoryboardImagePath()}`) {
          return serveStoryboardImage(url.pathname, cwd)
        }

        if (url.pathname.startsWith('/workspace/KEYFRAMES/')) {
          return serveKeyframeImage(url.pathname, cwd)
        }

        if (url.pathname.startsWith('/workspace/SHOTS/')) {
          return serveShotVideo(url.pathname, cwd)
        }

        return new Response('Not Found', { status: 404 })
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
    throw new Error('Keyframe review server started without a bound port.')
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
