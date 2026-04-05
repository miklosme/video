import type { CameraVocabularyCategory, KeyframeCameraSpec, ShotCameraSpec } from './workflow-data'

export const DEFAULT_KEYFRAME_CAMERA: KeyframeCameraSpec = {
  shotSize: 'medium-shot',
  cameraPosition: 'eye-level',
  cameraAngle: 'level-angle',
}

export const DEFAULT_SHOT_CAMERA: ShotCameraSpec = {
  ...DEFAULT_KEYFRAME_CAMERA,
  cameraMovement: 'static-shot',
}

export type CameraFieldKey = keyof ShotCameraSpec

export const KEYFRAME_CAMERA_FIELDS = ['shotSize', 'cameraPosition', 'cameraAngle'] as const
export const SHOT_CAMERA_FIELDS = [
  ...KEYFRAME_CAMERA_FIELDS,
  'cameraMovement',
] as const satisfies readonly CameraFieldKey[]

export const CAMERA_FIELD_LABELS: Record<CameraFieldKey, string> = {
  shotSize: 'Size',
  cameraPosition: 'Position',
  cameraAngle: 'Angle',
  cameraMovement: 'Camera Movement',
}

export const CAMERA_FIELD_CATEGORIES: Record<CameraFieldKey, CameraVocabularyCategory> = {
  shotSize: 'shot_size',
  cameraPosition: 'camera_position',
  cameraAngle: 'camera_angle',
  cameraMovement: 'camera_movement',
}

export function humanizeCameraValue(value: string) {
  return value
    .split('-')
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment[0]!.toUpperCase()}${segment.slice(1)}`)
    .join(' ')
}

export function resolveKeyframeCameraSpec(
  camera: Partial<KeyframeCameraSpec> | null | undefined,
): KeyframeCameraSpec {
  return {
    shotSize: camera?.shotSize?.trim() || DEFAULT_KEYFRAME_CAMERA.shotSize,
    cameraPosition: camera?.cameraPosition?.trim() || DEFAULT_KEYFRAME_CAMERA.cameraPosition,
    cameraAngle: camera?.cameraAngle?.trim() || DEFAULT_KEYFRAME_CAMERA.cameraAngle,
  }
}

export function resolveShotCameraSpec(
  camera: Partial<ShotCameraSpec> | null | undefined,
): ShotCameraSpec {
  return {
    ...resolveKeyframeCameraSpec(camera),
    cameraMovement: camera?.cameraMovement?.trim() || DEFAULT_SHOT_CAMERA.cameraMovement,
  }
}

export function formatKeyframeCameraPlan(camera: Partial<KeyframeCameraSpec> | null | undefined) {
  const resolvedCamera = resolveKeyframeCameraSpec(camera)

  return [
    `- ${CAMERA_FIELD_LABELS.shotSize}: ${humanizeCameraValue(resolvedCamera.shotSize)}`,
    `- ${CAMERA_FIELD_LABELS.cameraPosition}: ${humanizeCameraValue(resolvedCamera.cameraPosition)}`,
    `- ${CAMERA_FIELD_LABELS.cameraAngle}: ${humanizeCameraValue(resolvedCamera.cameraAngle)}`,
  ].join('\n')
}

export function formatShotCameraPlan(camera: Partial<ShotCameraSpec> | null | undefined) {
  const resolvedCamera = resolveShotCameraSpec(camera)

  return [
    formatKeyframeCameraPlan(resolvedCamera),
    `- ${CAMERA_FIELD_LABELS.cameraMovement}: ${humanizeCameraValue(
      resolvedCamera.cameraMovement,
    )}`,
  ].join('\n')
}
