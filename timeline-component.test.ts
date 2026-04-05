import { expect, test } from 'bun:test'

import { renderTimelineContent } from './timeline-component'

test('renderTimelineContent keeps the current selection when clicking outside the timeline', () => {
  const html = renderTimelineContent({
    pointers: [
      {
        id: 'pointer-1',
        position: 0,
        canDrag: false,
        left: null,
        right: {
          keyframeId: 'SHOT-01-START',
          detailUrl: '/keyframes/SHOT-01-START?embed=1',
          omitted: false,
        },
      },
      {
        id: 'pointer-2',
        position: 6,
        canDrag: true,
        left: {
          keyframeId: 'SHOT-01-END',
          detailUrl: '/keyframes/SHOT-01-END?embed=1',
          omitted: false,
        },
        right: {
          keyframeId: 'SHOT-02-START',
          detailUrl: '/keyframes/SHOT-02-START?embed=1',
          omitted: false,
        },
      },
      {
        id: 'pointer-3',
        position: 12,
        canDrag: false,
        left: {
          keyframeId: 'SHOT-02-END',
          detailUrl: '/keyframes/SHOT-02-END?embed=1',
          omitted: false,
        },
        right: null,
      },
    ],
    sections: [
      {
        shotId: 'SHOT-01',
        detailUrl: '/shots/SHOT-01?embed=1',
      },
      {
        shotId: 'SHOT-02',
        detailUrl: '/shots/SHOT-02?embed=1',
      },
    ],
    keyframeGroups: [],
    saveUrl: '/timeline/save',
  })

  expect(html).toContain("document.addEventListener('click', function () {")
  expect(html).toContain('didDrag = false;')
  expect(html).not.toContain(
    'if (selected) {\n      selected = null;\n      render();\n      refreshDetail(false);\n    }',
  )
})

test('renderTimelineContent restores iframe selection after an embedded detail refresh', () => {
  const html = renderTimelineContent({
    pointers: [
      {
        id: 'pointer-0',
        position: 0,
        canDrag: false,
        left: null,
        right: {
          keyframeId: 'SHOT-01-START',
          detailUrl: '/keyframes/SHOT-01-START?embed=1',
          omitted: false,
        },
      },
      {
        id: 'pointer-1',
        position: 6,
        canDrag: true,
        left: null,
        right: {
          keyframeId: 'SHOT-02-START',
          detailUrl: '/keyframes/SHOT-02-START?embed=1',
          omitted: false,
        },
      },
      {
        id: 'pointer-2',
        position: 12,
        canDrag: false,
        left: {
          keyframeId: 'SHOT-02-END',
          detailUrl: '/keyframes/SHOT-02-END?embed=1',
          omitted: false,
        },
        right: null,
      },
    ],
    sections: [
      {
        shotId: 'SHOT-01',
        detailUrl: '/shots/SHOT-01?embed=1',
      },
      {
        shotId: 'SHOT-02',
        detailUrl: '/shots/SHOT-02?embed=1',
      },
    ],
    keyframeGroups: [],
    saveUrl: '/timeline/save',
  })

  expect(html).toContain("var selectionStorageKey = 'artifact-review.timeline.selection';")
  expect(html).toContain("window.addEventListener('message', function (event) {")
  expect(html).toContain("data.type !== 'artifact-review-refresh'")
  expect(html).toContain(
    'window.sessionStorage.setItem(selectionStorageKey, String(data.detailUrl));',
  )
  expect(html).toContain('findSelectionByDetailUrl(restoredDetailUrl);')
  expect(html).toContain('window.location.reload();')
})

