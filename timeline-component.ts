/**
 * Timeline component for shot sections and keyframe boundary pointers.
 *
 * Renders a static second-ruler with draggable pointers that snap to
 * second boundaries. Pointers represent the shared boundary between
 * adjacent shots. Pointer sides map to canonical start/end keyframes,
 * including omitted anchors. Sections between pointers map to shots.
 *
 * All HTML, CSS, and client-side JS are returned as a single string
 * so the artifact-review server can embed it inside `renderPage()`.
 */

export interface TimelineConfig {
  /** Total timeline length in seconds. */
  totalSeconds: number
  /** Pixels per second on the ruler. */
  pxPerSecond: number
  /** Valid shot durations the video model supports (seconds). */
  allowedDurations: number[]
}

export interface TimelinePointerSide {
  keyframeId: string
  detailUrl: string
  omitted: boolean
}

export interface TimelineKeyframeTile {
  keyframeId: string
  shotId: string
  frameType: 'start' | 'end'
  pointerId: string
  side: 'left' | 'right'
  detailUrl: string
  imageUrl: string
  imageExists: boolean
}

export interface TimelineKeyframeGroup {
  shotId: string
  items: TimelineKeyframeTile[]
}

export interface TimelinePointer {
  id: string
  position: number
  canDrag: boolean
  left: TimelinePointerSide | null
  right: TimelinePointerSide | null
}

export interface TimelineSection {
  shotId: string
  detailUrl: string
}

export interface TimelineData {
  pointers: TimelinePointer[]
  sections: TimelineSection[]
  keyframeGroups: TimelineKeyframeGroup[]
  saveUrl: string
}

