# Video Agent

This repo is a mixed-format workspace for developing AI-generated films.

## Guides

- `CREATIVE_AGENTS.md`: creative chatbot workflow and behavior
- `AGENTS.md`: coding-agent instructions

## Repo Layout

- `workspace/`: source-of-truth project files
- `templates/`: scaffold files for creating missing `workspace/` files
- subject folders such as `MARA/` or `ROOFTOP/`: raw reference assets
- folders such as `keyframes/<SHOT_ID>/`: generated stills

## Working Rules

- Start from `workspace/IDEA.md`.
- When a `workspace/` file is missing, copy the matching template first.
- Treat `workspace/` JSON and Markdown source-of-truth files as canonical.
- Treat `workspace/PROJECT.md` and `workspace/STORYBOARD.md` as summaries only.
- Use `TBD` for unresolved creative information and `TODO` for coding work.

## Tooling Notes

- `bun validate-workflow-data.ts` validates structured workflow files in `workspace/`.
- `./generate-keyframes.sh` reads prompts from `workspace/KEYFRAMES.json`.
- `generate-imagen-options.ts` preserves the existing CLI contract, supports `AI_GATEWAY_API_KEY`, and appends records to `workspace/GENERATION-LOG.jsonl`.
