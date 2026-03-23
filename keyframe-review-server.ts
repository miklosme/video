import { access } from 'node:fs/promises'
import process from 'node:process'

import { loadKeyframes, resolveRepoPath, type FrameType, type KeyframeEntry } from './workflow-data'

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
  imageUrl: string
  imageExists: boolean
  missingLabel: string | null
}

interface KeyframeReviewShot {
  shotId: string
  slots: KeyframeReviewSlot[]
}

export interface KeyframeReviewServer {
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

async function buildReviewShots(cwd: string): Promise<KeyframeReviewShot[]> {
  const keyframes = await loadKeyframes(cwd)
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
    imageUrl: '',
    imageExists: false,
    missingLabel: `Missing ${frameType} keyframe`,
  }
}

function renderSlot(slot: KeyframeReviewSlot) {
  const content = slot.imageExists
    ? `<img src="${slot.imageUrl}" alt="${escapeHtml(slot.keyframeId)}" loading="lazy">`
    : `<div class="placeholder">${escapeHtml(slot.missingLabel ?? 'Missing keyframe')}</div>`

  return `
    <article class="frame-card ${slot.imageExists ? 'is-image' : 'is-missing'}">
      <div class="frame-meta">
        <div class="frame-type">${escapeHtml(slot.frameType.toUpperCase())}</div>
        <div class="frame-id">${escapeHtml(slot.keyframeId)}</div>
        <div class="frame-title">${escapeHtml(slot.title)}</div>
      </div>
      <div class="frame-visual">
        ${content}
      </div>
    </article>
  `
}

function renderPage(shots: KeyframeReviewShot[]) {
  const totalFrames = shots.reduce((sum, shot) => sum + shot.slots.length, 0)
  const missingFrames = shots.reduce(
    (sum, shot) => sum + shot.slots.filter((slot) => !slot.imageExists).length,
    0,
  )
  const shotMarkup = shots
    .map(
      (shot) => `
        <section class="shot-row">
          <header class="shot-header">
            <div class="shot-label">${escapeHtml(shot.shotId)}</div>
            <div class="shot-count">${shot.slots.length} frame${shot.slots.length === 1 ? '' : 's'}</div>
          </header>
          <div class="shot-grid">
            ${shot.slots.map(renderSlot).join('')}
          </div>
        </section>
      `,
    )
    .join('')

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Keyframe Review</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f3efe6;
        --panel: #fffaf0;
        --panel-strong: #fffdf8;
        --ink: #1f1c17;
        --muted: #6b6256;
        --line: #d8cab2;
        --accent: #b55d38;
        --placeholder-bg: repeating-linear-gradient(
          -45deg,
          #f2dfc7,
          #f2dfc7 16px,
          #ead0b2 16px,
          #ead0b2 32px
        );
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
        background:
          radial-gradient(circle at top, rgba(255, 255, 255, 0.9), transparent 42%),
          linear-gradient(180deg, #efe4d1 0%, var(--bg) 45%, #ebe1cf 100%);
        color: var(--ink);
      }

      .page {
        min-height: 100vh;
        padding: 24px;
      }

      .page-header {
        position: sticky;
        top: 0;
        z-index: 10;
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 12px;
        margin: -24px -24px 24px;
        padding: 20px 24px 16px;
        background: rgba(243, 239, 230, 0.92);
        backdrop-filter: blur(10px);
        border-bottom: 1px solid rgba(216, 202, 178, 0.9);
      }

      .page-title {
        margin: 0;
        font-size: 28px;
        line-height: 1.1;
      }

      .page-subtitle {
        margin: 4px 0 0;
        color: var(--muted);
      }

      .page-stats {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        flex-wrap: wrap;
      }

      .stat-pill {
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 8px 12px;
        background: rgba(255, 253, 248, 0.95);
        font-size: 14px;
      }

      .shots {
        display: flex;
        flex-direction: column;
        gap: 18px;
      }

      .shot-row {
        border: 1px solid var(--line);
        background: rgba(255, 250, 240, 0.92);
        border-radius: 18px;
        padding: 16px;
        box-shadow: 0 10px 24px rgba(77, 52, 28, 0.07);
      }

      .shot-header {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: baseline;
        margin-bottom: 12px;
      }

      .shot-label {
        font-size: 20px;
        font-weight: 700;
      }

      .shot-count {
        color: var(--muted);
        font-size: 14px;
      }

      .shot-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 14px;
      }

      .frame-card {
        display: flex;
        flex-direction: column;
        gap: 10px;
        min-width: 0;
      }

      .frame-meta {
        display: grid;
        gap: 2px;
      }

      .frame-type {
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.12em;
        color: var(--accent);
      }

      .frame-id {
        font-size: 16px;
        font-weight: 700;
      }

      .frame-title {
        color: var(--muted);
        font-size: 14px;
      }

      .frame-visual {
        aspect-ratio: 16 / 9;
        border-radius: 14px;
        overflow: hidden;
        border: 1px solid rgba(216, 202, 178, 0.95);
        background: var(--panel-strong);
      }

      .frame-visual img,
      .placeholder {
        display: block;
        width: 100%;
        height: 100%;
      }

      .frame-visual img {
        object-fit: cover;
        background: #f8f1e3;
      }

      .placeholder {
        display: grid;
        place-items: center;
        padding: 16px;
        background: var(--placeholder-bg);
        color: #6e4b2d;
        font-size: 18px;
        font-weight: 700;
        text-align: center;
      }

      @media (max-width: 900px) {
        .page {
          padding: 16px;
        }

        .page-header {
          margin: -16px -16px 16px;
          padding: 16px;
        }

        .shot-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <header class="page-header">
        <div>
          <h1 class="page-title">Keyframe Review</h1>
          <p class="page-subtitle">Compare each shot’s anchor frames side by side.</p>
        </div>
        <div class="page-stats">
          <div class="stat-pill">${shots.length} shot${shots.length === 1 ? '' : 's'}</div>
          <div class="stat-pill">${totalFrames} keyframe${totalFrames === 1 ? '' : 's'}</div>
          <div class="stat-pill">${missingFrames} missing</div>
        </div>
      </header>
      <div class="shots">
        ${shotMarkup}
      </div>
    </main>
  </body>
</html>`
}

async function serveImage(requestPath: string, cwd: string) {
  const decodedPath = decodeURIComponent(requestPath.slice(1))
  const keyframes = await loadKeyframes(cwd)
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

async function servePage(cwd: string) {
  const shots = await buildReviewShots(cwd)

  return new Response(renderPage(shots), {
    headers: HTML_HEADERS,
  })
}

export function startKeyframeReviewServer(options: { cwd?: string; preferredPort?: number } = {}) {
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
          return servePage(cwd)
        }

        if (url.pathname.startsWith('/workspace/KEYFRAMES/')) {
          return serveImage(url.pathname, cwd)
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
  } satisfies KeyframeReviewServer
}
