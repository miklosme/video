import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ensureFinalCutManifest, resolveFinalCutProps } from './final-cut'
import { loadFinalCut } from './workflow-data'

async function writeRepoFile(rootDir: string, relativePath: string, content: string) {
  const filePath = path.resolve(rootDir, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')
}

async function runCommand(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`${command} exited with code ${code ?? 1}.`))
    })
  })
}

async function generateVideoFixture(
  filePath: string,
  options: {
    width: number
    height: number
    fps: number
    durationSeconds: number
  },
) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await runCommand('ffmpeg', [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=${options.width}x${options.height}:r=${options.fps}:d=${options.durationSeconds}`,
    '-f',
    'lavfi',
    '-i',
    `anullsrc=r=48000:cl=stereo:d=${options.durationSeconds}`,
    '-shortest',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-y',
    filePath,
  ])
}

async function generateAudioFixture(filePath: string, durationSeconds: number) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await runCommand('ffmpeg', [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${durationSeconds}`,
    '-c:a',
    'pcm_s16le',
    '-y',
    filePath,
  ])
}

async function createFinalCutTestRepo() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-final-cut-'))

  await generateVideoFixture(path.resolve(rootDir, 'workspace/SHOTS/SHOT-01.mp4'), {
    width: 1280,
    height: 720,
    fps: 24,
    durationSeconds: 2,
  })
  await generateVideoFixture(path.resolve(rootDir, 'workspace/SHOTS/SHOT-02.mp4'), {
    width: 1280,
    height: 720,
    fps: 24,
    durationSeconds: 2,
  })
  await writeRepoFile(
    rootDir,
    'workspace/SHOTS.json',
    `${JSON.stringify(
      [
        {
          shotId: 'SHOT-01',
          status: 'planned',
          videoPath: 'workspace/SHOTS/SHOT-01.mp4',
          keyframes: [
            {
              keyframeId: 'SHOT-01-START',
              frameType: 'start',
              imagePath: 'workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png',
            },
          ],
          durationSeconds: 2,
        },
        {
          shotId: 'SHOT-02',
          status: 'planned',
          videoPath: 'workspace/SHOTS/SHOT-02.mp4',
          keyframes: [
            {
              keyframeId: 'SHOT-02-START',
              frameType: 'start',
              imagePath: 'workspace/KEYFRAMES/SHOT-02/SHOT-02-START.png',
            },
          ],
          durationSeconds: 2,
        },
      ],
      null,
      2,
    )}\n`,
  )

  return {
    rootDir,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true })
    },
  }
}

test('ensureFinalCutManifest bootstraps from shot prompts', async () => {
  const repo = await createFinalCutTestRepo()

  try {
    await ensureFinalCutManifest(repo.rootDir)

    const manifest = JSON.parse(
      await readFile(path.resolve(repo.rootDir, 'workspace/FINAL-CUT.json'), 'utf8'),
    ) as { version: number; shots: Array<{ shotId: string; enabled: boolean }> }

    expect(manifest.version).toBe(1)
    expect(manifest.shots.map((shot) => shot.shotId)).toEqual(['SHOT-01', 'SHOT-02'])
    expect(manifest.shots.every((shot) => shot.enabled)).toBe(true)
  } finally {
    await repo.cleanup()
  }
})

test('loadFinalCut validates soundtrack volume bounds', async () => {
  const repo = await createFinalCutTestRepo()

  try {
    await writeRepoFile(
      repo.rootDir,
      'workspace/FINAL-CUT.json',
      `${JSON.stringify(
        {
          version: 1,
          shots: [
            {
              shotId: 'SHOT-01',
              enabled: true,
              trimStartFrames: 0,
              trimEndFrames: 0,
              transition: { type: 'cut', durationFrames: 0 },
            },
            {
              shotId: 'SHOT-02',
              enabled: true,
              trimStartFrames: 0,
              trimEndFrames: 0,
              transition: { type: 'cut', durationFrames: 0 },
            },
          ],
          soundtrack: {
            path: 'workspace/soundtrack.wav',
            volume: 1.2,
          },
        },
        null,
        2,
      )}\n`,
    )

    await expect(loadFinalCut(repo.rootDir)).rejects.toThrow(
      'FINAL-CUT.json.soundtrack.volume must be a number between 0 and 1.',
    )
  } finally {
    await repo.cleanup()
  }
})

