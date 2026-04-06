import type { ConfigData } from './workflow-data'

export function buildConfigSavePayload(
  currentConfig: ConfigData,
  nextSelections: Pick<ConfigData, 'agentModel' | 'imageModel' | 'fastImageModel' | 'videoModel'>,
): ConfigData {
  return {
    ...currentConfig,
    agentModel: nextSelections.agentModel,
    imageModel: nextSelections.imageModel,
    fastImageModel: nextSelections.fastImageModel,
    videoModel: nextSelections.videoModel,
  }
}
