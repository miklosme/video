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
    saveUrl: '/timeline/save',
  })

  expect(html).toContain("document.addEventListener('click', function () {")
  expect(html).toContain('didDrag = false;')
  expect(html).not.toContain(
    'if (selected) {\n      selected = null;\n      render();\n      refreshDetail(false);\n    }',
  )
})
