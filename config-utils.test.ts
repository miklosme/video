import { expect, test } from 'bun:test'

import { buildConfigSavePayload } from './config-utils'

test('buildConfigSavePayload preserves variantCount while updating model selections', () => {
  expect(
    buildConfigSavePayload(
      {
        agentModel: 'agent-a',
        imageModel: 'image-a',
        videoModel: 'video-a',
        variantCount: 3,
      },
      {
        agentModel: 'agent-b',
        imageModel: 'image-b',
        videoModel: 'video-b',
      },
    ),
  ).toEqual({
    agentModel: 'agent-b',
    imageModel: 'image-b',
    videoModel: 'video-b',
    variantCount: 3,
  })
})
