# Improved User Control — PRD (v1)

## Overview

This PRD defines a v1-compatible version of two forward-looking v2 feature areas:

- first-class `references`
- iteration, variants, and visual edit history

The v2 PRDs describe these ideas in terms of recursive workspaces, distributed artifact state, and a future Next.js application. Those assumptions do not match the current live system.

For v1, the product reality is:

- the canonical source of truth is still the flat `workspace/` structure
- generation still happens through external scripts
- browser review is currently provided by [`artifact-review-server.ts`](/Users/miklosme/github/video/artifact-review-server.ts)
- `workspace/GENERATION-LOG.jsonl` already captures generation-time metadata, including references

This PRD rewrites the feature set for that reality.

The goal is not to prematurely implement v2. The goal is to give users much better control over visual generation in v1 while choosing conventions that migrate cleanly into the future recursive workspace model.

## Problem

The current v1 flow gives users limited direct control over why an artifact looks the way it does and how it changes over time.

Today:

- references are partly implicit in scripts instead of consistently visible in artifact sidecars
- the review server shows outputs, but not a unified control surface for references, variants, and edit history
- successful generations are logged, but variant selection and lineage are not modeled as first-class artifact state
- iterative edits require too much indirection through chat and file editing

This makes it harder to answer basic user questions such as:

- what references influenced this output?
- which version is currently selected?
- what changed between versions?
- can I go back to an older result without manually copying files?
- can I request a targeted edit from the artifact I am already looking at?

## Goal

Improve user control over generated visual artifacts in v1 by making references explicit, preserving linear artifact history on disk, and extending the existing review server into a lightweight artifact-control surface.

## Goals

- Make references visible and user-editable as a standard part of visual generation inputs
- Preserve the current flat `workspace/` model and avoid blocking on recursive-workspace work
- Support iterative visual editing for storyboard images, character sheets, keyframes, and shot videos
- Introduce simple linear variant history with selected-versus-latest semantics
- Keep all persistence filesystem-based and grep-friendly
- Use [`artifact-review-server.ts`](/Users/miklosme/github/video/artifact-review-server.ts) as the v1 UI surface instead of assuming a Next.js app
- Reuse existing generation scripts and `workspace/GENERATION-LOG.jsonl` rather than replacing the harness
- Choose naming and responsibilities that map cleanly onto the v2 data-model direction later

## Non-Goals

- Implementing recursive workspace visibility in v1
- Replacing the flat canonical `workspace/` source-of-truth files
- Building a Next.js app
- Defining branching variant trees
- Defining region comments, draw-over annotations, or visual diff tooling
- Replacing external generation scripts with in-server rendering
- Automatically rewriting user edit requests into a new prompting dialect
- Defining partial video edits or timeline-local regeneration
- Redesigning the creative workflow files themselves

## Product Principles

### User Control Must Be Visible

If a user can influence an output, that control should be inspectable in the product.

In v1 this means the review experience should expose:

- the current selected artifact
- the latest generated artifact
- the references attached to that artifact
- the retained versions for that artifact
- the edit instruction that produced a retained version when known

### References Are Inputs, Not Hidden Script Behavior

References should become a standard artifact-sidecar concept, not just something individual scripts decide internally.

### Edit The Current Artifact, Not A Blank Prompt

The default iterative workflow should start from the artifact the user is reviewing now, not from a blank rewrite of the entire prompt.

### History Should Stay Simple

For v1, history should be linear, filesystem-based, and easy to inspect manually.

### v1 Must Stay v1

This feature must fit the current system:

- flat workspace
- external scripts
- lightweight Bun server

It should borrow v2 concepts only when they improve v1 immediately and do not force premature architecture changes.

## v1 Rewrite Of The v2 Assumptions

This document intentionally rewrites several v2 assumptions.

### UI Rewrite

Replace:

- Next.js focused artifact editor

With:

- enhanced routes and controls inside [`artifact-review-server.ts`](/Users/miklosme/github/video/artifact-review-server.ts)

