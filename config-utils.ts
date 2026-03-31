import type { ConfigData } from './workflow-data'

export function buildConfigSavePayload(
  currentConfig: ConfigData,
  nextSelections: Pick<ConfigData, 'agentModel' | 'imageModel' | 'videoModel'>,
): ConfigData {
  return {
    ...currentConfig,
    agentModel: nextSelections.agentModel,
    imageModel: nextSelections.imageModel,
    videoModel: nextSelections.videoModel,
  }
}
