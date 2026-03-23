/** @jsxImportSource react */

import { Composition, type CalculateMetadataFunction } from 'remotion'

import type { ResolvedFinalCutProps } from '../final-cut'

import { FinalCutComposition } from './final-cut-composition'

const defaultProps: ResolvedFinalCutProps = {
  version: 1,
  shots: [],
  soundtrack: null,
}

const calculateMetadata: CalculateMetadataFunction<Record<string, unknown>> = ({ props }) => {
  const finalCutProps = props as unknown as ResolvedFinalCutProps

  if (finalCutProps.shots.length === 0) {
    throw new Error('The final-cut composition requires at least one enabled shot.')
  }

  const firstShot = finalCutProps.shots[0]!
  const durationInFrames = finalCutProps.shots.reduce(
    (maxFrame, shot) => Math.max(maxFrame, shot.timelineStartFrame + shot.durationFrames),
    0,
  )

  return {
    durationInFrames,
    width: firstShot.width,
    height: firstShot.height,
    fps: firstShot.fps,
    defaultOutName: 'final',
    props: finalCutProps as unknown as Record<string, unknown>,
  }
}

export const RemotionRoot = () => {
  return (
    <Composition
      id="final-cut"
      component={FinalCutComposition}
      width={1920}
      height={1080}
      fps={30}
      durationInFrames={1}
      defaultProps={defaultProps as unknown as Record<string, unknown>}
      calculateMetadata={calculateMetadata}
    />
  )
}
