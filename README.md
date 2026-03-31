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
- `workspace/STORYBOARD.json` (optional)
- `workspace/STORYBOARD.png`
- `workspace/KEYFRAMES.json`
- `workspace/KEYFRAMES/`
- `workspace/SHOTS.json`
- `workspace/SHOTS/`
- `workspace/FINAL-CUT.json`

## Working Rules

- Start from `workspace/IDEA.md`.
- When a canonical workspace file is missing, copy the matching template first.
- `workspace/CONFIG.json` stores the active agent, image, and video model cards plus the default visual `variantCount` for the current project.
- `workspace/STATUS.json` is a flat array of visible creative milestones, ordered from first step to last step.
- Keep harness setup and other bookkeeping out of `workspace/STATUS.json`.
- `workspace/CHARACTERS.md` stores textual character definitions, and each character section should include a stable `Character ID:`.
- `workspace/CHARACTERS/` stores character-sheet sidecar JSON files plus the generated `.png` sheets beside them.
- `workspace/STORYBOARD.md` is the single canonical storyboard file and should use stable shot IDs such as `SHOT-01`.
- `workspace/STORYBOARD.json` is an optional storyboard sidecar for user-authored `references`, using repo-relative paths and optional `label`, `role`, and `notes`.
- `workspace/STORYBOARD.png` is the single storyboard review artifact for the whole project, generated from `workspace/STORYBOARD.md` before keyframe review.
- `workspace/KEYFRAMES.json` should use distinct keyframe IDs such as `SHOT-01-START` and `SHOT-01-END`, each linked back to a parent `shotId`, and each keyframe entry must list the relevant `characterIds` for that frame.
- `workspace/KEYFRAMES/` stores one sidecar JSON and one generated `.png` per keyframe, grouped under each `shotId`. Keyframe sidecars may include optional `references`.
- By default, plan one `start` and one `end` keyframe per storyboard shot. Use `single` only for a deliberate one-anchor exception.
- `workspace/SHOTS.json` is the planning manifest for shots and should use the exact shape `{ shotId, status, videoPath, keyframeIds, durationSeconds, incomingTransition: { type, notes } }`.
- `workspace/SHOTS/` stores one sidecar JSON and one generated `.mp4` per shot, sharing the same `shotId` basename. Shot sidecars may include optional `references`.
- `workspace/FINAL-CUT.json` stores the saved Remotion edit manifest for the final assembly step and should use the exact shape `{ version, shots, soundtrack }`.
- Visual artifacts retain linear history under nearby `HISTORY/` folders. `artifact.json` tracks selected-vs-latest state and each retained `vN.json` stores version-specific metadata.
- Use `TBD` for unresolved creative information and `TODO` for coding work.

## Tooling Notes

- `bun validate-workflow-data.ts` validates required workflow files, optional sidecar `references`, and the simplified JSON schemas.
- `bun generate-character-sheets.ts` syncs missing `workspace/CHARACTERS/*.png` files from their sidecar JSON files, renders `workspace/CONFIG.json.variantCount` retained variants in sequence when a stable selected PNG is missing, and keeps only the last new variant selected at the public PNG path.
- `bun generate-storyboard.ts` syncs the missing `workspace/STORYBOARD.png` review board from `workspace/STORYBOARD.md`, reads optional storyboard-sidecar `references`, renders `workspace/CONFIG.json.variantCount` retained variants in sequence when the stable selected board is missing, and keeps only the last new variant selected at the public PNG path.
- `bun generate-keyframes.ts` syncs missing `workspace/KEYFRAMES/**/*.png` files from their sidecar JSON files, `workspace/KEYFRAMES.json`, and `workspace/SHOTS.json`, attaches the storyboard review board plus continuity references, renders `workspace/CONFIG.json.variantCount` retained variants in sequence when a stable selected keyframe is missing, and keeps only the last new variant selected at the public PNG path.
- `bun generate-shots.ts` syncs missing `workspace/SHOTS/*.mp4` files from `workspace/SHOTS.json` and `workspace/SHOTS/*.json`, uses the start frame as the image-to-video input, the end frame as the last-frame control when present, renders `workspace/CONFIG.json.variantCount` retained variants in sequence when a stable selected shot is missing, and keeps only the last new variant selected at the public MP4 path.
- `bun run remotion:studio` bootstraps `workspace/FINAL-CUT.json` when needed, serves repo media to Remotion Studio, and opens the stock Studio against the saved final-cut manifest.
- `bun run remotion:render` uses the same `workspace/FINAL-CUT.json` manifest to render the `final-cut` composition to `outputs/final.mp4` by default.
- `artifact-review-server.ts` is now the lightweight artifact-control surface for retained history, selected-vs-latest state, source reference editing, approval, and manual reselection.
- `generate-imagen-options.ts` preserves the direct CLI contract, uses the Vercel AI Gateway through the AI SDK, supports `AI_GATEWAY_API_KEY`, and appends generation records to `workspace/GENERATION-LOG.jsonl`.

## Telemetry

- PostHog telemetry is optional. Set `POSTHOG_KEY` and optionally `POSTHOG_HOST` to enable it.
- The app stores a stable anonymous local install ID outside the repo and adds a fresh session ID for each run plus a trace ID for each agent turn.
- v1 PostHog LLM analytics targets the text agent path in `app.tsx` and `video-agent-core.ts`. Full prompt and completion traces are sent for those agent turns.
- Image generation, video generation, and Remotion still use lightweight custom workflow events only in v1. They are not wired into PostHog LLM analytics or model-cost reporting yet.
- The existing workflow events remain available for coarse product telemetry such as config saves, milestone resets, generation success/failure, and render starts.

## Commit Workflow

- `.current-commit-message` is a local scratch file that the coding agent updates after successful validation with a terse commit subject suffix.
- `git commit -m fix` and similar short type-only subjects are expanded by the hook into `fix: <agent summary>`.
- Longer manual subjects such as `git commit -m "refactor auth flow"` are left untouched.
- If the commit starts with an empty subject, the hook falls back to `wip: <agent summary>` or `wip: update project files` when no scratch message is available.
- On normal commit attempts, the hook consumes and clears `.current-commit-message` so stale suggestions do not linger.