const DEFAULT_CONFIG: TimelineConfig = {
  totalSeconds: 60,
  pxPerSecond: 20,
  allowedDurations: [4, 6, 8],
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderEmptyTimelineState() {
  return `
<section class="panel">
  <p class="section-title">Timeline</p>
  <p class="muted">No planned shots yet. Create <code>workspace/SHOTS.json</code> entries to populate the timeline.</p>
</section>
`
}

function renderKeyframeTile(
  tile: TimelineKeyframeTile,
  options: {
    groupedIndex: number
    groupedCount: number
  },
) {
  const pairClass =
    options.groupedCount > 1
      ? options.groupedIndex === 0
        ? ' tl-keyframe-tile-pair-start'
        : options.groupedIndex === options.groupedCount - 1
          ? ' tl-keyframe-tile-pair-end'
          : ' tl-keyframe-tile-pair-middle'
      : ''
  const media = tile.imageExists
    ? `<img class="version-media" src="${tile.imageUrl}" alt="${escapeHtml(tile.keyframeId)}" loading="lazy">`
    : `<div class="placeholder placeholder-missing tl-keyframe-placeholder">Not generated yet</div>`

  return `
    <button
      class="version-tile tl-keyframe-tile${pairClass}"
      type="button"
      data-keyframe-rail-id="${escapeHtml(tile.keyframeId)}"
      data-pointer-id="${escapeHtml(tile.pointerId)}"
      data-side="${escapeHtml(tile.side)}"
      aria-label="Select keyframe ${escapeHtml(tile.keyframeId)}"
    >
      <div class="version-visual tl-keyframe-visual">
        ${media}
      </div>
    </button>
  `
}

function renderKeyframeRail(groups: TimelineKeyframeGroup[]) {
  if (groups.length === 0) {
    return ''
  }

  return `
    <section class="panel version-rail-shell tl-keyframe-rail-shell">
      <div class="tl-keyframe-groups" id="tl-keyframe-groups">
        ${groups
          .map(
            (group) => `
              <div class="tl-keyframe-group" data-shot-id="${escapeHtml(group.shotId)}">
                ${group.items
                  .map((item, index) =>
                    renderKeyframeTile(item, {
                      groupedIndex: index,
                      groupedCount: group.items.length,
                    }),
                  )
                  .join('')}
              </div>
            `,
          )
          .join('')}
      </div>
    </section>
  `
}

export function renderTimelineContent(
  data: TimelineData,
  overrides: Partial<TimelineConfig> = {},
): string {
  if (data.sections.length === 0 || data.pointers.length === 0) {
    return renderEmptyTimelineState()
  }

  const initialEnd = data.pointers[data.pointers.length - 1]?.position ?? 0
  const cfg: TimelineConfig = { ...DEFAULT_CONFIG, ...overrides }
  const totalSeconds = Math.max(cfg.totalSeconds, initialEnd + 20, 20)
  const { pxPerSecond } = cfg
  const width = totalSeconds * pxPerSecond

  const labels: string[] = []
  for (let i = 0; i <= totalSeconds; i += 5) {
    const min = Math.floor(i / 60)
    const sec = i % 60
    const text = `${min}:${sec.toString().padStart(2, '0')}`
    labels.push(`<div class="tl-label" style="left:${i * pxPerSecond}px">${text}</div>`)
  }

  const ticks: string[] = []
  for (let i = 0; i < totalSeconds; i++) {
    const cls = (i + 1) % 5 === 0 ? 'tl-tick tl-tick-major' : 'tl-tick'
    ticks.push(`<div class="${cls}"></div>`)
  }

  const pointerData = JSON.stringify(data.pointers)
  const sectionData = JSON.stringify(data.sections)
  const saveUrl = JSON.stringify(data.saveUrl)
  const allowedDurationData = JSON.stringify(cfg.allowedDurations)

  return /* html */ `
<style>
  .tl-container {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .tl-keyframe-rail-shell {
    padding: 12px;
  }
  .tl-keyframe-groups {
    display: flex;
    gap: 18px;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    padding-bottom: 2px;
    scrollbar-width: thin;
  }
  .tl-keyframe-group {
    display: flex;
    gap: 2px;
    flex: 0 0 auto;
  }
  .tl-keyframe-tile {
    flex: 0 0 176px;
    display: block;
    padding: 0;
    text-align: left;
    color: inherit;
    letter-spacing: normal;
    text-transform: none;
  }
  .tl-keyframe-tile-pair-start {
    border-radius: 16px 4px 4px 16px;
  }
  .tl-keyframe-tile-pair-end {
    border-radius: 4px 16px 16px 4px;
  }
  .tl-keyframe-tile-pair-middle {
    border-radius: 4px;
  }
  .tl-keyframe-tile.tl-selected {
    border-color: rgba(159,232,112,0.42);
    background:
      linear-gradient(180deg, rgba(159,232,112,0.14), rgba(255,255,255,0.02)),
      rgba(255,255,255,0.025);
    box-shadow:
      inset 0 0 0 1px rgba(159,232,112,0.12),
      0 8px 18px rgba(10, 15, 10, 0.28);
  }
  .tl-keyframe-tile:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .tl-keyframe-visual {
    aspect-ratio: 16 / 9;
  }
  .tl-keyframe-tile-pair-start .tl-keyframe-visual {
    border-radius: 15px 3px 3px 15px;
  }
  .tl-keyframe-tile-pair-end .tl-keyframe-visual {
    border-radius: 3px 15px 15px 3px;
  }
  .tl-keyframe-tile-pair-middle .tl-keyframe-visual {
    border-radius: 3px;
  }
  .tl-keyframe-placeholder {
    height: 100%;
    font-size: 12px;
  }
  .tl-scroll {
    overflow-x: auto;
    padding-bottom: 8px;
  }
  .tl-area {
    position: relative;
    width: ${width}px;
    margin: 0 auto;
    user-select: none;
    -webkit-user-select: none;
  }

  .tl-labels {
    position: relative;
    height: 18px;
    margin-bottom: 4px;
  }
  .tl-label {
    position: absolute;
    top: 0;
    transform: translateX(-50%);
    font-size: 10px;
    color: var(--soft);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.03em;
    pointer-events: none;
  }

  .tl-pointer-layer {
    position: relative;
    height: 40px;
    margin-bottom: 0;
  }

  .tl-section {
    appearance: none;
    position: absolute;
    top: 2px;
    height: 18px;
    margin: 0;
    padding: 0;
    border: 1px solid rgba(22, 101, 52, 0.5);
    border-radius: 999px;
    background: linear-gradient(180deg, rgba(134, 239, 172, 0.9) 0%, rgba(74, 222, 128, 0.82) 100%);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.28), 0 6px 14px rgba(22, 101, 52, 0.14);
    cursor: pointer;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .tl-section:hover {
    background: linear-gradient(180deg, rgba(153, 246, 183, 0.95) 0%, rgba(86, 233, 138, 0.86) 100%);
  }
  .tl-section:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .tl-section.tl-selected {
    z-index: 5;
    box-shadow: 0 0 0 2px var(--accent), inset 0 1px 0 rgba(255,255,255,0.32), 0 8px 16px rgba(22, 101, 52, 0.22);
  }
  .tl-section.tl-invalid-duration {
    border-color: rgba(194, 65, 12, 0.62);
    background: linear-gradient(180deg, rgba(251, 191, 36, 0.96) 0%, rgba(249, 115, 22, 0.9) 100%);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.28), 0 6px 14px rgba(194, 65, 12, 0.18);
  }
  .tl-section.tl-invalid-duration:hover {
    background: linear-gradient(180deg, rgba(252, 211, 77, 0.98) 0%, rgba(251, 146, 60, 0.92) 100%);
  }
  .tl-section.tl-invalid-duration.tl-selected {
    box-shadow: 0 0 0 2px var(--accent), inset 0 1px 0 rgba(255,255,255,0.32), 0 8px 16px rgba(194, 65, 12, 0.28);
  }

  .tl-ruler {
    display: flex;
    height: 10px;
    border-radius: 3px;
    overflow: hidden;
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--line);
  }
  .tl-tick {
    flex: 0 0 ${pxPerSecond}px;
    height: 100%;
    border-right: 1px solid rgba(255,255,255,0.04);
  }
  .tl-tick-major {
    border-right-color: rgba(255,255,255,0.10);
  }

  .tl-pointer {
    position: absolute;
    bottom: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    cursor: grab;
    z-index: 10;
    transition: left 0.07s ease;
  }
  .tl-pointer.tl-selected {
    z-index: 15;
  }
  .tl-pointer.tl-dragging {
    cursor: grabbing;
    z-index: 20;
    transition: none;
  }
  .tl-pointer.tl-fixed {
    cursor: default;
  }

  .tl-head {
    display: flex;
    justify-content: center;
    width: 28px;
    height: 22px;
  }
  .tl-head-spacer {
    width: 14px;
    pointer-events: none;
  }
  .tl-head-half {
    appearance: none;
    width: 14px;
    height: 22px;
    margin: 0;
    padding: 0;
    background: linear-gradient(180deg, #fbbf24 0%, #f59e0b 100%);
    border: 1px solid rgba(0,0,0,0.18);
    box-shadow: 0 2px 6px rgba(0,0,0,0.28);
    cursor: inherit;
  }
  .tl-head-full {
    appearance: none;
    width: 22px;
    height: 22px;
    margin: 0 auto;
    padding: 0;
    background: linear-gradient(180deg, #fbbf24 0%, #f59e0b 100%);
    border: 1px solid rgba(0,0,0,0.18);
    border-radius: 999px;
    box-shadow: 0 2px 6px rgba(0,0,0,0.28);
    cursor: inherit;
  }
  .tl-head-half:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .tl-head-full:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .tl-head-half.tl-selected {
    position: relative;
    z-index: 1;
    box-shadow: 0 0 0 2px var(--accent), 0 2px 8px rgba(0,0,0,0.4);
  }
  .tl-head-full.tl-selected {
    position: relative;
    z-index: 1;
    box-shadow: 0 0 0 2px var(--accent), 0 2px 8px rgba(0,0,0,0.4);
  }
  .tl-head-half.tl-omitted {
    background: linear-gradient(180deg, rgb(134, 239, 172) 0%, rgb(74, 222, 128) 100%);
  }
  .tl-head-full.tl-omitted {
    background: linear-gradient(180deg, rgb(134, 239, 172) 0%, rgb(74, 222, 128) 100%);
  }
  .tl-head-half-l {
    border-radius: 11px 2px 2px 11px;
  }
  .tl-head-half-r {
    margin-left: -1px;
    border-radius: 2px 11px 11px 2px;
  }

  .tl-stem {
    width: 2px;
    height: 18px;
    background: #f59e0b;
    border-radius: 0 0 1px 1px;
  }
  .tl-pointer.tl-fixed .tl-stem {
    opacity: 0.8;
  }

  .tl-detail {
    overflow: hidden;
  }
  .tl-detail-empty {
    padding: 22px;
    color: var(--soft);
    line-height: 1.5;
  }
  .tl-detail-frame {
    display: none;
    width: 100%;
    min-height: 840px;
    border: 0;
    background: transparent;
  }

  @media (max-width: 720px) {
    .tl-container {
      padding: 0px;
    }
    .tl-keyframe-groups {
      gap: 14px;
    }
    .tl-keyframe-tile {
      flex-basis: 152px;
    }
    .tl-detail-frame {
      min-height: 760px;
    }
  }
</style>

<div class="tl-container">
  ${renderKeyframeRail(data.keyframeGroups)}
  <div class="tl-scroll">
    <div class="tl-area" id="tl-area">
      <div class="tl-labels">${labels.join('')}</div>
      <div class="tl-pointer-layer" id="tl-layer"></div>
      <div class="tl-ruler" id="tl-ruler">${ticks.join('')}</div>
    </div>
  </div>

  <section class="tl-detail">
    <div class="tl-detail-empty" id="tl-detail-empty">
      Select a keyframe side or shot section to load its existing review page here.
    </div>
    <iframe
      class="tl-detail-frame"
      id="tl-detail-frame"
      title="Timeline artifact detail"
      loading="eager"
    ></iframe>
  </section>
</div>

<script>
(function () {
  'use strict';

  var TOTAL  = ${totalSeconds};
  var PPS    = ${pxPerSecond};
  var HALF_W = 14;

  var pointers = ${pointerData};
  var sections = ${sectionData};
  var saveUrl = ${saveUrl};
  var allowedDurations = ${allowedDurationData};
  var selected = null;
  var drag = null;
  var didDrag = false;
  var lastSyncedPayload = null;
  var saveToken = 0;
  var selectionStorageKey = 'artifact-review.timeline.selection';

  var layer = document.getElementById('tl-layer');
  var ruler = document.getElementById('tl-ruler');
  var keyframeRail = document.getElementById('tl-keyframe-groups');
  var detailFrame = document.getElementById('tl-detail-frame');
  var detailEmpty = document.getElementById('tl-detail-empty');

  function snap(clientX) {
    var rect = ruler.getBoundingClientRect();
    var sec = Math.round((clientX - rect.left) / PPS);
    return Math.max(0, Math.min(TOTAL, sec));
  }

  function getPointerIndex(id) {
    for (var i = 0; i < pointers.length; i++) {
      if (pointers[i].id === id) return i;
    }
    return -1;
  }

  function getPointer(id) {
    var index = getPointerIndex(id);
    return index >= 0 ? pointers[index] : null;
  }

  function getSection(shotId) {
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].shotId === shotId) return sections[i];
    }
    return null;
  }

  function isAllowedDuration(durationSeconds) {
    return allowedDurations.indexOf(durationSeconds) !== -1;
  }

  function getPointerSide(pointer, side) {
    if (!pointer) return null;
    return side === 'left' ? pointer.left : pointer.right;
  }

  function getDefaultSide(pointer) {
    if (!pointer) return null;
    if (pointer.left) return 'left';
    if (pointer.right) return 'right';
    return null;
  }

  function selectedMatchesPointer(id, side) {
    return !!selected
      && selected.type === 'pointer'
      && selected.pointerId === id
      && selected.side === side;
  }

  function selectedMatchesSection(shotId) {
    return !!selected && selected.type === 'section' && selected.shotId === shotId;
  }

  function buildPointerSelection(pointerId, side) {
    var pointer = getPointer(pointerId);
    var sideData = getPointerSide(pointer, side);

    if (!pointer || !sideData) {
      return null;
    }

    return {
      type: 'pointer',
      pointerId: pointerId,
      side: side,
      detailUrl: sideData.detailUrl,
    };
  }

  function buildSectionSelection(shotId) {
    var section = getSection(shotId);

    if (!section) {
      return null;
    }

    return {
      type: 'section',
      shotId: shotId,
      detailUrl: section.detailUrl,
    };
  }

  function findSelectionByDetailUrl(detailUrl) {
    if (!detailUrl) return null;

    for (var i = 0; i < pointers.length; i++) {
      var pointer = pointers[i];

      if (pointer.left && pointer.left.detailUrl === detailUrl) {
        return buildPointerSelection(pointer.id, 'left');
      }

      if (pointer.right && pointer.right.detailUrl === detailUrl) {
        return buildPointerSelection(pointer.id, 'right');
      }
    }

    for (var j = 0; j < sections.length; j++) {
      if (sections[j].detailUrl === detailUrl) {
        return buildSectionSelection(sections[j].shotId);
      }
    }

    return null;
  }

  function computeTimelinePayload() {
    var shotDurations = [];

    for (var i = 0; i < sections.length; i++) {
      shotDurations.push({
        shotId: sections[i].shotId,
        durationSeconds: pointers[i + 1].position - pointers[i].position,
      });
    }

    return { shots: shotDurations };
  }

  function serializePayload(payload) {
    return JSON.stringify(payload.shots);
  }

  function refreshDetail(forceReload) {
    if (!selected) {
      detailFrame.style.display = 'none';
      detailEmpty.style.display = 'block';
      return;
    }

    var nextUrl = selected.detailUrl;
    detailEmpty.style.display = 'none';
    detailFrame.style.display = 'block';

    if (forceReload || detailFrame.getAttribute('src') !== nextUrl) {
      detailFrame.setAttribute('src', nextUrl);
    }
  }

  function syncKeyframeRailSelection() {
    if (!keyframeRail) return;

    var tiles = keyframeRail.querySelectorAll('.tl-keyframe-tile');

    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      var isSelected = selectedMatchesPointer(
        tile.getAttribute('data-pointer-id'),
        tile.getAttribute('data-side')
      );

      tile.classList.toggle('tl-selected', isSelected);
      tile.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    }
  }

  function resizeDetailFrame() {
    if (!detailFrame.contentWindow) return;

    try {
      var doc = detailFrame.contentWindow.document;
      if (!doc || !doc.body || !doc.documentElement) return;

      var height = Math.max(
        doc.body.scrollHeight,
        doc.documentElement.scrollHeight,
        720
      );

      detailFrame.style.height = height + 'px';
    } catch (_error) {
      // Same-origin detail pages are expected, but ignore resize failures.
    }
  }

  function syncDurations() {
    var payload = computeTimelinePayload();
    var serialized = serializePayload(payload);

    if (serialized === lastSyncedPayload) {
      return;
    }

    var requestToken = ++saveToken;

    window.fetch(saveUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
      .then(function (response) {
        if (response.ok) {
          return response.json().catch(function () {
            return {};
          });
        }

        return response.json()
          .catch(function () {
            return { error: 'Timeline update failed.' };
          })
          .then(function (body) {
            throw new Error(body && body.error ? body.error : 'Timeline update failed.');
          });
      })
      .then(function () {
        if (requestToken !== saveToken) return;

        lastSyncedPayload = serialized;
        refreshDetail(true);
      })
      .catch(function (error) {
        if (requestToken !== saveToken) return;

        console.error('Timeline update failed:', error instanceof Error ? error.message : String(error));
      });
  }

  function clampPointerPosition(index, pos) {
    if (index <= 0) {
      return pointers[index].position;
    }

    var min = pointers[index - 1].position + 1;
    var max = index === pointers.length - 1
      ? TOTAL
      : pointers[index + 1].position - 1;

    return Math.max(min, Math.min(max, pos));
  }

  function createPointerHalf(pointerId, side, sideData) {
    if (!sideData) {
      var spacer = document.createElement('span');
      spacer.className = 'tl-head-spacer';
      spacer.setAttribute('aria-hidden', 'true');
      return spacer;
    }

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'tl-head-half tl-head-half-' + side.charAt(0)
      + (selectedMatchesPointer(pointerId, side) ? ' tl-selected' : '')
      + (sideData.omitted ? ' tl-omitted' : '');
    button.setAttribute('data-side', side);
    button.setAttribute(
      'aria-label',
      (sideData.omitted ? 'Select omitted keyframe ' : 'Select keyframe ') + sideData.keyframeId
    );

    return button;
  }

  function createPointerFull(pointerId, side, sideData) {
    if (!sideData) {
      return null;
    }

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'tl-head-full'
      + (selectedMatchesPointer(pointerId, side) ? ' tl-selected' : '')
      + (sideData.omitted ? ' tl-omitted' : '');
    button.setAttribute('data-side', side);
    button.setAttribute(
      'aria-label',
      (sideData.omitted ? 'Select omitted keyframe ' : 'Select keyframe ') + sideData.keyframeId
    );

    return button;
  }

  function render() {
    layer.innerHTML = '';
    layer.style.height = '40px';

    for (var i = 0; i < sections.length; i++) {
      var section = sections[i];
      var durationSeconds = pointers[i + 1].position - pointers[i].position;
      var startX = pointers[i].position * PPS;
      var width = durationSeconds * PPS;

      if (width <= 0) continue;

      var sectionEl = document.createElement('button');
      sectionEl.type = 'button';
      sectionEl.className = 'tl-section'
        + (!isAllowedDuration(durationSeconds) ? ' tl-invalid-duration' : '')
        + (selectedMatchesSection(section.shotId) ? ' tl-selected' : '');
      sectionEl.setAttribute('data-shot-id', section.shotId);
      sectionEl.setAttribute('aria-label', 'Select shot ' + section.shotId);
      sectionEl.style.left = startX + 'px';
      sectionEl.style.width = width + 'px';

      layer.appendChild(sectionEl);
    }

    for (var j = 0; j < pointers.length; j++) {
      var pointer = pointers[j];

      var el = document.createElement('div');
      el.className = 'tl-pointer'
        + (selected && selected.type === 'pointer' && selected.pointerId === pointer.id ? ' tl-selected' : '')
        + (drag && drag.id === pointer.id ? ' tl-dragging' : '')
        + (!pointer.canDrag ? ' tl-fixed' : '');
      el.setAttribute('data-id', pointer.id);

      var head = document.createElement('div');
      head.className = 'tl-head';
      if (pointer.left && pointer.right) {
        head.appendChild(createPointerHalf(pointer.id, 'left', pointer.left));
        head.appendChild(createPointerHalf(pointer.id, 'right', pointer.right));
      } else {
        var side = pointer.left ? 'left' : (pointer.right ? 'right' : null);
        if (side) {
          head.appendChild(createPointerFull(pointer.id, side, pointer[side]));
        } else {
          head.appendChild(createPointerHalf(pointer.id, 'left', pointer.left));
          head.appendChild(createPointerHalf(pointer.id, 'right', pointer.right));
        }
      }

      var stem = document.createElement('div');
      stem.className = 'tl-stem';

      el.appendChild(head);
      el.appendChild(stem);
      el.style.left = (pointer.position * PPS - HALF_W) + 'px';

      layer.appendChild(el);
    }

    syncKeyframeRailSelection();
  }

  if (keyframeRail) {
    keyframeRail.addEventListener('click', function (e) {
      var tile = e.target.closest('.tl-keyframe-tile');
      if (!tile) return;

      selected = buildPointerSelection(
        tile.getAttribute('data-pointer-id'),
        tile.getAttribute('data-side')
      );
      drag = null;
      didDrag = false;
      render();
      refreshDetail(false);
      e.preventDefault();
    });
  }

  layer.addEventListener('mousedown', function (e) {
    var sectionEl = e.target.closest('.tl-section');
    if (sectionEl) {
      selected = buildSectionSelection(sectionEl.getAttribute('data-shot-id'));
      drag = null;
      didDrag = false;
      render();
      refreshDetail(false);
      e.preventDefault();
      return;
    }

    var pointerEl = e.target.closest('.tl-pointer');
    if (!pointerEl) return;

    var pointerId = pointerEl.getAttribute('data-id');
    var pointer = getPointer(pointerId);
    var sideEl = e.target.closest('.tl-head-half, .tl-head-full');
    var side = sideEl
      ? sideEl.getAttribute('data-side')
      : (
          selected
          && selected.type === 'pointer'
          && selected.pointerId === pointerId
          && getPointerSide(pointer, selected.side)
            ? selected.side
            : getDefaultSide(pointer)
        );

    if (!side) return;

    selected = buildPointerSelection(pointerId, side);
    didDrag = false;

    if (pointer && pointer.canDrag) {
      drag = {
        id: pointerId,
        index: getPointerIndex(pointerId),
      };
    } else {
      drag = null;
    }

    render();
    refreshDetail(false);
    e.preventDefault();
  });

  document.addEventListener('mousemove', function (e) {
    if (!drag) return;

    var pointer = pointers[drag.index];
    if (!pointer) return;

    var nextPos = clampPointerPosition(drag.index, snap(e.clientX));
    if (nextPos === pointer.position) return;

    pointer.position = nextPos;
    didDrag = true;
    render();
  });

  document.addEventListener('mouseup', function () {
    var changed = didDrag;

    if (drag) {
      drag = null;
      render();
    }

    if (changed) {
      syncDurations();
    }
  });

  document.addEventListener('click', function () {
    if (didDrag) {
      didDrag = false;
    }
  });

  detailFrame.addEventListener('load', function () {
    resizeDetailFrame();
    window.setTimeout(resizeDetailFrame, 60);
    window.setTimeout(resizeDetailFrame, 300);
  });

  window.addEventListener('message', function (event) {
    var data = event.data;

    if (
      event.origin !== window.location.origin ||
      !data ||
      data.type !== 'artifact-review-refresh' ||
      !data.detailUrl
    ) {
      return;
    }

    try {
      window.sessionStorage.setItem(selectionStorageKey, String(data.detailUrl));
    } catch (_error) {
      // Ignore storage failures and fall back to a plain reload.
    }

    window.location.reload();
  });

  lastSyncedPayload = serializePayload(computeTimelinePayload());
  try {
    var restoredDetailUrl = window.sessionStorage.getItem(selectionStorageKey);

    if (restoredDetailUrl) {
      selected = findSelectionByDetailUrl(restoredDetailUrl);
      window.sessionStorage.removeItem(selectionStorageKey);
    }
  } catch (_error) {
    // Ignore storage failures and start unselected.
  }
  render();
  refreshDetail(false);
})();
</script>
`
}
