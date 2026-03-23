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
- `workspace/SHOT-PROMPTS.json`

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
- Use `TBD` for unresolved creative information and `TODO` for coding work.

## Tooling Notes

- `bun validate-workflow-data.ts` validates required workflow files and the simplified JSON schemas.
- `bun generate-character-sheets.ts` syncs missing `workspace/CHARACTERS/*.png` files from their sidecar JSON files.
- `bun generate-storyboard.ts` syncs the missing `workspace/STORYBOARD.png` review board from the raw contents of `workspace/STORYBOARD.md`.
- `bun generate-keyframes.ts` syncs missing `workspace/KEYFRAMES/**/*.png` files from their sidecar JSON files and `workspace/KEYFRAMES.json`, attaching the storyboard review board for all keyframes, the relevant character sheets, and the same-shot start frame first for end-frame generation.
- `generate-imagen-options.ts` preserves the direct CLI contract, uses the Vercel AI Gateway through the AI SDK, supports `AI_GATEWAY_API_KEY`, and appends generation records to `workspace/GENERATION-LOG.jsonl`.