### Workspace Rewrite

Replace:

- recursive workspaces with ancestry-based visibility

With:

- the current flat `workspace/` model plus repo-relative reference paths

### Persistence Rewrite

Replace:

- fully distributed routed artifact state as the starting point

With:

- current sidecars
- `workspace/GENERATION-LOG.jsonl`
- lightweight artifact-local history folders that fit the current layout

### Adoption Rewrite

Replace:

- "wait for v2"

With:

- "introduce user-control primitives now, using names and concepts that still map forward into v2"

## Scope

### In Scope

- standard `references` support for v1 visual-generation sidecars
- user-visible reference inspection in the review server
- linear version retention for visual artifacts
- selected-versus-latest artifact state
- simple undo/redo through version reselection
- approval before a new generation starts
- persisted edit history for each retained variant
- lightweight polling or refresh-based reactivity in the review server

### Artifacts Covered

- `workspace/STORYBOARD.png`
- `workspace/CHARACTERS/*.png`
- `workspace/KEYFRAMES/**/*.png`
- `workspace/SHOTS/*.mp4`

## Feature Area 1: References

### Desired User Outcome

A user should be able to see and control the reference stack for a visual artifact without reverse-engineering script behavior.

### v1 Rule

All visual-generation sidecars in v1 should support a standard optional `references` field.

This applies to:

- `workspace/CHARACTERS/*.json`
- `workspace/KEYFRAMES/**/*.json`
- `workspace/SHOTS/*.json`
- a new optional `workspace/STORYBOARD.json` sidecar if storyboard generation needs user-controlled references in the same model

### Reference Placement

v1 should not require a dedicated `REFERENCES/` folder.

Reference files may live anywhere in repo-visible scope, with these norms:

- project-owned references should usually live under `workspace/`
- scaffold or system references may live under `templates/`
- repo-relative paths are the storage format

This keeps the v1 behavior aligned with the spirit of the v2 reference model without pretending that recursive visibility already exists.

### Reference Entry Shape

For v1, the sidecar-level `references` field should use a simple, user-authored shape:

```json
{
  "references": [
    {
      "path": "workspace/REFERENCES/couch-layout.png",
      "label": "Couch layout",
      "role": "composition",
      "notes": "Use for room layout, not character styling."
    }
  ]
}
```

Required:

- `path`

Optional:

- `label`
- `role`
- `notes`

This is intentionally more user-facing than the current internal generation-log `kind` values.

At generation time, scripts may compile these user-authored references into the more operational reference metadata they already log today.

### Reference Resolution Rules

- paths must be repo-relative
- missing paths should fail validation before generation
- reference order should be preserved
- explicit user references should be merged with system-derived references rather than replacing them by default
- generated logs should capture the final resolved reference stack actually sent into generation

### Reference Categories In v1

v1 should distinguish two conceptual categories:

- explicit user references from sidecars
- implicit system references derived by workflow rules

Examples of implicit system references already present in v1 include:

- storyboard template image
- character sheets selected by `characterIds`
- previous-shot continuity frames
- same-shot start or end anchors

The review server should show both categories together in the order actually used, while still labeling which references were user-authored versus system-derived.

## Feature Area 2: Iteration, Variants, and Visual Edit History

### Desired User Outcome

A user should be able to open a visual artifact, request a targeted change, approve the edit, generate a new retained version, and move backward or forward across prior versions without manually copying files.

### Core v1 Model

For v1, this feature should use a simple linear history model:

- one logical artifact
- one selected version exposed at the current public path
- one latest retained version
- zero or more older retained versions

No branching is required.

### Selection Semantics

- the latest successful generation becomes the selected version by default
- the user may manually reselect an older retained version
- selecting an older version behaves like undo
- reselecting a newer retained version behaves like redo
- editing from an older version does not create a branch; the newly generated result is appended as the newest retained version

### v1 Filesystem Model

The current public artifact paths remain unchanged.

Examples:

