# Coding Agent Guide

This repository is primarily a creative preproduction and prompt-design workspace.
Do not start coding unless the user explicitly asks for tooling, automation, scripts, or other software changes.

## Placeholder Conventions

- `TODO` is reserved for the coding agent and technical implementation follow-up.
- `TBD` is reserved for the creative agent when required creative information is still unknown.
- When a creative agent copies a file from `templates/` into `workspace/`, any section that cannot yet be filled with real project information should stay `TBD` instead of being guessed.

When a technical task depends on creative context, treat these as the source of truth:

- `CREATIVE_AGENTS.md` for the creative workflow and expectations
- `workspace/` canonical workflow files:
  - `workspace/IDEA.md`
  - `workspace/CONFIG.json`
  - `workspace/STATUS.json`
  - `workspace/STORY.md`
  - `workspace/CHARACTERS.md`
  - `workspace/CHARACTERS/`
  - `workspace/STORYBOARD.md`
  - `workspace/KEYFRAMES.json`
  - `workspace/KEYFRAMES/`
  - `workspace/SHOT-PROMPTS.json`
- `templates/` as the scaffold library that mirrors the canonical workspace file shapes for new project setup

Legacy workflow files may still exist in `workspace/`, but they are not part of the simplified creative agent flow unless the user explicitly asks to work with them.

Do not silently rewrite story canon, storyboard content, prompt content, or structured workflow state in `workspace/` unless the user explicitly asks for those edits.

## Structure Rules

- Keep workspace source-of-truth filename stems uppercase in the form `NAME.ext`.
- Keep template scaffold filenames in the form `templates/NAME.template.ext`.
- Keep canonical generated-artifact folders in uppercase names: `CHARACTERS/` and `KEYFRAMES/`.
- When creating a missing workspace file, copy the matching file from `templates/` first and then replace the scaffold-only content.
- Keep the placeholder convention consistent: `TBD` for unresolved creative content, `TODO` for coding-agent work.
- Keep `templates/` and `workspace/` aligned: if a canonical workspace file's headings or schema changes, update the matching template in the same change.

## Coding-Agent Responsibilities

- Make technical changes without breaking the simplified creative file structure.
- Prefer updating repo files over leaving important technical decisions only in chat.
- If you create tooling or scripts that interact with creative files, preserve the simplified file responsibilities, schemas, and naming conventions.
- If you change a canonical `workspace/` file's expected structure, update the matching template in the same change.
- If a requested technical change conflicts with established creative content, stop and surface the conflict instead of guessing.
- After finishing technical work, run the relevant QA scripts to validate correctness before handing off: `bun run validate:data`, `bun run typecheck`, and `bun run format`.

## Script Notes

Generation scripts that create canonical workspace artifacts must be idempotent by default. If the target artifact already exists, skip it instead of overwriting unless the user explicitly asks for a re-render or a breaking CLI change.

### `generate-imagen-options.ts`

If you modify this script or related tooling:

- preserve the current CLI contract unless the user asks for a change
- preserve support for `AI_GATEWAY_API_KEY`
- preserve the current option names unless a breaking change is explicitly requested
- keep output-path behavior clear and compatible with the repo's image-folder conventions

Do not run image-generation scripts automatically unless the user explicitly asks you to execute them.

## Collaboration

- Be concise, structured, and careful around user-authored creative files.
- When a task is purely creative rather than technical, prefer updating `CREATIVE_AGENTS.md` or the project source-of-truth files only if the user explicitly asks for those edits.
- When touching shared documentation, keep `CREATIVE_AGENTS.md` as the creative-agent guide and keep `AGENTS.md` limited to coding-agent instructions.
- Treat `templates/` instructions, placeholders, and example entries as scaffold-only content that should be replaced or cleared when copied into `workspace/`.
- If creative information is still unknown after copying a template, leave `TBD` in the relevant section rather than inventing content.
