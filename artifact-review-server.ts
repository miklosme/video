import { access, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import {
  getArtifactKey,
  getArtifactVersionMediaPath,
  getCharacterArtifactDescriptor,
  getKeyframeArtifactDescriptor,
  getShotArtifactDescriptor,
  getStoryboardArtifactDescriptor,
  loadArtifactHistoryState,
  promoteArtifactVersion,
  resolveCharacterGenerationReferences,
  resolveKeyframeGenerationReferences,
  resolveShotGenerationAssets,
  resolveStoryboardGenerationReferences,
  summarizeReference,
  type ArtifactDescriptor,
  type ArtifactHistoryState,
  type ResolvedShotGenerationAssets,
} from './artifact-control'
import {
  generateCharacterSheetArtifactVersion,
  selectPendingCharacterSheetGenerations,
  type PendingCharacterSheetGeneration,
} from './generate-character-sheets'
import type {
  GenerateImagenOptionsInput,
  GenerateImagenOptionsResult,
} from './generate-imagen-options'
import {
  generateKeyframeArtifactVersion,
  selectPendingKeyframeGenerations,
  type PendingKeyframeGeneration,
} from './generate-keyframes'
import {
  generateShotArtifactVersion,
  selectPendingShotGenerations,
  type PendingShotGeneration,
  type ShotVideoGenerator,
} from './generate-shots'
import {
  generateStoryboardArtifactVersion,
  selectPendingStoryboardGeneration,
} from './generate-storyboard'
import {
  getCharacterSheetImagePath,
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
  type KeyframeArtifactEntry,
  type KeyframeEntry,
  type ResolvedArtifactReference,
  type ShotArtifactEntry,
  type ShotEntry,
  type StoryboardSidecar,
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

type Tab = 'characters' | 'storyboard' | 'keyframes' | 'shots'

type ArtifactJobStatus = 'running' | 'success' | 'error'

interface ArtifactJobState {
  status: ArtifactJobStatus
  startedAt: string
  completedAt: string | null
  message: string
  versionId: string | null
}

type ImageGenerator = (input: GenerateImagenOptionsInput) => Promise<GenerateImagenOptionsResult>

interface ApprovedActionGeneratorOverrides {
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

interface ApprovalPreview {
  descriptor: ArtifactDescriptor
  activeTab: Tab
  baseVersionId: string
  editInstruction: string
  references: ResolvedArtifactReference[]
  droppedReferences: ResolvedArtifactReference[]
  title: string
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
  sourceReferences: ArtifactReferenceEntry[]
  sourcePrompt: string | null
  sourceModel: string | null
  sourceStatus: string | null
  historyState: ArtifactHistoryState
  notesHtml: string
  canEdit: boolean
  canEditReferences: boolean
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

function renderPage(activeTab: Tab, content: string, options: { autoRefresh?: boolean } = {}) {
  const refreshTag = options.autoRefresh ? '<meta http-equiv="refresh" content="2">' : ''

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

      a { color: inherit; }

      .board {
        max-width: 1320px;
        margin: 0 auto;
        padding: 28px 20px 36px;
        display: flex;
        flex-direction: column;
        gap: 20px;
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
      .approval-panel,
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
      .approval-panel,
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
        background:
          linear-gradient(135deg, rgba(159,232,112,0.06), transparent 50%),
          repeating-linear-gradient(
            -45deg,
            rgba(255,255,255,0.02),
            rgba(255,255,255,0.02) 8px,
            transparent 8px,
            transparent 16px
          );
      }

      .card-copy,
      .meta-stack,
      .storyboard-copy,
      .approval-copy {
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

      .history-list,
      .reference-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .history-item,
      .reference-item {
        padding: 14px;
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,0.05);
        background: rgba(255,255,255,0.02);
      }

      .history-item-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
        margin-bottom: 10px;
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

      .approval-panel,
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
      }

      @media (max-width: 720px) {
        .board { padding: 16px; }
        .hero { flex-direction: column; }
        .shot { grid-template-columns: 1fr; }
        .shot-id { text-align: left; }
        .character-grid { grid-template-columns: 1fr 1fr; }
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

function redirectTo(location: string) {
  return new Response(null, {
    status: 303,
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

function renderMediaBlock(options: {
  mediaType: 'image' | 'video'
  mediaUrl: string | null
  mediaExists: boolean
  alt: string
  placeholder: string
  className: string
}) {
  if (!options.mediaUrl || !options.mediaExists) {
    return `<div class="placeholder">${escapeHtml(options.placeholder)}</div>`
  }

  if (options.mediaType === 'video') {
    return `<video class="${options.className}" src="${options.mediaUrl}" controls preload="metadata" playsinline></video>`
  }

  return `<img class="${options.className}" src="${options.mediaUrl}" alt="${escapeHtml(options.alt)}" loading="lazy">`
}

function buildReferenceEditorValue(references: ArtifactReferenceEntry[]) {
  return `${JSON.stringify(references, null, 2)}`
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
                ${reference.role ? `<span class="pill">${escapeHtml(reference.role)}</span>` : ''}
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

function renderHistoryList(context: ArtifactDetailContext) {
  const history = context.historyState.history

  if (!history || context.historyState.versions.length === 0) {
    return '<div class="empty-state">No retained versions yet. Once this artifact has been generated, its history will appear here.</div>'
  }

  return `
    <div class="history-list">
      ${context.historyState.versions
        .map((version) => {
          const isSelected = history.selectedVersionId === version.versionId
          const isLatest = history.latestVersionId === version.versionId
          const isActive = context.historyState.activeVersionId === version.versionId
          const detailUrl = `${getArtifactDetailPath(context.descriptor)}?version=${encodeURIComponent(version.versionId)}`

          return `
            <div class="history-item">
              <div class="history-item-header">
                <div class="meta-stack">
                  <p class="title">${escapeHtml(version.versionId)}</p>
                  <p class="small">${escapeHtml(version.createdAt)}</p>
                  <p class="small">${escapeHtml(version.editInstruction ?? 'No stored edit instruction')}</p>
                </div>
                <div class="pill-row">
                  ${isActive ? '<span class="pill pill-info">Viewing</span>' : ''}
                  ${isSelected ? '<span class="pill pill-accent">Selected</span>' : ''}
                  ${isLatest ? '<span class="pill pill-warn">Latest</span>' : ''}
                </div>
              </div>
              <div class="version-actions">
                <a class="button button-secondary" href="${detailUrl}">View</a>
                <form method="post" action="${getArtifactSelectActionPath(context.descriptor)}">
                  <input type="hidden" name="versionId" value="${escapeHtml(version.versionId)}">
                  <button type="submit" ${isSelected ? 'disabled' : ''}>Select</button>
                </form>
              </div>
            </div>
          `
        })
        .join('')}
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

function renderEditComposer(context: ArtifactDetailContext) {
  if (!context.canEdit || !context.historyState.activeVersionId) {
    return `
      <section class="panel">
        <p class="section-title">Edit Request</p>
        <div class="empty-state">A retained base version is required before browser-driven edits can be approved.</div>
      </section>
    `
  }

  return `
    <section class="panel">
      <p class="section-title">Edit Request</p>
      <p class="form-note">The raw edit text is stored as written. Approval will show the base version and the exact resolved reference stack before generation starts.</p>
      <form method="post" action="${getArtifactApproveActionPath(context.descriptor)}">
        <input type="hidden" name="baseVersionId" value="${escapeHtml(context.historyState.activeVersionId)}">
        <textarea name="editInstruction" placeholder="Describe the precise change you want from the version you are viewing." required></textarea>
        <div class="form-actions">
          <button class="button-primary" type="submit">Review approval</button>
        </div>
      </form>
    </section>
  `
}

function renderApprovalPreview(
  activeTab: Tab,
  preview: ApprovalPreview,
  mediaType: 'image' | 'video',
  mediaUrl: string | null,
  mediaExists: boolean,
) {
  const backHref = `${getArtifactDetailPath(preview.descriptor)}?version=${encodeURIComponent(preview.baseVersionId)}`
  const confirmationForm = `
    <form method="post" action="${getArtifactGenerateActionPath(preview.descriptor)}">
      <input type="hidden" name="baseVersionId" value="${escapeHtml(preview.baseVersionId)}">
      <input type="hidden" name="editInstruction" value="${escapeHtml(preview.editInstruction)}">
      <div class="form-actions">
        <button class="button-primary" type="submit">Approve and generate</button>
        <a class="button button-secondary" href="${backHref}">Cancel</a>
      </div>
    </form>
  `

  return new Response(
    renderPage(
      activeTab,
      `<div class="stack">
        ${renderHero(preview.title, 'Final check before the approved action starts.', 'Approval')}
        <section class="detail-layout">
          <div class="detail-main">
            <div class="detail-visual">
              ${renderMediaBlock({
                mediaType,
                mediaUrl,
                mediaExists,
                alt: preview.title,
                placeholder: 'Base version preview unavailable',
                className: '',
              })}
            </div>
            <section class="approval-panel">
              <p class="section-title">Approved Action</p>
              <div class="pill-row">
                <span class="pill pill-accent">${escapeHtml(preview.baseVersionId)}</span>
                <span class="pill">${escapeHtml(preview.descriptor.displayName)}</span>
              </div>
              <p class="muted">${escapeHtml(preview.editInstruction)}</p>
              ${confirmationForm}
            </section>
          </div>
          <div class="detail-side">
            <section class="panel">
              <p class="section-title">Resolved References</p>
              ${renderReferenceList(preview.references)}
            </section>
            <section class="panel">
              <p class="section-title">Dropped References</p>
              ${
                preview.droppedReferences.length === 0
                  ? '<div class="empty-state">No references were dropped for this generation.</div>'
                  : renderReferenceList(preview.droppedReferences)
              }
            </section>
          </div>
        </section>
      </div>`,
    ),
    {
      headers: HTML_HEADERS,
    },
  )
}

function renderDetailPage(context: ArtifactDetailContext, job: ArtifactJobState | null) {
  const history = context.historyState.history
  const activeVersion = context.historyState.activeVersion
  const activeBadges = `
    <div class="pill-row">
      ${activeVersion ? `<span class="pill pill-info">${escapeHtml(activeVersion.versionId)}</span>` : ''}
      ${
        history && activeVersion && history.selectedVersionId === activeVersion.versionId
          ? '<span class="pill pill-accent">Selected</span>'
          : ''
      }
      ${
        history && activeVersion && history.latestVersionId === activeVersion.versionId
          ? '<span class="pill pill-warn">Latest</span>'
          : ''
      }
      ${context.sourceStatus ? `<span class="pill">${escapeHtml(context.sourceStatus)}</span>` : ''}
    </div>
  `

  const content = `
    <div class="stack">
      ${renderHero(
        context.title,
        context.subtitle,
        'Artifact Detail',
        `<div class="summary-actions"><a class="button button-secondary" href="${context.summaryHref}">${escapeHtml(context.summaryLabel)}</a></div>`,
      )}
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
              className: '',
            })}
          </div>
          ${activeBadges}
          <section class="panel">
            <p class="section-title">Version Notes</p>
            <div class="meta-stack">
              <p class="muted">${escapeHtml(activeVersion?.editInstruction ?? 'No edit instruction stored for this version.')}</p>
              ${context.sourcePrompt ? `<p class="small">Prompt: ${escapeHtml(context.sourcePrompt)}</p>` : ''}
              ${context.sourceModel ? `<p class="small">Model: ${escapeHtml(context.sourceModel)}</p>` : ''}
            </div>
          </section>
          ${context.notesHtml}
        </div>
        <div class="detail-side">
          <section class="panel">
            <p class="section-title">Retained History</p>
            ${renderHistoryList(context)}
          </section>
          <section class="panel">
            <p class="section-title">Active Version References</p>
            ${renderReferenceList(activeVersion?.references ?? [])}
          </section>
          ${renderReferenceEditor(
            getArtifactReferencesActionPath(context.descriptor),
            context.sourceReferences,
            context.canEditReferences,
            'Edit the source sidecar references as JSON. Use repo-relative paths and optional label, role, and notes fields.',
          )}
          ${renderEditComposer(context)}
        </div>
      </section>
    </div>
  `

  return new Response(
    renderPage(context.activeTab, content, { autoRefresh: job?.status === 'running' }),
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
        ${renderHero('Characters', 'Open a character to inspect the selected version, retained history, and source references.', 'Review Surface')}
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

function renderKeyframeSlot(slot: KeyframeReviewSlot) {
  return `
    <a class="slot slot-link" href="/keyframes/${encodeURIComponent(slot.keyframeId)}">
      <div class="slot-visual">
        ${
          slot.imageUrl
            ? renderMediaBlock({
                mediaType: 'image',
                mediaUrl: slot.imageUrl,
                mediaExists: slot.imageExists,
                alt: slot.keyframeId,
                placeholder: slot.missingLabel ?? 'No image',
                className: '',
              })
            : `<div class="placeholder">${escapeHtml(slot.missingLabel ?? 'No image')}</div>`
        }
      </div>
      <p class="title">${escapeHtml(slot.title)}</p>
      ${slot.goal ? `<p class="small">${escapeHtml(slot.goal)}</p>` : ''}
    </a>
  `
}

function renderKeyframeShot(shot: KeyframeReviewShot) {
  return `
    <section class="summary-card">
      <div class="shot">
        <div class="shot-id">${escapeHtml(shot.shotId)}</div>
        <div class="shot-frames">${shot.slots.map(renderKeyframeSlot).join('')}</div>
      </div>
    </section>
  `
}

function renderKeyframesSummary(shots: KeyframeReviewShot[]) {
  return new Response(
    renderPage(
      'keyframes',
      `<div class="stack">
        ${renderHero('Keyframes', 'Each keyframe opens into its own control page with retained versions, references, and edit approval.', 'Review Surface')}
        ${shots.length === 0 ? '<div class="empty-state">No keyframes yet.</div>' : shots.map(renderKeyframeShot).join('')}
      </div>`,
    ),
    {
      headers: HTML_HEADERS,
    },
  )
}

function renderShotsSummary(cards: ShotReviewCard[]) {
  return new Response(
    renderPage(
      'shots',
      `<div class="stack">
        ${renderHero('Shots', 'Open a shot to inspect the selected cut, retained versions, sidecar references, and approval flow.', 'Review Surface')}
        ${
          cards.length === 0
            ? '<div class="empty-state">No shots yet.</div>'
            : `<div class="shot-review-grid">${cards
                .map(
                  (card) => `
                    <section class="shot-review-card">
                      <div class="shot-review-header">
                        <div class="meta-stack">
                          <p class="eyebrow">${escapeHtml(card.status)}</p>
                          <p class="title">${escapeHtml(card.shotId)}</p>
                        </div>
                        <a class="button button-secondary" href="/shots/${encodeURIComponent(card.shotId)}">Open controls</a>
                      </div>
                      <div class="shot-review-layout">
                        <div class="shot-review-visual">
                          ${renderMediaBlock({
                            mediaType: 'video',
                            mediaUrl: card.videoUrl,
                            mediaExists: card.videoExists,
                            alt: card.shotId,
                            placeholder: 'No video yet',
                            className: '',
                          })}
                        </div>
                        <div class="card-copy">
                          <div class="shot-meta-grid">
                            <div class="shot-meta-item"><span class="small">Duration</span><span class="small">${escapeHtml(formatDurationSeconds(card.durationSeconds))}</span></div>
                            <div class="shot-meta-item"><span class="small">Anchors</span><span class="small">${escapeHtml(card.keyframeIds.join(' -> '))}</span></div>
                            <div class="shot-meta-item"><span class="small">Model</span><span class="small">${escapeHtml(card.model ?? 'No sidecar yet')}</span></div>
                          </div>
                          <p class="muted">${escapeHtml(card.prompt ?? 'No shot sidecar prompt yet.')}</p>
                        </div>
                      </div>
                    </section>
                  `,
                )
                .join('')}</div>`
        }
      </div>`,
    ),
    {
      headers: HTML_HEADERS,
    },
  )
}

function renderStoryboardSummary(review: StoryboardReviewState) {
  return new Response(
    renderPage(
      'storyboard',
      `<div class="stack">
        ${renderHero('Storyboard', 'The storyboard board is both the summary page and the artifact detail route for retained history, references, and approval.', 'Review Surface')}
        <section class="storyboard-panel">
          <div class="storyboard-visual">
            ${renderMediaBlock({
              mediaType: 'image',
              mediaUrl: review.imageUrl,
              mediaExists: review.imageExists,
              alt: 'Storyboard',
              placeholder: 'No storyboard image yet',
              className: '',
            })}
          </div>
          <div class="storyboard-copy">
            <p class="section-title">Source Storyboard</p>
            ${
              review.markdown
                ? `<pre class="storyboard-markdown">${escapeHtml(review.markdown.trim())}</pre>`
                : '<div class="empty-state">No storyboard markdown yet.</div>'
            }
          </div>
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

function getArtifactApproveActionPath(descriptor: ArtifactDescriptor) {
  return `${getArtifactDetailPath(descriptor)}/approve`
}

function getArtifactGenerateActionPath(descriptor: ArtifactDescriptor) {
  return `${getArtifactDetailPath(descriptor)}/generate`
}

function getArtifactSelectActionPath(descriptor: ArtifactDescriptor) {
  return `${getArtifactDetailPath(descriptor)}/select`
}

function getArtifactVersionMediaUrl(descriptor: ArtifactDescriptor, versionId: string) {
  return `${getArtifactDetailPath(descriptor)}/versions/${encodeURIComponent(versionId)}/media`
}

function getCanonicalMediaUrl(descriptor: ArtifactDescriptor) {
  return `/${encodeAssetUrl(descriptor.publicPath)}`
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

    return {
      path: normalizeRepoRelativePath(object.path, `Reference ${index + 1} path`),
      label: typeof object.label === 'string' ? object.label : undefined,
      role: typeof object.role === 'string' ? object.role : undefined,
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

async function buildReviewShots(cwd: string): Promise<KeyframeReviewShot[]> {
  const keyframes = await loadKeyframesOrEmpty(cwd)
  const shots = new Map<string, KeyframeEntry[]>()

  for (const entry of keyframes) {
    const existingShot = shots.get(entry.shotId) ?? []
    existingShot.push(entry)
    shots.set(entry.shotId, existingShot)
  }

  return Promise.all(
    [...shots.entries()].map(async ([shotId, entries]) => {
      const slotsByType = new Map<FrameType, KeyframeReviewSlot>()

      for (const entry of entries) {
        slotsByType.set(entry.frameType, {
          keyframeId: entry.keyframeId,
          frameType: entry.frameType,
          title: entry.title,
          goal: entry.goal,
          status: entry.status,
          imageUrl: `/${encodeAssetUrl(entry.imagePath)}`,
          imageExists: await fileExists(resolveRepoPath(entry.imagePath, cwd)),
          missingLabel: null,
        })
      }

      const orderedSlots: KeyframeReviewSlot[] = []
      const hasPairFrame = slotsByType.has('start') || slotsByType.has('end')

      if (hasPairFrame) {
        orderedSlots.push(
          slotsByType.get('start') ?? buildMissingSlot(shotId, 'start'),
          slotsByType.get('end') ?? buildMissingSlot(shotId, 'end'),
        )
      }

      const singleSlot = slotsByType.get('single')

      if (singleSlot) {
        orderedSlots.push(singleSlot)
      }

      orderedSlots.sort(
        (left, right) =>
          FRAME_ORDER[left.frameType] - FRAME_ORDER[right.frameType] ||
          left.keyframeId.localeCompare(right.keyframeId),
      )

      return {
        shotId,
        slots: orderedSlots,
      } satisfies KeyframeReviewShot
    }),
  )
}

async function buildStoryboardReviewState(cwd: string): Promise<StoryboardReviewState> {
  const imagePath = getStoryboardImagePath()
  const markdown = await readFile(
    resolveWorkflowPath(WORKFLOW_FILES.storyboard, cwd),
    'utf8',
  ).catch(() => null)

  return {
    imageUrl: `/${encodeAssetUrl(imagePath)}`,
    imageExists: await fileExists(resolveRepoPath(imagePath, cwd)),
    markdown,
  }
}

async function buildShotReviewCards(cwd: string) {
  const [shots, artifacts] = await Promise.all([
    loadShotPromptsOrEmpty(cwd),
    loadShotArtifactsOrEmpty(cwd),
  ])
  const artifactsByShotId = new Map(artifacts.map((entry) => [entry.shotId, entry]))

  return Promise.all(
    shots.map(async (entry) => {
      const artifact = artifactsByShotId.get(entry.shotId)

      return {
        shotId: entry.shotId,
        status: artifact?.status ?? entry.status,
        durationSeconds: entry.durationSeconds,
        keyframeIds: entry.keyframeIds,
        prompt: artifact?.prompt ?? null,
        model: artifact?.model ?? null,
        videoUrl: `/${encodeAssetUrl(entry.videoPath)}`,
        videoExists: await fileExists(resolveRepoPath(entry.videoPath, cwd)),
      } satisfies ShotReviewCard
    }),
  )
}

async function loadCharacterDetail(
  characterId: string,
  cwd: string,
  requestedVersionId?: string | null,
) {
  const character = (await loadCharacterSheetsOrEmpty(cwd)).find(
    (entry) => entry.characterId === characterId,
  )

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
      'Review retained versions, update the source reference stack, and request targeted edits from the version you are viewing.',
    summaryHref: '/',
    summaryLabel: 'Back to characters',
    mediaType: 'image' as const,
    mediaUrl: activeVersionId
      ? getArtifactVersionMediaUrl(descriptor, activeVersionId)
      : getCanonicalMediaUrl(descriptor),
    mediaExists: Boolean(
      activeVersionId || (await fileExists(resolveRepoPath(descriptor.publicPath, cwd))),
    ),
    mediaPlaceholder: 'No character image yet',
    sourceReferences: character.references ?? [],
    sourcePrompt: character.prompt,
    sourceModel: character.model,
    sourceStatus: character.status,
    historyState,
    notesHtml: `<section class="panel"><p class="section-title">Current Prompt</p><p class="muted">${escapeHtml(character.prompt)}</p></section>`,
    canEdit: historyState.activeVersionId !== null,
    canEditReferences: true,
  } satisfies ArtifactDetailContext
}

async function loadKeyframeDetail(
  keyframeId: string,
  cwd: string,
  requestedVersionId?: string | null,
) {
  const [keyframes, artifacts] = await Promise.all([
    loadKeyframesOrEmpty(cwd),
    loadKeyframeArtifactsOrEmpty(cwd),
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

  return {
    descriptor,
    activeTab: 'keyframes' as const,
    title: keyframe.title,
    subtitle:
      'Use retained versions and explicit references to iterate on a single keyframe without manual file copying.',
    summaryHref: '/keyframes',
    summaryLabel: 'Back to keyframes',
    mediaType: 'image' as const,
    mediaUrl: activeVersionId
      ? getArtifactVersionMediaUrl(descriptor, activeVersionId)
      : getCanonicalMediaUrl(descriptor),
    mediaExists: Boolean(
      activeVersionId || (await fileExists(resolveRepoPath(descriptor.publicPath, cwd))),
    ),
    mediaPlaceholder: 'No keyframe image yet',
    sourceReferences: artifact?.references ?? [],
    sourcePrompt: artifact?.prompt ?? null,
    sourceModel: artifact?.model ?? null,
    sourceStatus: artifact?.status ?? keyframe.status,
    historyState,
    notesHtml: `<section class="panel"><p class="section-title">Keyframe Goal</p><p class="muted">${escapeHtml(keyframe.goal)}</p></section>`,
    canEdit: historyState.activeVersionId !== null && artifact !== undefined,
    canEditReferences: artifact !== undefined,
  } satisfies ArtifactDetailContext
}

async function loadShotDetail(shotId: string, cwd: string, requestedVersionId?: string | null) {
  const [shots, artifacts] = await Promise.all([
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
    activeTab: 'shots' as const,
    title: shotId,
    subtitle:
      'Review retained motion variants, edit the source reference stack, and promote any retained version back to the stable public MP4 path.',
    summaryHref: '/shots',
    summaryLabel: 'Back to shots',
    mediaType: 'video' as const,
    mediaUrl: activeVersionId
      ? getArtifactVersionMediaUrl(descriptor, activeVersionId)
      : getCanonicalMediaUrl(descriptor),
    mediaExists: Boolean(
      activeVersionId || (await fileExists(resolveRepoPath(descriptor.publicPath, cwd))),
    ),
    mediaPlaceholder: 'No shot video yet',
    sourceReferences: artifact?.references ?? [],
    sourcePrompt: artifact?.prompt ?? null,
    sourceModel: artifact?.model ?? null,
    sourceStatus: artifact?.status ?? shot.status,
    historyState,
    notesHtml: `<section class="panel"><p class="section-title">Shot Plan</p><p class="muted">Anchors: ${escapeHtml(shot.keyframeIds.join(' -> '))}</p><p class="small">Duration: ${escapeHtml(formatDurationSeconds(shot.durationSeconds))}</p></section>`,
    canEdit: historyState.activeVersionId !== null && artifact !== undefined,
    canEditReferences: artifact !== undefined,
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
      'The storyboard board acts as a retained visual artifact with explicit references and selected-versus-latest history.',
    summaryHref: '/storyboard',
    summaryLabel: 'Storyboard overview',
    mediaType: 'image' as const,
    mediaUrl: activeVersionId
      ? getArtifactVersionMediaUrl(descriptor, activeVersionId)
      : getCanonicalMediaUrl(descriptor),
    mediaExists: Boolean(
      activeVersionId || (await fileExists(resolveRepoPath(descriptor.publicPath, cwd))),
    ),
    mediaPlaceholder: 'No storyboard image yet',
    sourceReferences: storyboardSidecar?.references ?? [],
    sourcePrompt: markdown,
    sourceModel: config?.imageModel ?? null,
    sourceStatus: historyState.history?.selectedVersionId ? 'ready' : 'missing',
    historyState,
    notesHtml: `<section class="panel"><p class="section-title">Source Storyboard</p>${markdown ? `<pre class="storyboard-markdown">${escapeHtml(markdown.trim())}</pre>` : '<div class="empty-state">No storyboard markdown yet.</div>'}</section>`,
    canEdit: historyState.activeVersionId !== null,
    canEditReferences: true,
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
    return loadKeyframeDetail(decodeURIComponent(keyframeMatch[1]!), cwd, requestedVersionId)
  }

  const shotMatch = /^\/shots\/([^/]+)$/.exec(pathname)

  if (shotMatch) {
    return loadShotDetail(decodeURIComponent(shotMatch[1]!), cwd, requestedVersionId)
  }

  return null
}

async function buildApprovalPreview(
  pathname: string,
  cwd: string,
  baseVersionId: string,
  editInstruction: string,
) {
  if (pathname === '/storyboard') {
    const [storyboardMarkdown, storyboardSidecar] = await Promise.all([
      readFile(resolveWorkflowPath(WORKFLOW_FILES.storyboard, cwd), 'utf8'),
      loadStoryboardSidecar(cwd),
    ])
    const descriptor = getStoryboardArtifactDescriptor()
    const state = await loadArtifactHistoryState(descriptor, cwd, {
      activeVersionId: baseVersionId,
    })

    if (!state.activeVersion) {
      throw new Error('The selected storyboard base version does not exist.')
    }

    const { resolvedReferences } = resolveStoryboardGenerationReferences(
      storyboardSidecar?.references ?? [],
    )

    return {
      descriptor,
      activeTab: 'storyboard' as const,
      baseVersionId,
      editInstruction,
      references: resolvedReferences,
      droppedReferences: [],
      title: 'Approve storyboard edit',
      mediaType: 'image' as const,
      mediaUrl: getArtifactVersionMediaUrl(descriptor, baseVersionId),
      mediaExists: true,
    }
  }

  const characterMatch = /^\/characters\/([^/]+)$/.exec(pathname)

  if (characterMatch) {
    const characterId = decodeURIComponent(characterMatch[1]!)
    const character = (await loadCharacterSheetsOrEmpty(cwd)).find(
      (entry) => entry.characterId === characterId,
    )

    if (!character) {
      throw new Error(`Character "${characterId}" is missing its sidecar.`)
    }

    const descriptor = getCharacterArtifactDescriptor(characterId)
    const state = await loadArtifactHistoryState(descriptor, cwd, {
      activeVersionId: baseVersionId,
    })

    if (!state.activeVersion) {
      throw new Error('The selected character base version does not exist.')
    }

    const { resolvedReferences } = resolveCharacterGenerationReferences({
      selectedVersionPath: getArtifactVersionMediaPath(descriptor, baseVersionId),
      userReferences: character.references ?? [],
    })

    return {
      descriptor,
      activeTab: 'characters' as const,
      baseVersionId,
      editInstruction,
      references: resolvedReferences,
      droppedReferences: [],
      title: `Approve character edit for ${character.displayName}`,
      mediaType: 'image' as const,
      mediaUrl: getArtifactVersionMediaUrl(descriptor, baseVersionId),
      mediaExists: true,
    }
  }

  const keyframeMatch = /^\/keyframes\/([^/]+)$/.exec(pathname)

  if (keyframeMatch) {
    const keyframeId = decodeURIComponent(keyframeMatch[1]!)
    const [keyframes, artifacts, shots] = await Promise.all([
      loadKeyframesOrEmpty(cwd),
      loadKeyframeArtifactsOrEmpty(cwd),
      loadShotPromptsOrEmpty(cwd),
    ])
    const keyframe = keyframes.find((entry) => entry.keyframeId === keyframeId)
    const artifact = artifacts.find((entry) => entry.keyframeId === keyframeId)

    if (!keyframe || !artifact) {
      throw new Error(`Keyframe "${keyframeId}" is missing its source sidecar.`)
    }

    const descriptor = getKeyframeArtifactDescriptor(keyframe)
    const state = await loadArtifactHistoryState(descriptor, cwd, {
      activeVersionId: baseVersionId,
    })

    if (!state.activeVersion) {
      throw new Error('The selected keyframe base version does not exist.')
    }

    const { resolvedReferences } = resolveKeyframeGenerationReferences(
      {
        ...keyframe,
        incomingTransition: shots.find((entry) => entry.shotId === keyframe.shotId)
          ?.incomingTransition ?? {
          type: 'scene-change',
          notes: '',
        },
      },
      keyframes,
      shots,
      {
        selectedVersionPath: getArtifactVersionMediaPath(descriptor, baseVersionId),
        userReferences: artifact.references ?? [],
      },
    )

    return {
      descriptor,
      activeTab: 'keyframes' as const,
      baseVersionId,
      editInstruction,
      references: resolvedReferences,
      droppedReferences: [],
      title: `Approve keyframe edit for ${keyframe.title}`,
      mediaType: 'image' as const,
      mediaUrl: getArtifactVersionMediaUrl(descriptor, baseVersionId),
      mediaExists: true,
    }
  }

  const shotMatch = /^\/shots\/([^/]+)$/.exec(pathname)

  if (shotMatch) {
    const shotId = decodeURIComponent(shotMatch[1]!)
    const [shots, artifacts, keyframes] = await Promise.all([
      loadShotPromptsOrEmpty(cwd),
      loadShotArtifactsOrEmpty(cwd),
      loadKeyframesOrEmpty(cwd),
    ])
    const shot = shots.find((entry) => entry.shotId === shotId)
    const artifact = artifacts.find((entry) => entry.shotId === shotId)

    if (!shot || !artifact) {
      throw new Error(`Shot "${shotId}" is missing its source sidecar.`)
    }

    const descriptor = getShotArtifactDescriptor(shotId)
    const state = await loadArtifactHistoryState(descriptor, cwd, {
      activeVersionId: baseVersionId,
    })

    if (!state.activeVersion) {
      throw new Error('The selected shot base version does not exist.')
    }

    const assets = resolveShotGenerationAssets(shot, keyframes, {
      userReferences: artifact.references ?? [],
    })

    return {
      descriptor,
      activeTab: 'shots' as const,
      baseVersionId,
      editInstruction,
      references: assets.resolvedReferences,
      droppedReferences: assets.droppedReferences,
      title: `Approve shot edit for ${shotId}`,
      mediaType: 'video' as const,
      mediaUrl: getArtifactVersionMediaUrl(descriptor, baseVersionId),
      mediaExists: true,
    }
  }

  throw new Error('Unsupported approval route.')
}

async function buildCharacterPendingGeneration(
  characterId: string,
  cwd: string,
): Promise<PendingCharacterSheetGeneration | null> {
  const generations = selectPendingCharacterSheetGenerations(
    await loadCharacterSheetsOrEmpty(cwd),
    {
      characterId,
    },
  )

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
  const [keyframes, artifacts, shots] = await Promise.all([
    loadKeyframesOrEmpty(cwd),
    loadKeyframeArtifactsOrEmpty(cwd),
    loadShotPromptsOrEmpty(cwd),
  ])
  const generations = selectPendingKeyframeGenerations(keyframes, artifacts, shots, {
    keyframeId,
  })

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
  const [shots, artifacts, keyframes, characterSheets] = await Promise.all([
    loadShotPromptsOrEmpty(cwd),
    loadShotArtifactsOrEmpty(cwd),
    loadKeyframesOrEmpty(cwd),
    loadCharacterSheetsOrEmpty(cwd),
  ])
  const generations = selectPendingShotGenerations(shots, artifacts, {
    shotId,
  })

  return generations[0]
    ? {
        generation: generations[0],
        keyframes,
        characterSheets,
      }
    : null
}

export async function runApprovedAction(
  pathname: string,
  cwd: string,
  baseVersionId: string,
  editInstruction: string,
  overrides: ApprovedActionGeneratorOverrides = {},
) {
  if (pathname === '/storyboard') {
    const [config, storyboardMarkdown, storyboardSidecar] = await Promise.all([
      loadConfig(cwd),
      readFile(resolveWorkflowPath(WORKFLOW_FILES.storyboard, cwd), 'utf8'),
      loadStoryboardSidecar(cwd),
    ])

    return generateStoryboardArtifactVersion({
      storyboardMarkdown,
      model: config.imageModel,
      editInstruction,
      userReferences: storyboardSidecar?.references ?? [],
      baseVersionId,
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

    return generateCharacterSheetArtifactVersion(generation, {
      editInstruction,
      selectedVersionPath: getArtifactVersionMediaPath(descriptor, baseVersionId),
      baseVersionId,
      userReferences: generation.userReferences ?? [],
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

    return generateKeyframeArtifactVersion(pending.generation, pending.keyframes, pending.shots, {
      editInstruction,
      selectedVersionPath: getArtifactVersionMediaPath(descriptor, baseVersionId),
      baseVersionId,
      userReferences: pending.generation.userReferences ?? [],
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

    return generateShotArtifactVersion(
      pending.generation,
      pending.keyframes,
      pending.characterSheets,
      {
        editInstruction,
        baseVersionId,
        userReferences: pending.generation.userReferences ?? [],
        cwd,
        generator: overrides.shotVideoGenerator,
      },
    )
  }

  throw new Error('Unsupported generation route.')
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
  const state = await loadArtifactHistoryState(descriptor, cwd, { activeVersionId: versionId })

  if (!state.activeVersion) {
    return new Response('Not Found', { status: 404 })
  }

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
  run: () => Promise<{ versionId: string }>,
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
      jobs.set(key, {
        status: 'success',
        startedAt: jobs.get(key)?.startedAt ?? new Date().toISOString(),
        completedAt: new Date().toISOString(),
        message: `Generation completed and promoted to ${result.versionId}.`,
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

async function handleApproval(pathname: string, request: Request, cwd: string) {
  const formData = await request.formData()
  const baseVersionId = String(formData.get('baseVersionId') ?? '').trim()
  const editInstruction = String(formData.get('editInstruction') ?? '').trim()

  if (baseVersionId.length === 0 || editInstruction.length === 0) {
    throw new Error('Base version and edit instruction are required.')
  }

  const preview = await buildApprovalPreview(pathname, cwd, baseVersionId, editInstruction)

  return renderApprovalPreview(
    preview.activeTab,
    preview,
    preview.mediaType,
    preview.mediaUrl,
    preview.mediaExists,
  )
}

async function handleGenerate(
  pathname: string,
  request: Request,
  cwd: string,
  jobs: Map<string, ArtifactJobState>,
) {
  const formData = await request.formData()
  const baseVersionId = String(formData.get('baseVersionId') ?? '').trim()
  const editInstruction = String(formData.get('editInstruction') ?? '').trim()
  const detail = await getDetailContext(pathname, cwd)

  if (!detail) {
    return renderErrorPage('characters', 'Missing Artifact', 'Artifact not found.', '/')
  }

  if (baseVersionId.length === 0 || editInstruction.length === 0) {
    throw new Error('Base version and edit instruction are required.')
  }

  startArtifactJob(jobs, detail.descriptor, async () => {
    const result = await runApprovedAction(pathname, cwd, baseVersionId, editInstruction)

    return {
      versionId: result.versionId,
    }
  })

  return redirectTo(getArtifactDetailPath(detail.descriptor))
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
  return redirectTo(
    `${getArtifactDetailPath(detail.descriptor)}?version=${encodeURIComponent(versionId)}`,
  )
}

export function startArtifactReviewServer(options: { cwd?: string; preferredPort?: number } = {}) {
  const { cwd = process.cwd(), preferredPort = 3000 } = options
  const activeJobs = new Map<string, ArtifactJobState>()

  const createServer = (port: number) =>
    Bun.serve({
      port,
      async fetch(request) {
        const url = new URL(request.url)

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

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            url.pathname === '/keyframes'
          ) {
            return renderKeyframesSummary(await buildReviewShots(cwd))
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            url.pathname === '/shots'
          ) {
            return renderShotsSummary(await buildShotReviewCards(cwd))
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            url.pathname === '/storyboard'
          ) {
            const detail = await loadStoryboardDetail(cwd, url.searchParams.get('version'))

            return renderDetailPage(detail, getJobState(activeJobs, detail.descriptor))
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

            return renderDetailPage(detail, getJobState(activeJobs, detail.descriptor))
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            /^\/keyframes\/[^/]+$/.test(url.pathname)
          ) {
            const detail = await loadKeyframeDetail(
              decodeURIComponent(url.pathname.split('/')[2]!),
              cwd,
              url.searchParams.get('version'),
            )

            if (!detail) {
              return renderErrorPage(
                'keyframes',
                'Missing Keyframe',
                'Keyframe not found.',
                '/keyframes',
              )
            }

            return renderDetailPage(detail, getJobState(activeJobs, detail.descriptor))
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
              return renderErrorPage('shots', 'Missing Shot', 'Shot not found.', '/shots')
            }

            return renderDetailPage(detail, getJobState(activeJobs, detail.descriptor))
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

          if (request.method === 'POST' && /\/references$/.test(url.pathname)) {
            return handleReferenceSave(url.pathname.replace(/\/references$/, ''), request, cwd)
          }

          if (request.method === 'POST' && /\/approve$/.test(url.pathname)) {
            return handleApproval(url.pathname.replace(/\/approve$/, ''), request, cwd)
          }

          if (request.method === 'POST' && /\/generate$/.test(url.pathname)) {
            return handleGenerate(url.pathname.replace(/\/generate$/, ''), request, cwd, activeJobs)
          }

          if (request.method === 'POST' && /\/select$/.test(url.pathname)) {
            return handleSelect(url.pathname.replace(/\/select$/, ''), request, cwd)
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
          const activeTab: Tab = url.pathname.startsWith('/shots')
            ? 'shots'
            : url.pathname.startsWith('/keyframes')
              ? 'keyframes'
              : url.pathname.startsWith('/storyboard')
                ? 'storyboard'
                : 'characters'

          return new Response(
            renderPage(
              activeTab,
              `<div class="stack">
                ${renderHero('Artifact Review Error', message, 'Server Error')}
              </div>`,
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