- `workspace/STORYBOARD.png`
- `workspace/CHARACTERS/panda-patient.png`
- `workspace/KEYFRAMES/SHOT-01/SHOT-01-START.png`
- `workspace/SHOTS/SHOT-01.mp4`

Retained versions should be stored in nearby `HISTORY/` folders that fit the current flat layout.

Example:

```text
workspace/
  STORYBOARD.png
  STORYBOARD.json
  HISTORY/
    STORYBOARD/
      artifact.json
      v1.png
      v1.json
      v2.png
      v2.json
  CHARACTERS/
    panda-patient.png
    panda-patient.json
    HISTORY/
      panda-patient/
        artifact.json
        v1.png
        v1.json
        v2.png
        v2.json
  KEYFRAMES/
    SHOT-01/
      SHOT-01-START.png
      SHOT-01-START.json
      HISTORY/
        SHOT-01-START/
          artifact.json
          v1.png
          v1.json
  SHOTS/
    SHOT-01.mp4
    SHOT-01.json
    HISTORY/
      SHOT-01/
        artifact.json
        v1.mp4
        v1.json
```

This is a v1 bridge shape, not the final v2 routed placement.

It preserves three important v2 concepts now:

- stable public artifact path
- retained version files under `HISTORY/`
- explicit logical-artifact control metadata in `artifact.json`

### `artifact.json` Responsibilities In v1

Each artifact-local `artifact.json` should minimally express:

- `artifactId`
- `artifactType`
- `publicPath`
- `latestVersionId`
- `selectedVersionId`
- `versions`

Each version record should minimally express:

- `versionId`
- `path`
- `metadataPath`
- `createdAt`
- `baseVersionId`
- `generationId`
- `editInstruction`
- `references`

This is sufficient for selection, lineage, and session resumption.

### Per-Version Metadata Responsibilities

Each retained `vN.json` sidecar should capture the version-specific facts needed to inspect the history later.

At minimum:

- creation timestamp
- source artifact id
- base version id
- whether the version was auto-selected on creation
- user edit text when present
- approved action summary
- resolved reference stack
- generation log id when available

### Relationship To `workspace/GENERATION-LOG.jsonl`

`workspace/GENERATION-LOG.jsonl` should remain the append-only operational log.

It is useful for:

- debugging
- telemetry
- prompt inspection
- tracing exact generation runs

It should not be the only source of truth for artifact selection state.

In v1:

- generation log entries remain append-only
- artifact-local `artifact.json` becomes the source of truth for latest versus selected
- per-version metadata links back to generation-log entries when available

## Review Server UX In v1

### Role Of The Server

[`artifact-review-server.ts`](/Users/miklosme/github/video/artifact-review-server.ts) should become the v1 control surface for this feature family.

It should not stay a read-only gallery if we want real user control.

### Required UX Shape

The enhanced review server should provide:

- existing stage-level summary pages
- artifact-focused detail routes
- visible selected-versus-latest state
- visible reference stack
- visible linear history
- an edit request composer
- an approval step before generation
- explicit actions to reselect an older retained version

### Artifact Detail View

Each artifact detail view should show:

- the currently selected artifact
- whether that view is showing `selected` or a non-selected historical version
- retained history in newest-first order
- the references used for the active version
- the edit instruction for the active version when present
- an action to request another edit from the current active version

### Suggested v1 Routes

The exact routes are implementation details, but the v1 UI should move toward artifact-specific pages such as:

- `/storyboard`
- `/characters/:characterId`
- `/keyframes/:keyframeId`
- `/shots/:shotId`

The existing tabbed summary pages can remain as entry points into those views.

### Approval Flow

Before generation starts, the user should explicitly approve the pending edit request.

For v1, approval only needs to confirm:

- which artifact is being edited
- which base version is active
- the edit instruction
- the resolved reference stack

This can be much simpler than a future full inspector UI.

### Reactivity

Because persistence remains filesystem-based, the review server only needs lightweight reactivity in v1.