test('renderTimelineContent renders grouped keyframe thumbnails and wires them to pointer selection', () => {
  const html = renderTimelineContent({
    pointers: [
      {
        id: 'pointer-0',
        position: 0,
        canDrag: false,
        left: null,
        right: {
          keyframeId: 'SHOT-01-START',
          detailUrl: '/keyframes/SHOT-01-START?embed=1',
          omitted: false,
        },
      },
      {
        id: 'pointer-1',
        position: 6,
        canDrag: true,
        left: {
          keyframeId: 'SHOT-01-END',
          detailUrl: '/keyframes/SHOT-01-END?embed=1',
          omitted: false,
        },
        right: {
          keyframeId: 'SHOT-02-START',
          detailUrl: '/keyframes/SHOT-02-START?embed=1',
          omitted: false,
        },
      },
      {
        id: 'pointer-2',
        position: 12,
        canDrag: false,
        left: {
          keyframeId: 'SHOT-02-END',
          detailUrl: '/keyframes/SHOT-02-END?embed=1',
          omitted: false,
        },
        right: null,
      },
    ],
    sections: [
      {
        shotId: 'SHOT-01',
        detailUrl: '/shots/SHOT-01?embed=1',
      },
      {
        shotId: 'SHOT-02',
        detailUrl: '/shots/SHOT-02?embed=1',
      },
    ],
    keyframeGroups: [
      {
        shotId: 'SHOT-01',
        items: [
          {
            keyframeId: 'SHOT-01-START',
            shotId: 'SHOT-01',
            frameType: 'start',
            pointerId: 'pointer-0',
            side: 'right',
            detailUrl: '/keyframes/SHOT-01-START?embed=1',
            imageUrl: '/workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
            imageExists: true,
          },
          {
            keyframeId: 'SHOT-01-END',
            shotId: 'SHOT-01',
            frameType: 'end',
            pointerId: 'pointer-1',
            side: 'left',
            detailUrl: '/keyframes/SHOT-01-END?embed=1',
            imageUrl: '/workspace/KEYFRAMES/SHOT-01/SHOT-01-END.png',
            imageExists: false,
          },
        ],
      },
      {
        shotId: 'SHOT-02',
        items: [
          {
            keyframeId: 'SHOT-02-START',
            shotId: 'SHOT-02',
            frameType: 'start',
            pointerId: 'pointer-1',
            side: 'right',
            detailUrl: '/keyframes/SHOT-02-START?embed=1',
            imageUrl: '/workspace/KEYFRAMES/SHOT-02/SHOT-02-START.png',
            imageExists: true,
          },
        ],
      },
    ],
    saveUrl: '/timeline/save',
  })

  expect(html).toContain('tl-keyframe-groups')
  expect(html).toContain('data-keyframe-rail-id="SHOT-01-START"')
  expect(html).toContain('data-pointer-id="pointer-1"')
  expect(html).toContain('tl-keyframe-tile-pair-start')
  expect(html).toContain('tl-keyframe-tile-pair-end')
  expect(html).toContain('Not generated yet')
  expect(html).not.toContain('<span class="pill pill-info">SHOT-01</span>')
  expect(html).not.toContain('<span class="pill">Start</span>')
  expect(html).toContain("keyframeRail.addEventListener('click', function (e) {")
})

test('renderTimelineContent marks invalid shot durations with an orange timeline state', () => {
  const html = renderTimelineContent({
    pointers: [
      {
        id: 'pointer-0',
        position: 0,
        canDrag: false,
        left: null,
        right: {
          keyframeId: 'SHOT-01-START',
          detailUrl: '/keyframes/SHOT-01-START?embed=1',
          omitted: false,
        },
      },
      {
        id: 'pointer-1',
        position: 5,
        canDrag: true,
        left: {
          keyframeId: 'SHOT-01-END',
          detailUrl: '/keyframes/SHOT-01-END?embed=1',
          omitted: false,
        },
        right: {
          keyframeId: 'SHOT-02-START',
          detailUrl: '/keyframes/SHOT-02-START?embed=1',
          omitted: false,
        },
      },
      {
        id: 'pointer-2',
        position: 11,
        canDrag: false,
        left: {
          keyframeId: 'SHOT-02-END',
          detailUrl: '/keyframes/SHOT-02-END?embed=1',
          omitted: false,
        },
        right: null,
      },
    ],
    sections: [
      {
        shotId: 'SHOT-01',
        detailUrl: '/shots/SHOT-01?embed=1',
      },
      {
        shotId: 'SHOT-02',
        detailUrl: '/shots/SHOT-02?embed=1',
      },
    ],
    keyframeGroups: [],
    saveUrl: '/timeline/save',
  })

  expect(html).toContain('.tl-section.tl-invalid-duration')
  expect(html).toContain('var allowedDurations = [4,6,8];')
  expect(html).toContain('function isAllowedDuration(durationSeconds) {')
  expect(html).toContain("+ (!isAllowedDuration(durationSeconds) ? ' tl-invalid-duration' : '')")
})
