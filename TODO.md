# TODO

Use this checklist to log the project's current state as it moves through the repo workflow. Keep items unchecked until the state is actually confirmed in the source-of-truth files.

## Current State Snapshot

- [ ] Current phase is confirmed in `PROJECT.md` (`concept`, `story`, `storyboard`, `keyframes`, `prompts`, or `revision`).
- [ ] One-sentence concept still matches `IDEA.md`.
- [ ] Active target keyframe model is confirmed in `PROJECT.md`.
- [ ] Active target video model is confirmed in `PROJECT.md` or explicitly marked as not chosen yet.
- [ ] Main creative blockers are identified.
- [ ] Next workflow step is clear.

## Concept Stage

- [ ] `IDEA.md` captures the irreducible concept.
- [ ] `IDEA.md` preserves the assignment brief or core prompt if one exists.
- [ ] `PROJECT.md` records concept, target length, audience, and emotional effect.
- [ ] `PROJECT.md` phase is set to `concept` or advanced beyond it intentionally.

## Canon Stage

- [ ] `STORY.md` contains the logline, synopsis, and core beat structure.
- [ ] `STORY.md` defines the emotional arc and scene goals.
- [ ] `CHARACTERS.md` contains recurring character identity anchors.
- [ ] `CHARACTERS.md` includes appearance, wardrobe, behavior, and prompt-safety rules.
- [ ] `STYLE.md` defines tone, palette, lighting, camera language, and texture cues.
- [ ] `STYLE.md` names any forbidden stylistic drift.
- [ ] Canon across `STORY.md`, `CHARACTERS.md`, and `STYLE.md` is internally consistent.
- [ ] `PROJECT.md` phase is set to `story` or advanced beyond it intentionally.

## Reference And Planning Stage

- [ ] `REFERENCES.md` lists supplied or approved reference assets.
- [ ] `REFERENCES.md` distinguishes canonical references from inspirational ones.
- [ ] `STORYBOARD.md` contains the scene-by-scene plan.
- [ ] `STORYBOARD.md` contains a shot list with framing, motion, and transition intent.
- [ ] `CONTINUITY.md` captures canon checkpoints and continuity dependencies.
- [ ] `CONTINUITY.md` lists open continuity risks.
- [ ] Adjacent shots have been checked for transition logic.
- [ ] `PROJECT.md` phase is set to `storyboard` or advanced beyond it intentionally.

## Keyframe Stage

- [ ] Keyframe phase is explicitly active in `PROJECT.md`.
- [ ] The image model has been chosen in `PROJECT.md`.
- [ ] The relevant image-model guidance has been reviewed in `MODELS.md`.
- [ ] `KEYFRAMES.md` contains still-image prompts for the needed frame targets.
- [ ] `KEYFRAMES.md` includes start or end keyframes where transition control is needed.
- [ ] Approved keyframes are registered in `REFERENCES.md` with file paths and notes.
- [ ] Any canon changes caused by approved keyframes were pushed back into the source-of-truth files first.
- [ ] The project is ready to stay in `keyframes` or move to `prompts`.

## Prompt Pack Stage

- [ ] The video model has been chosen in `PROJECT.md`.
- [ ] The relevant video-model guidance has been reviewed in `MODELS.md`.
- [ ] `PROMPT-PACK.md` exists or is ready to be created for executable video prompts.
- [ ] Each planned shot has a prompt or a clear reason it is pending.
- [ ] Prompt text reflects the active model and linked references.
- [ ] Start and end keyframes are linked where the motion workflow depends on them.
- [ ] Prompt wording is consistent with canon, storyboard, style, and continuity.
- [ ] `PROJECT.md` phase is set to `prompts` or advanced beyond it intentionally.

## Revision Stage

- [ ] `GENERATION-LOG.md` exists or is ready to be created for output reviews.
- [ ] Latest generation results are logged with date, model, prompt version, and outcome.
- [ ] Failures are diagnosed before prompts are rewritten.
- [ ] Revisions are applied to source-of-truth files before prompt thrashing.
- [ ] Open issues are classified as canon, storyboard, style, continuity, or model-phrasing problems.
- [ ] Next revision decision is recorded.
- [ ] `PROJECT.md` phase is set to `revision` when the project is in an active feedback loop.
