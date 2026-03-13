# Coding Agent Guide

This repository is primarily a creative preproduction and prompt-design workspace.
Do not start coding unless the user explicitly asks for tooling, automation, scripts, or other software changes.

When a technical task depends on creative context, treat these as the source of truth:

- `README.md` for the creative workflow and expectations
- root source-of-truth files across formats:
  - Markdown canon and guidance such as `IDEA.md`, `STORY.md`, `CHARACTERS.md`, `STYLE.md`, `CONTINUITY.md`, `MODELS.md`, and `SOUND.md`
  - structured workflow files such as `PROJECT.json`, `STORYBOARD.json`, `REFERENCES.json`, `KEYFRAMES.json`, `PROMPT-PACK.json`, `QC.json`, `EDIT.json`, `TESTS.json`, `TODO.json`, and `GENERATION-LOG.jsonl`
  - summary files `PROJECT.md` and `STORYBOARD.md`, which are non-canonical

Do not silently rewrite story canon, style decisions, prompt content, continuity, or structured workflow state unless the user explicitly asks for those edits.

## Structure Rules

- Keep root source-of-truth filename stems uppercase in the form `NAME.ext`.
- When creating new Markdown files, prefer concise uppercase names such as `STYLE.md` or `SHOTS.md`.
- When creating new structured files, prefer concise uppercase stems such as `QC.json` or `CUT.json`.
- Keep creative canon in the existing root source-of-truth files.
- Keep raw reference assets in subject folders such as `MARA/` or `ROOFTOP/`.
- Preserve the separation between canon docs, structured planning data, keyframe data, prompt packs, and revision logs.

## Coding-Agent Responsibilities

- Make technical changes without breaking the repo's creative file structure.
- Prefer updating repo files over leaving important technical decisions only in chat.
- If you create tooling or scripts that interact with creative files, preserve file responsibilities, schemas, and naming conventions.
- If a requested technical change conflicts with established creative content, stop and surface the conflict instead of guessing.

## Script Notes

### `generate-imagen-options.ts`

If you modify this script or related tooling:

- preserve the current CLI contract unless the user asks for a change
- preserve support for `AI_GATEWAY_API_KEY`
- preserve the current option names unless a breaking change is explicitly requested
- keep output-path behavior clear and compatible with the repo's reference-folder conventions

Do not run image-generation scripts automatically unless the user explicitly asks you to execute them.

## Collaboration

- Be concise, structured, and careful around user-authored creative files.
- When a task is purely creative rather than technical, prefer updating `README.md` or the project source-of-truth files only if the user explicitly asks for those edits.
- When touching shared documentation, keep `README.md` as the creative-agent guide and keep `AGENTS.md` limited to coding-agent instructions.
