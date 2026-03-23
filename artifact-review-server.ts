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

function renderPage(shots: KeyframeReviewShot[]) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Storyboard</title>
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

      .slot-info {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .slot-label {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.1em;
        color: #666;
      }

      .slot-status {
        font-size: 10px;
        font-weight: 500;
        color: #555;
      }

      .slot-status[data-status="done"],
      .slot-status[data-status="approved"] {
        color: #4a7;
      }

      .slot-status[data-status="in-progress"] {
        color: #c90;
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

      @media (max-width: 700px) {
        .board { padding: 16px; }

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
      }
    </style>
  </head>
  <body>
    <div class="board">
      ${shots.map(renderShot).join('')}
    </div>
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
  } satisfies ArtifactReviewServer
}
