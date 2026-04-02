/**
 * Timeline component for keyframe pointer placement.
 *
 * Renders a static second-ruler with draggable pointers that snap to
 * second boundaries. Two pointers can share a position (split-pill heads);
 * no more than two are allowed at the same boundary.
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
    { id: 'p6', position: 16 }, // paired with p5 (hard cut)
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
    top: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    cursor: grab;
    z-index: 10;
    transition: left 0.07s ease;
  }
  .tl-pointer.tl-dragging {
    cursor: grabbing;
    z-index: 20;
    transition: none;
  }
  .tl-pointer.tl-selected .tl-head {
    box-shadow: 0 0 0 2px var(--accent), 0 2px 8px rgba(0,0,0,0.4);
  }

  /* ── Pointer head ───────────────────────────────────── */
  .tl-head {
    width: 28px;
    height: 22px;
    background: linear-gradient(180deg, #fbbf24 0%, #f59e0b 100%);
    border-radius: 11px;
    border: 1px solid rgba(0,0,0,0.18);
    box-shadow: 0 2px 6px rgba(0,0,0,0.28);
  }
  .tl-head.tl-pair-l {
    width: 14px;
    border-radius: 11px 2px 2px 11px;
  }
  .tl-head.tl-pair-r {
    width: 14px;
    border-radius: 2px 11px 11px 2px;
  }

  /* ── Paired stem alignment: push legs toward the shared boundary (1px gap) */
  .tl-pair-l ~ .tl-stem {
    align-self: flex-end;
    margin-right: 0;
  }
  .tl-pair-r ~ .tl-stem {
    align-self: flex-start;
    margin-left: 1px;
  }

  /* ── Pointer stem ───────────────────────────────────── */
  .tl-stem {
    width: 2px;
    height: 14px;
    background: #f59e0b;
    border-radius: 0 0 1px 1px;
  }

  /* ── Ghost pointer ──────────────────────────────────── */
  .tl-ghost {
    position: absolute;
    top: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    pointer-events: none;
    z-index: 5;
    opacity: 0;
    transition: opacity 0.12s ease, left 0.05s ease;
  }
  .tl-ghost.tl-visible {
    opacity: 0.28;
  }
  .tl-ghost .tl-head {
    box-shadow: none;
  }

  /* ── Trash button ───────────────────────────────────── */
  .tl-controls {
    position: relative;
    width: ${width}px;
    margin: 0 auto;
    height: 36px;
  }
  .tl-trash {
    position: absolute;
    top: 8px;
    transform: translateX(-50%);
    display: none;
    background: var(--panel-strong);
    border: 1px solid var(--line);
    border-radius: 8px;
    color: var(--error);
    padding: 3px 14px;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
    font-family: inherit;
    transition: background 0.12s, border-color 0.12s;
  }
  .tl-trash:hover {
    background: rgba(248,115,115,0.10);
    border-color: var(--error);
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
      <div class="tl-pointer-layer" id="tl-layer">
        <div class="tl-ghost" id="tl-ghost">
          <div class="tl-head"></div>
          <div class="tl-stem"></div>
        </div>
      </div>
      <div class="tl-ruler" id="tl-ruler">${ticks.join('')}</div>
    </div>
  </div>
  <div class="tl-controls">
    <button class="tl-trash" id="tl-trash">Remove</button>
  </div>
  <div class="tl-hint">
    Double-click to add &middot; Click to select &middot; Drag to move
  </div>
</div>

<script>
(function () {
  'use strict';

  /* ── constants ─────────────────────────────────────── */
  var TOTAL  = ${totalSeconds};
  var PPS    = ${pxPerSecond};
  var HEAD_W = 28;
  var HALF_W = 14;

  /* ── state ─────────────────────────────────────────── */
  var pointers  = ${mockPointers};
  var nextId    = pointers.length + 1;
  var selectedId = null;
  var drag       = null;   // { id, startPos }
  var didDrag    = false;
  var deselectTimer = null;

  /* ── DOM refs ──────────────────────────────────────── */
  var area  = document.getElementById('tl-area');
  var layer = document.getElementById('tl-layer');
  var ghost = document.getElementById('tl-ghost');
  var trash = document.getElementById('tl-trash');
  var ruler = document.getElementById('tl-ruler');

  /* ── helpers ───────────────────────────────────────── */
  function snap(clientX) {
    var rect = ruler.getBoundingClientRect();
    var sec  = Math.round((clientX - rect.left) / PPS);
    return Math.max(0, Math.min(TOTAL, sec));
  }

  function countAt(pos, excludeId) {
    var n = 0;
    for (var i = 0; i < pointers.length; i++) {
      if (pointers[i].position === pos && pointers[i].id !== excludeId) n++;
    }
    return n;
  }

  function canPlace(pos, excludeId) {
    return countAt(pos, excludeId) < 2;
  }

  function find(id) {
    for (var i = 0; i < pointers.length; i++) {
      if (pointers[i].id === id) return pointers[i];
    }
    return null;
  }

  /* ── render ────────────────────────────────────────── */
  function render() {
    // remove old pointer DOM
    var old = layer.querySelectorAll('.tl-pointer');
    for (var i = 0; i < old.length; i++) old[i].remove();

    // group by position
    var byPos = {};
    for (var i = 0; i < pointers.length; i++) {
      var p = pointers[i];
      if (!byPos[p.position]) byPos[p.position] = [];
      byPos[p.position].push(p);
    }

    for (var i = 0; i < pointers.length; i++) {
      var p     = pointers[i];
      var group = byPos[p.position];
      var paired = group.length === 2;
      var isLeft  = paired && group[0].id === p.id;
      var isRight = paired && group[1].id === p.id;

      var el = document.createElement('div');
      el.className = 'tl-pointer'
        + (p.id === selectedId ? ' tl-selected' : '')
        + (drag && drag.id === p.id ? ' tl-dragging' : '');
      el.setAttribute('data-id', p.id);

      var head = document.createElement('div');
      head.className = 'tl-head'
        + (isLeft  ? ' tl-pair-l' : '')
        + (isRight ? ' tl-pair-r' : '');

      var stem = document.createElement('div');
      stem.className = 'tl-stem';

      el.appendChild(head);
      el.appendChild(stem);

      // horizontal position
      var px = p.position * PPS;
      if (paired) {
        el.style.left = (isLeft ? px - HALF_W : px) + 'px';
      } else {
        el.style.left = (px - HEAD_W / 2) + 'px';
      }

      layer.appendChild(el);
    }

    // trash button
    if (selectedId) {
      var sp = find(selectedId);
      if (sp) {
        trash.style.display = 'block';
        trash.style.left = (sp.position * PPS) + 'px';
      } else {
        selectedId = null;
        trash.style.display = 'none';
      }
    } else {
      trash.style.display = 'none';
    }
  }

  /* ── pointer mousedown → select + drag ─────────────── */
  layer.addEventListener('mousedown', function (e) {
    var pEl = e.target.closest('.tl-pointer');
    if (!pEl) return;

    var id = pEl.getAttribute('data-id');
    selectedId = id;
    didDrag = false;

    var p = find(id);
    if (p) drag = { id: id, startPos: p.position };

    e.preventDefault();
    render();
  });

  /* ── mousemove → drag or ghost ─────────────────────── */
  document.addEventListener('mousemove', function (e) {
    /* dragging */
    if (drag) {
      var pos = snap(e.clientX);
      var p = find(drag.id);
      if (p && canPlace(pos, drag.id) && pos !== p.position) {
        p.position = pos;
        didDrag = true;
        render();
      }
      ghost.classList.remove('tl-visible');
      return;
    }

    /* ghost preview */
    var rect = ruler.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var y = e.clientY - rect.top;

    if (x >= 0 && x <= rect.width && y > -70 && y < 30) {
      var pos = snap(e.clientX);
      if (canPlace(pos, null)) {
        ghost.classList.add('tl-visible');
        var cnt = countAt(pos, null);
        var headEl = ghost.querySelector('.tl-head');
        if (cnt === 1) {
          ghost.style.left = (pos * PPS) + 'px';
          headEl.className = 'tl-head tl-pair-r';
        } else {
          ghost.style.left = (pos * PPS - HEAD_W / 2) + 'px';
          headEl.className = 'tl-head';
        }
      } else {
        ghost.classList.remove('tl-visible');
      }
    } else {
      ghost.classList.remove('tl-visible');
    }
  });

  /* ── mouseup → end drag ────────────────────────────── */
  document.addEventListener('mouseup', function () {
    if (drag) {
      drag = null;
      render();
    }
  });

  /* ── click → deselect (with dblclick guard) ────────── */
  document.addEventListener('click', function (e) {
    if (didDrag) { didDrag = false; return; }
    if (e.target.closest('.tl-pointer') || e.target.closest('.tl-trash')) return;

    if (deselectTimer) clearTimeout(deselectTimer);
    deselectTimer = setTimeout(function () {
      if (selectedId) { selectedId = null; render(); }
      deselectTimer = null;
    }, 220);
  });

  /* ── dblclick → add pointer ────────────────────────── */
  area.addEventListener('dblclick', function (e) {
    if (e.target.closest('.tl-pointer')) return;
    if (deselectTimer) { clearTimeout(deselectTimer); deselectTimer = null; }

    var pos = snap(e.clientX);
    if (!canPlace(pos, null)) return;

    var id = 'p' + (nextId++);
    pointers.push({ id: id, position: pos });
    selectedId = id;
    render();
  });

  /* ── trash ─────────────────────────────────────────── */
  trash.addEventListener('click', function (e) {
    e.stopPropagation();
    if (!selectedId) return;
    pointers = pointers.filter(function (p) { return p.id !== selectedId; });
    selectedId = null;
    render();
  });

  /* ── mouse leave → hide ghost ──────────────────────── */
  area.addEventListener('mouseleave', function () {
    ghost.classList.remove('tl-visible');
  });

  /* ── initial render ────────────────────────────────── */
  render();
})();
</script>
`
}