Acceptable approaches:

- periodic polling
- refresh-after-action
- file-change-triggered refresh if simple to add

Websocket-heavy architecture is not required.

### Session Resumption

If the review server or agent restarts, reopening an artifact should recover:

- the currently selected version
- the retained history
- the references for each retained version
- the last approved edit metadata when it was persisted

## Generation Integration

Generation remains external to the server in v1.

The server should orchestrate the workflow, not replace the scripts.

The intended flow is:

1. user opens an artifact in the review server
2. user reviews the currently active version
3. user writes a targeted edit request
4. the server resolves the base version and reference stack
5. the user approves the action
6. the existing generation script runs for that artifact type
7. the new output is written as a retained version
8. the public artifact path is updated to the newly selected version
9. the review page refreshes and shows the new history state

### Script Responsibilities

Generation scripts should continue to own:

- prompt assembly
- model execution
- writing canonical outputs
- writing generation-log entries

The new control layer should add:

- reference resolution from sidecars
- version retention
- selected-version promotion
- history metadata writing

### Prompt Handling

For v1:

- store the user edit instruction as written
- do not require server-side prompt rewriting
- allow scripts or agent orchestration to combine the edit instruction with current artifact context and existing prompt material

This keeps the feature user-centered and compatible with current script ownership boundaries.

### Validation Requirements

Before a generation starts, v1 should validate:

- referenced files exist
- the artifact sidecar is parseable
- the base version exists
- the target output path is known
- the generation script for that artifact type can be resolved

When validation fails, the review server should surface the failure without mutating selection state.

## Migration Alignment With v2

This v1 PRD is a bridge, not a fork.

It is intentionally aligned to future v2 concepts:

- `references` becomes a standard sidecar field now
- `artifact.json` becomes the logical-artifact control file now
- `HISTORY/` becomes the retained-version container now
- selected-versus-latest semantics become explicit now

What remains different in v1:

- flat workspace instead of recursive routed workspaces
- review-server UI instead of Next.js UI
- simpler visibility rules
- more tolerance for bridge metadata and transitional storage choices

## Implementation Plan

### Phase 1: Reference Foundation

- add `references` support to relevant v1 sidecars
- add validation for repo-relative reference paths
- teach the review server to display the resolved reference stack for current artifacts
- preserve compatibility with existing implicit workflow-derived references

### Phase 2: Artifact History Foundation

- introduce artifact-local `HISTORY/` placement for retained versions
- introduce per-artifact `artifact.json`
- introduce per-version `vN.json`
- connect history metadata to `workspace/GENERATION-LOG.jsonl`

### Phase 3: Review Server Controls

- add artifact detail routes
- show selected versus latest state
- show retained version history
- allow manual version reselection
- add edit request and approval UI

### Phase 4: Script And Promotion Integration

- route approved actions into the existing generation scripts
- ensure new outputs are retained before promotion
- update the public artifact path only after successful generation
- ensure idempotent behavior when artifacts already exist and no new edit was requested

### Phase 5: Polish And Migration Readiness

- refine failure recovery
- improve history labels and reference labeling
- document the mapping from this v1 model to the later recursive v2 model

## Open Questions

- whether storyboard control should use a new `workspace/STORYBOARD.json` sidecar immediately or begin with script-owned defaults plus review-server visibility
- whether the first v1 edit-request implementation should directly invoke scripts from the server or persist a pending action for agent or CLI pickup
- whether version promotion should copy files into the public path or swap via a small helper layer
- how much edit metadata should live in per-version `vN.json` versus a separate artifact-local event log

## Success Criteria

This feature should be considered successful in v1 when:

- a user can inspect the references for a visual artifact without reading generator code
- a user can see which retained version is selected versus merely latest
- a user can reselect an older retained version without manual file copying
- a user can request and approve a targeted edit from the artifact they are reviewing
- the resulting history is durable on disk and survives restart
- the implementation clearly maps forward into the v2 recursive model instead of becoming throwaway UI
