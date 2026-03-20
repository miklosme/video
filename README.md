# Video Agent

This repo is a mixed-format workspace for developing AI-generated films with a simplified creative workflow.

## Guides

- `CREATIVE_AGENTS.md`: creative chatbot workflow and behavior
- `AGENTS.md`: coding-agent instructions

## Canonical Workflow

- `workspace/IDEA.md`
- `workspace/STATUS.json`
- `workspace/STORY.md`
- `workspace/CHARACTERS.md`
- `workspace/CHARACTER-SHEETS/`
- `workspace/STORYBOARD.md`
- `workspace/STORYBOARD-SHOTS/`
- `workspace/KEYFRAMES.json`
- `workspace/KEYFRAME-PROMPTS.json`
- `workspace/VIDEO-PROMPTS.json`

## Working Rules

- Start from `workspace/IDEA.md`.
- When a canonical workspace file is missing, copy the matching template first.
- `workspace/STATUS.json` is a flat array of visible creative milestones, ordered from first step to last step.
- Keep harness setup and other bookkeeping out of `workspace/STATUS.json`.
- `workspace/STORYBOARD.md` is the single canonical storyboard file and should use stable shot IDs such as `SHOT-01`.
- Use `TBD` for unresolved creative information and `TODO` for coding work.

## Tooling Notes

- `bun validate-workflow-data.ts` validates required workflow files and the simplified JSON schemas.
- `./generate-keyframes.sh` reads prompts from `workspace/KEYFRAME-PROMPTS.json`.
- `generate-imagen-options.ts` preserves the existing CLI contract, supports `AI_GATEWAY_API_KEY`, and can still append generation records to `workspace/GENERATION-LOG.jsonl` when used directly.