test('resolveFinalCutProps rejects duplicate and unknown shot IDs', async () => {
  const repo = await createFinalCutTestRepo()

  try {
    await writeRepoFile(
      repo.rootDir,
      'workspace/FINAL-CUT.json',
      `${JSON.stringify(
        {
          version: 1,
          shots: [
            {
              shotId: 'SHOT-01',
              enabled: true,
              trimStartFrames: 0,
              trimEndFrames: 0,
              transition: { type: 'cut', durationFrames: 0 },
            },
            {
              shotId: 'SHOT-01',
              enabled: true,
              trimStartFrames: 0,
              trimEndFrames: 0,
              transition: { type: 'cut', durationFrames: 0 },
            },
          ],
          soundtrack: null,
        },
        null,
        2,
      )}\n`,
    )

    await expect(
      resolveFinalCutProps(repo.rootDir, { assetBaseUrl: 'http://127.0.0.1:3111' }),
    ).rejects.toThrow('FINAL-CUT.json contains duplicate shotId "SHOT-01".')

    await writeRepoFile(
      repo.rootDir,
      'workspace/FINAL-CUT.json',
      `${JSON.stringify(
        {
          version: 1,
          shots: [
            {
              shotId: 'SHOT-01',
              enabled: true,
              trimStartFrames: 0,
              trimEndFrames: 0,
              transition: { type: 'cut', durationFrames: 0 },
            },
            {
              shotId: 'SHOT-99',
              enabled: true,
              trimStartFrames: 0,
              trimEndFrames: 0,
              transition: { type: 'cut', durationFrames: 0 },
            },
          ],
          soundtrack: null,
        },
        null,
        2,
      )}\n`,
    )

    await expect(
      resolveFinalCutProps(repo.rootDir, { assetBaseUrl: 'http://127.0.0.1:3111' }),
    ).rejects.toThrow('FINAL-CUT.json references unknown shotId "SHOT-99"')
  } finally {
    await repo.cleanup()
  }
})

test('resolveFinalCutProps rejects trims that remove the whole shot', async () => {
  const repo = await createFinalCutTestRepo()

  try {
    await writeRepoFile(
      repo.rootDir,
      'workspace/FINAL-CUT.json',
      `${JSON.stringify(
        {
          version: 1,
          shots: [
            {
              shotId: 'SHOT-01',
              enabled: true,
              trimStartFrames: 24,
              trimEndFrames: 24,
              transition: { type: 'cut', durationFrames: 0 },
            },
            {
              shotId: 'SHOT-02',
              enabled: true,
              trimStartFrames: 0,
              trimEndFrames: 0,
              transition: { type: 'cut', durationFrames: 0 },
            },
          ],
          soundtrack: null,
        },
        null,
        2,
      )}\n`,
    )

    await expect(
      resolveFinalCutProps(repo.rootDir, { assetBaseUrl: 'http://127.0.0.1:3111' }),
    ).rejects.toThrow('FINAL-CUT.json trims remove the full duration of shot "SHOT-01".')
  } finally {
    await repo.cleanup()
  }
})

test('resolveFinalCutProps computes fade overlap timings and soundtrack URLs', async () => {
  const repo = await createFinalCutTestRepo()

  try {
    await generateAudioFixture(path.resolve(repo.rootDir, 'workspace/soundtrack.wav'), 2)
    await writeRepoFile(
      repo.rootDir,
      'workspace/FINAL-CUT.json',
      `${JSON.stringify(
        {
          version: 1,
          shots: [
            {
              shotId: 'SHOT-01',
              enabled: true,
              trimStartFrames: 0,
              trimEndFrames: 0,
              transition: { type: 'cut', durationFrames: 0 },
            },
            {
              shotId: 'SHOT-02',
              enabled: true,
              trimStartFrames: 0,
              trimEndFrames: 0,
              transition: { type: 'fade', durationFrames: 12 },
            },
          ],
          soundtrack: {
            path: 'workspace/soundtrack.wav',
            volume: 0.5,
          },
        },
        null,
        2,
      )}\n`,
    )

    const props = await resolveFinalCutProps(repo.rootDir, {
      assetBaseUrl: 'http://127.0.0.1:3111',
    })

    expect(props.shots).toHaveLength(2)
    expect(props.shots[0]?.timelineStartFrame).toBe(0)
    expect(props.shots[1]?.timelineStartFrame).toBe(36)
    expect(props.shots[0]?.durationFrames).toBe(48)
    expect(props.shots[1]?.durationFrames).toBe(48)
    expect(props.soundtrack).toMatchObject({
      path: 'workspace/soundtrack.wav',
      volume: 0.5,
    })
    expect(props.soundtrack?.assetUrl).toContain('/repo/workspace/soundtrack.wav')
  } finally {
    await repo.cleanup()
  }
})

test('resolveFinalCutProps rejects incompatible enabled shot metadata', async () => {
  const repo = await createFinalCutTestRepo()

  try {
    await generateVideoFixture(path.resolve(repo.rootDir, 'workspace/SHOTS/SHOT-02.mp4'), {
      width: 640,
      height: 360,
      fps: 30,
      durationSeconds: 2,
    })
    await writeRepoFile(
      repo.rootDir,
      'workspace/FINAL-CUT.json',
      `${JSON.stringify(
        {
          version: 1,
          shots: [
            {
              shotId: 'SHOT-01',
              enabled: true,
              trimStartFrames: 0,
              trimEndFrames: 0,
              transition: { type: 'cut', durationFrames: 0 },
            },
            {
              shotId: 'SHOT-02',
              enabled: true,
              trimStartFrames: 0,
              trimEndFrames: 0,
              transition: { type: 'cut', durationFrames: 0 },
            },
          ],
          soundtrack: null,
        },
        null,
        2,
      )}\n`,
    )

    await expect(
      resolveFinalCutProps(repo.rootDir, { assetBaseUrl: 'http://127.0.0.1:3111' }),
    ).rejects.toThrow('Enabled shots must all share the same fps and dimensions.')
  } finally {
    await repo.cleanup()
  }
})
