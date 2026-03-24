# Video Agent

This repo is a mixed-format workspace for developing AI-generated films with a simplified creative workflow.

## Guides

- `CREATIVE_AGENTS.md`: creative chatbot workflow and behavior
- `AGENTS.md`: coding-agent instructions
- `MODEL_OPTIONS.json`: fixed model-card options used by the config dialog

## Canonical Workflow

- `workspace/IDEA.md`
- `workspace/CONFIG.json`
- `workspace/STATUS.json`
- `workspace/STORY.md`
- `workspace/CHARACTERS.md`
- `workspace/CHARACTERS/`
- `workspace/STORYBOARD.md`
- `workspace/STORYBOARD.png`
- `workspace/KEYFRAMES.json`
- `workspace/KEYFRAMES/`
- `workspace/SHOTS.json`
- `workspace/SHOTS/`
- `workspace/FINAL-CUT.json`

## Working Rules

- Start from `workspace/IDEA.md`.
- When a canonical workspace file is missing, copy the matching template first.
- `workspace/CONFIG.json` stores the active agent, image, and video model cards for the current project.
- `workspace/STATUS.json` is a flat array of visible creative milestones, ordered from first step to last step.
- Keep harness setup and other bookkeeping out of `workspace/STATUS.json`.
- `workspace/CHARACTERS.md` stores textual character definitions, and each character section should include a stable `Character ID:`.
- `workspace/CHARACTERS/` stores character-sheet sidecar JSON files plus the generated `.png` sheets beside them.
- `workspace/STORYBOARD.md` is the single canonical storyboard file and should use stable shot IDs such as `SHOT-01`.
- `workspace/STORYBOARD.png` is the single storyboard review artifact for the whole project, generated from `workspace/STORYBOARD.md` before keyframe review.
- `workspace/KEYFRAMES.json` should use distinct keyframe IDs such as `SHOT-01-START` and `SHOT-01-END`, each linked back to a parent `shotId`, and each keyframe entry must list the relevant `characterIds` for that frame.
- `workspace/KEYFRAMES/` stores one sidecar JSON and one generated `.png` per keyframe, grouped under each `shotId`.
- By default, plan one `start` and one `end` keyframe per storyboard shot. Use `single` only for a deliberate one-anchor exception.
- `workspace/SHOTS.json` is the planning manifest for shots and should use the exact shape `{ shotId, status, videoPath, keyframeIds, durationSeconds }`.
- `workspace/SHOTS/` stores one sidecar JSON and one generated `.mp4` per shot, sharing the same `shotId` basename.
- `workspace/FINAL-CUT.json` stores the saved Remotion edit manifest for the final assembly step and should use the exact shape `{ version, shots, soundtrack }`.
- Use `TBD` for unresolved creative information and `TODO` for coding work.

## Tooling Notes

- `bun validate-workflow-data.ts` validates required workflow files and the simplified JSON schemas.
- `bun generate-character-sheets.ts` syncs missing `workspace/CHARACTERS/*.png` files from their sidecar JSON files.
- `bun generate-storyboard.ts` syncs the missing `workspace/STORYBOARD.png` review board from the raw contents of `workspace/STORYBOARD.md`.
- `bun generate-keyframes.ts` syncs missing `workspace/KEYFRAMES/**/*.png` files from their sidecar JSON files and `workspace/KEYFRAMES.json`, attaching the storyboard review board for all keyframes, the relevant character sheets, and the same-shot start frame first for end-frame generation.
- `bun generate-shots.ts` syncs missing `workspace/SHOTS/*.mp4` files from `workspace/SHOTS.json` and `workspace/SHOTS/*.json`, using the start frame as the image-to-video input, the end frame as the last-frame control when present, up to three character-sheet references in priority order, and each shot's `durationSeconds` value for the requested clip length.
- `bun run remotion:studio` bootstraps `workspace/FINAL-CUT.json` when needed, serves repo media to Remotion Studio, and opens the stock Studio against the saved final-cut manifest.
- `bun run remotion:render` uses the same `workspace/FINAL-CUT.json` manifest to render the `final-cut` composition to `outputs/final.mp4` by default.
- `generate-imagen-options.ts` preserves the direct CLI contract, uses the Vercel AI Gateway through the AI SDK, supports `AI_GATEWAY_API_KEY`, and appends generation records to `workspace/GENERATION-LOG.jsonl`.

## Commit Workflow

- `.current-commit-message` is a local scratch file that the coding agent updates after successful validation with a terse commit subject suffix.
- `git commit -m fix` and similar short type-only subjects are expanded by the hook into `fix: <agent summary>`.
- Longer manual subjects such as `git commit -m "refactor auth flow"` are left untouched.
- If the commit starts with an empty subject, the hook falls back to `wip: <agent summary>` or `wip: update project files` when no scratch message is available.
