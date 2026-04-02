# Video Agent

This repo is a mixed-format workspace for developing AI-generated films with a simplified creative workflow.

## Guides

- `CREATIVE_AGENTS.md`: creative chatbot workflow and behavior
- `AGENTS.md`: coding-agent instructions
- `MODEL_OPTIONS.json`: fixed model-card options used by the config dialog

## Project Switching

- Local projects live under the gitignored `projects/<project-name>/` folders.
- `workspace/` remains the stable runtime path, but it is now expected to be the active-project mount point.
- Use `bun run switch <project-name>` to activate an existing project.
- Use `bun run switch` without a name to list local projects and choose one interactively when running in a TTY.
- Use `bun run new <project-name>` to create an empty local project folder and activate it immediately.
- On a fresh clone, activate or create a project before running the app or other workspace-aware tooling.

## Canonical Workflow

- `workspace/IDEA.md`
- `workspace/CONFIG.json`
- `workspace/STATUS.json`
- `workspace/STORY.md`
- `workspace/CHARACTERS.md`
- `workspace/CHARACTERS/`
- `workspace/STORYBOARD.md`
- `workspace/STORYBOARD.json`
- `workspace/STORYBOARD.png`
- `workspace/KEYFRAMES/`
- `workspace/SHOTS.json`
- `workspace/SHOTS/`
- `workspace/FINAL-CUT.json`

## Working Rules

- Treat `workspace/` as the active project surface. The actual files may live under `projects/<project-name>/` through the active symlink.
- Start from `workspace/IDEA.md`.
- When a canonical workspace file is missing, copy the matching template first.
- `workspace/CONFIG.json` stores the active agent, image, and video model cards plus the default visual `variantCount` for the current project.
- `workspace/STATUS.json` is a flat array of visible creative milestones, ordered from first step to last step.
- Keep harness setup and other bookkeeping out of `workspace/STATUS.json`.
- `workspace/CHARACTERS.md` stores textual character definitions, and each character section should include a stable `Character ID:`.
- `workspace/CHARACTERS/` stores character-sheet sidecar JSON files plus the generated `.png` sheets beside them.
- `workspace/STORYBOARD.md` is the single canonical storyboard file and should use stable shot IDs such as `SHOT-01`.
- `workspace/STORYBOARD.json` is the storyboard-reference sidecar and is required before generating `workspace/STORYBOARD.png`. Its `references` array is the source of truth for storyboard generation inputs and uses repo-relative `path`, required typed `kind`, and optional `label`/`notes`.
- `workspace/STORYBOARD.png` is the single storyboard review artifact for the whole project, generated from `workspace/STORYBOARD.md` before keyframe review.
- `workspace/KEYFRAMES/` stores one sidecar JSON and one generated `.png` per keyframe, grouped under each `shotId`. Keyframe sidecar `references` are the source of truth for still-image generation inputs and must be authored in the exact intended priority order.
- By default, plan one `start` keyframe per storyboard shot. Add an `end` keyframe only when the closing anchor needs to differ materially from the opening anchor; one-anchor `start` or `end` shots remain valid.
- `workspace/SHOTS.json` is the planning manifest for shots and keyframe anchors and should use the exact shape `{ shotId, status, videoPath, durationSeconds, incomingTransition: { type, notes }, keyframes: [{ keyframeId, frameType, imagePath }] }`.
- `workspace/SHOTS/` stores one sidecar JSON and one generated `.mp4` per shot, sharing the same `shotId` basename. Shot sidecars may include optional `references`.
- `workspace/FINAL-CUT.json` stores the saved Remotion edit manifest for the final assembly step and should use the exact shape `{ version, shots, soundtrack }`.
- `workspace/HISTORY.json` stores the app's persisted chat/session state for the current project.
- Visual artifacts retain linear history under nearby `HISTORY/` folders. The public artifact path is always the current version, and older retained media files are stored as `vN.png` or `vN.mp4`.
- Use `TBD` for unresolved creative information and `TODO` for coding work.

## Tooling Notes

- `bun run switch <project-name>` repoints `workspace/` to the chosen local project under `projects/`.
- `bun run new <project-name>` creates `projects/<project-name>/` and makes it the active `workspace/`.
- `bun validate-workflow-data.ts` validates required workflow files, explicit sidecar `references`, and the simplified JSON schemas.
- `bun generate-character-sheets.ts` syncs missing `workspace/CHARACTERS/*.png` files from their sidecar JSON files, renders `workspace/CONFIG.json.variantCount` variants in sequence when the stable public PNG is missing, stores earlier variants in `HISTORY/`, and keeps the last new variant at the public PNG path.
- `bun generate-storyboard.ts` syncs the missing `workspace/STORYBOARD.png` review board from `workspace/STORYBOARD.md`, uses the explicit typed `references` declared in `workspace/STORYBOARD.json`, renders `workspace/CONFIG.json.variantCount` variants in sequence when the stable public board is missing, stores earlier variants in `HISTORY/`, and keeps the last new variant at the public PNG path.
- `bun generate-keyframes.ts` syncs missing `workspace/KEYFRAMES/**/*.png` files from their sidecar JSON files and the planned anchors in `workspace/SHOTS.json`, uses the explicit typed `references` declared in each keyframe sidecar without silently appending storyboard, character, or continuity refs at runtime, renders `workspace/CONFIG.json.variantCount` variants in sequence when a stable public keyframe is missing, and keeps the last new variant at the public PNG path.
- `bun generate-shots.ts` syncs missing `workspace/SHOTS/*.mp4` files from `workspace/SHOTS.json` and `workspace/SHOTS/*.json`, uses the lone anchor or the start frame as the image-to-video input, the end frame as the last-frame control only when present, renders `workspace/CONFIG.json.variantCount` variants in sequence when a stable public shot is missing, stores earlier variants in `HISTORY/`, and keeps the last new variant at the public MP4 path.
- `bun run remotion:studio` bootstraps `workspace/FINAL-CUT.json` when needed, serves repo media to Remotion Studio, and opens the stock Studio against the saved final-cut manifest.
- `bun run remotion:render` uses the same `workspace/FINAL-CUT.json` manifest to render the `final-cut` composition to `outputs/final.mp4` by default.
- `artifact-review-server.ts` is now the lightweight artifact-control surface for retained history, source reference editing, approval, and manual reselection back to the public artifact path.
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
