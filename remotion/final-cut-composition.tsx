/** @jsxImportSource react */

import {
  AbsoluteFill,
  Audio,
  interpolate,
  OffthreadVideo,
  Sequence,
  useCurrentFrame,
} from 'remotion'

import type { ResolvedFinalCutProps, ResolvedFinalCutShot } from '../final-cut'

function ShotSequence({ isFirst, shot }: { isFirst: boolean; shot: ResolvedFinalCutShot }) {
  const fadeDuration =
    !isFirst && shot.transition.type === 'fade' ? shot.transition.durationFrames : 0
  const frame = useCurrentFrame()

  return (
    <Sequence
      from={shot.timelineStartFrame}
      durationInFrames={shot.durationFrames}
      name={shot.shotId}
    >
      <AbsoluteFill
        style={{
          opacity:
            fadeDuration > 0
              ? interpolate(frame, [0, fadeDuration], [0, 1], {
                  extrapolateLeft: 'clamp',
                  extrapolateRight: 'clamp',
                })
              : 1,
        }}
      >
        <OffthreadVideo
          crossOrigin="anonymous"
          src={shot.assetUrl}
          trimBefore={shot.trimStartFrames > 0 ? shot.trimStartFrames : undefined}
          trimAfter={shot.trimEndFrames > 0 ? shot.trimEndFrames : undefined}
          style={{
            height: '100%',
            objectFit: 'cover',
            width: '100%',
          }}
        />
      </AbsoluteFill>
    </Sequence>
  )
}

export const FinalCutComposition = (rawProps: Record<string, unknown>) => {
  const { shots, soundtrack } = rawProps as unknown as ResolvedFinalCutProps
  const durationInFrames = shots.reduce(
    (maxFrame, shot) => Math.max(maxFrame, shot.timelineStartFrame + shot.durationFrames),
    0,
  )

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {soundtrack ? (
        <Sequence from={0} durationInFrames={durationInFrames} name="Soundtrack">
          <Audio crossOrigin="anonymous" src={soundtrack.assetUrl} volume={soundtrack.volume} />
        </Sequence>
      ) : null}
      {shots.map((shot, index) => (
        <ShotSequence key={shot.shotId} isFirst={index === 0} shot={shot} />
      ))}
    </AbsoluteFill>
  )
}
