/**
 * Timeline component for keyframe pointer placement.
 *
 * Renders a static second-ruler with draggable pointers that snap to
 * second boundaries. Every pointer renders as a split head whose left and
 * right halves can be selected independently, while each boundary can hold
 * only one pointer.
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

const DEFAULT_CONFIG: TimelineConfig = {
  totalSeconds: 60,
  pxPerSecond: 20,
  allowedDurations: [4, 6, 8],
}

export function renderTimelineContent(overrides: Partial<TimelineConfig> = {}): string {
  const cfg: TimelineConfig = { ...DEFAULT_CONFIG, ...overrides }
  const { totalSeconds, pxPerSecond } = cfg
  const width = totalSeconds * pxPerSecond

  // --- Time labels (every 5 s) ---
  const labels: string[] = []
  for (let i = 0; i <= totalSeconds; i += 5) {
    const min = Math.floor(i / 60)
    const sec = i % 60
    const text = `${min}:${sec.toString().padStart(2, '0')}`
    labels.push(`<div class="tl-label" style="left:${i * pxPerSecond}px">${text}</div>`)
  }

  // --- Tick blocks (one per second) ---
  const ticks: string[] = []
  for (let i = 0; i < totalSeconds; i++) {
    const cls = (i + 1) % 5 === 0 ? 'tl-tick tl-tick-major' : 'tl-tick'
    ticks.push(`<div class="${cls}"></div>`)
  }

  // --- Mock pointers derived from SHOTS.json layout ---
  const mockPointers = JSON.stringify([
    { id: 'p1', position: 0 },
    { id: 'p2', position: 4 },
    { id: 'p3', position: 8 },
    { id: 'p4', position: 12 },
    { id: 'p5', position: 16 },
    { id: 'p6', position: 18 },
    { id: 'p7', position: 20 },
  ])

  return /* html */ `
<style>
  /* ── Timeline container ─────────────────────────────── */
  .tl-container {
    padding: 48px 20px 20px;
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

  /* ── Time labels ────────────────────────────────────── */
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

  /* ── Pointer layer ──────────────────────────────────── */
  .tl-pointer-layer {
    position: relative;
    height: 36px; /* head 22 + stem 14 */
    margin-bottom: 0;
  }

  /* ── Section element ───────────────────────────────── */
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

  /* ── Ruler ───────────────────────────────────────────── */
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

  /* ── Pointer element ────────────────────────────────── */
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

  /* ── Pointer head ───────────────────────────────────── */
  .tl-head {
    display: flex;
    width: 28px;
    height: 22px;
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
  .tl-head-half:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .tl-head-half.tl-selected {
    position: relative;
    z-index: 1;
    box-shadow: 0 0 0 2px var(--accent), 0 2px 8px rgba(0,0,0,0.4);
  }
  .tl-head-half-l {
    border-radius: 11px 2px 2px 11px;
  }
  .tl-head-half-r {
    margin-left: -1px;
    border-radius: 2px 11px 11px 2px;
  }

  /* ── Pointer stem ───────────────────────────────────── */
  .tl-stem {
    width: 2px;
    height: 14px;
    background: #f59e0b;
    border-radius: 0 0 1px 1px;
  }

  /* ── Hint text ──────────────────────────────────────── */
  .tl-hint {
    width: ${width}px;
    margin: 4px auto 0;
    font-size: 11px;
    color: var(--soft);
    letter-spacing: 0.01em;
  }
</style>

<div class="tl-container">
  <div class="tl-scroll">
    <div class="tl-area" id="tl-area">
      <div class="tl-labels">${labels.join('')}</div>
      <div class="tl-pointer-layer" id="tl-layer"></div>
      <div class="tl-ruler" id="tl-ruler">${ticks.join('')}</div>
    </div>
  </div>
  <div class="tl-hint">
    Click a pointer half or section to select &middot; Drag pointers to move
  </div>
</div>

<script>
(function () {
  'use strict';

  /* ── constants ─────────────────────────────────────── */
  var TOTAL  = ${totalSeconds};
  var PPS    = ${pxPerSecond};
  var HALF_W = 14;

  /* ── state ─────────────────────────────────────────── */
  var pointers  = ${mockPointers};
  var selected  = null; // { type: 'pointer', id, side } | { type: 'section', id }
  var drag      = null; // { id, side, startPos }
  var didDrag   = false;

  /* ── DOM refs ──────────────────────────────────────── */
  var layer = document.getElementById('tl-layer');
  var ruler = document.getElementById('tl-ruler');

  /* ── helpers ───────────────────────────────────────── */
  function snap(clientX) {
    var rect = ruler.getBoundingClientRect();
    var sec  = Math.round((clientX - rect.left) / PPS);
    return Math.max(0, Math.min(TOTAL, sec));
  }

  function find(id) {
    for (var i = 0; i < pointers.length; i++) {
      if (pointers[i].id === id) return pointers[i];
    }
    return null;
  }

  function countAt(pos, excludeId) {
    var count = 0;
    for (var i = 0; i < pointers.length; i++) {
      if (pointers[i].position === pos && pointers[i].id !== excludeId) count++;
    }
    return count;
  }

  function canPlace(pos, excludeId) {
    return countAt(pos, excludeId) === 0;
  }

  function selectedMatchesPointer(id, side) {
    return !!selected
      && selected.type === 'pointer'
      && selected.id === id
      && selected.side === side;
  }

  function selectedMatchesSection(id) {
    return !!selected && selected.type === 'section' && selected.id === id;
  }

  function buildSections() {
    var ordered = pointers.slice().sort(function (a, b) {
      if (a.position !== b.position) return a.position - b.position;
      return a.id.localeCompare(b.id);
    });
    var sections = [];

    for (var i = 0; i < ordered.length - 1; i++) {
      var left = ordered[i];
      var right = ordered[i + 1];
      sections.push({
        id: left.id + '__' + right.id,
        leftId: left.id,
        rightId: right.id,
        start: left.position,
        end: right.position,
      });
    }

    return sections;
  }

  /* ── render ────────────────────────────────────────── */
  function render() {
    layer.innerHTML = '';
    layer.style.height = '36px';

    var sections = buildSections();
    for (var i = 0; i < sections.length; i++) {
      var section = sections[i];
      var startX = section.start * PPS;
      var width = (section.end - section.start) * PPS;

      if (width <= 0) continue;

      var sectionEl = document.createElement('button');
      sectionEl.type = 'button';
      sectionEl.className = 'tl-section'
        + (selectedMatchesSection(section.id) ? ' tl-selected' : '');
      sectionEl.setAttribute('data-section-id', section.id);
      sectionEl.setAttribute(
        'aria-label',
        'Select section between ' + section.start + 's and ' + section.end + 's'
      );
      sectionEl.style.left = startX + 'px';
      sectionEl.style.width = width + 'px';
      layer.appendChild(sectionEl);
    }

    for (var i = 0; i < pointers.length; i++) {
      var p = pointers[i];

      var el = document.createElement('div');
      el.className = 'tl-pointer'
        + (selected && selected.type === 'pointer' && selected.id === p.id ? ' tl-selected' : '')
        + (drag && drag.id === p.id ? ' tl-dragging' : '');
      el.setAttribute('data-id', p.id);

      var head = document.createElement('div');
      head.className = 'tl-head';

      var leftHead = document.createElement('button');
      leftHead.type = 'button';
      leftHead.className = 'tl-head-half tl-head-half-l'
        + (selectedMatchesPointer(p.id, 'left') ? ' tl-selected' : '');
      leftHead.setAttribute('data-side', 'left');
      leftHead.setAttribute('aria-label', 'Select left side of pointer');

      var rightHead = document.createElement('button');
      rightHead.type = 'button';
      rightHead.className = 'tl-head-half tl-head-half-r'
        + (selectedMatchesPointer(p.id, 'right') ? ' tl-selected' : '');
      rightHead.setAttribute('data-side', 'right');
      rightHead.setAttribute('aria-label', 'Select right side of pointer');

      var stem = document.createElement('div');
      stem.className = 'tl-stem';

      head.appendChild(leftHead);
      head.appendChild(rightHead);
      el.appendChild(head);
      el.appendChild(stem);
      el.style.left = (p.position * PPS - HALF_W) + 'px';

      layer.appendChild(el);
    }
  }

  /* ── pointer mousedown → select + drag ─────────────── */
  layer.addEventListener('mousedown', function (e) {
    var sectionEl = e.target.closest('.tl-section');
    if (sectionEl) {
      selected = {
        type: 'section',
        id: sectionEl.getAttribute('data-section-id'),
      };
      drag = null;
      didDrag = false;
      e.preventDefault();
      render();
      return;
    }

    var pEl = e.target.closest('.tl-pointer');
    if (!pEl) return;

    var id = pEl.getAttribute('data-id');
    var sideEl = e.target.closest('.tl-head-half');
    var side = sideEl
      ? sideEl.getAttribute('data-side')
      : (selected && selected.type === 'pointer' && selected.id === id ? selected.side : 'left');

    selected = { type: 'pointer', id: id, side: side };
    didDrag = false;

    var p = find(id);
    if (p) drag = { id: id, side: side, startPos: p.position };

    e.preventDefault();
    render();
  });

  /* ── mousemove → drag ──────────────────────────────── */
  document.addEventListener('mousemove', function (e) {
    if (!drag) return;

    var pos = snap(e.clientX);
    var p = find(drag.id);
    if (p && pos !== p.position && canPlace(pos, drag.id)) {
      p.position = pos;
      didDrag = true;
      render();
    }
  });

  /* ── mouseup → end drag ────────────────────────────── */
  document.addEventListener('mouseup', function () {
    if (drag) {
      drag = null;
      render();
    }
  });

  /* ── click → deselect ──────────────────────────────── */
  document.addEventListener('click', function (e) {
    if (didDrag) { didDrag = false; return; }
    if (e.target.closest('.tl-pointer') || e.target.closest('.tl-section')) return;
    if (selected) {
      selected = null;
      render();
    }
  });

  /* ── initial render ────────────────────────────────── */
  render();
})();
</script>
`
}
