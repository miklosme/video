# Recursive Workspace Convention — PRD (vNext)

## Overview

The current repository uses a flat, stage-oriented `workspace/` layout. That structure is workable for a linear pipeline, but it is a poor fit for the way creative work actually unfolds:

- work moves forward and backward across stages
- users often want to focus on one artifact and iteratively refine it
- complex projects need smaller local workspaces without losing access to shared canon

This PRD defines a forward-looking recursive filesystem convention for a future version of the project. It is intentionally path-driven and Next.js-like in spirit: meaning comes from location, filename, and extension rather than from extra naming tricks.

This document does **not** change the current repo layout or runtime behavior. The existing flat `workspace/` model remains the truth for the current implementation. This PRD describes the intended recursive convention for vNext only.

## Goals

- Introduce path-based routing for creative project files
- Allow recursive composition of workspaces
- Scope visibility by ancestry so child workspaces can see parent canon but not siblings
- Keep artifact-local working context near the artifact itself
- Make user-supplied references first-class filesystem citizens
- Use simple, grep-friendly filenames and folders

## Non-Goals

- Defining the internal data model or state machine
- Defining staleness propagation or dependency invalidation logic
- Defining generation harness behavior or model-selection logic
- Defining validation rules, migrations, or compatibility layers
- Making `STATUS.json` recursive in this version

## Core Conventions

### Workspace Root

`WORKSPACE.json` marks a workspace root.

The nearest `WORKSPACE.json` to a file or current working directory defines the active workspace root for that context.

### Visibility Rules

Visibility is ancestry-based:

- a workspace can see files in itself
- a workspace can see files in its ancestor workspaces
- a workspace cannot see sibling workspaces
- a workspace cannot see sibling descendants

This gives child workspaces access to shared upstream canon while naturally isolating parallel branches.

### Root-Level Status

`STATUS.json` remains single-root in this version.

- there is one project-level `STATUS.json`
- nested workspaces do not define their own `STATUS.json` yet
- recursive status composition is explicitly deferred

## Filesystem Routing Rules

Meaning comes from three things together:

- route and folder placement
- filename
- file extension

The primary artifact media types are:

- `md` for text artifacts
- `json` for data artifacts
- `png` for image artifacts
- `mp4` for video artifacts

### Sidecars

Non-JSON artifacts may have adjacent JSON sidecars with the same basename when machine-readable regeneration or artifact-local state is needed.

Examples:

- `start.png` with `start.json`
- `video.mp4` with `video.json`
- `sheet.png` with `sheet.json`

JSON artifacts remain normal first-class artifacts and do not require a second metadata suffix by default.

### Naming Principle

This convention explicitly avoids suffix-heavy systems such as:

- `*.meta.json`
- `*.history`
- `*.png.json`

Instead, the route and normal filenames carry meaning. Routed folders are preferred over invented suffix families.

## Canonical Path Patterns

The following examples illustrate the intended path shapes, not a complete required inventory for every workspace.

### Root Canon

Project-wide canon and shared assets live near the root workspace:

```text
WORKSPACE.json
STATUS.json
IDEA.md
STYLE.md
CHARACTERS/
REFERENCES/
SEQUENCES/
```

### Sequential Workspaces

Sequential composition is represented by nested routed workspaces such as:

```text
SEQUENCES/THERAPY/
SEQUENCES/OPENING/
SEQUENCES/ENDING/
```

Each sequence may define only the files it needs locally and inherit the rest from ancestors.

### Nested Workspaces

Nested workspaces are used for inserts, alt takes, or other focused local branches:

```text
SEQUENCES/THERAPY/INSERTS/PANDA-EYE-CLOSEUP/
SEQUENCES/THERAPY/ALT-TAKES/DRIER-COMEDY/
```

These workspaces can see the containing sequence and the root project, but not sibling branches.

### Shot-Local Artifacts

A routed shot workspace uses normal filenames for stable artifact roles:

```text
SHOTS/SHOT-01/
  plan.json
  start.png
  start.json
  end.png
  end.json
  video.mp4
  video.json
  CHAT.json
```

## Full Example Tree

```text
project/
├─ WORKSPACE.json
├─ STATUS.json
├─ IDEA.md
├─ STYLE.md
├─ CHARACTERS/
│  ├─ panda/
│  │  ├─ definition.md
│  │  ├─ artifact.json
│  │  ├─ sheet.png
│  │  └─ HISTORY/
│  │     ├─ CHAT.json
│  │     ├─ v1.png
│  │     ├─ v1.json
│  │     ├─ v2.png
│  │     ├─ v2.json
│  │     ├─ v3.png
│  │     └─ v3.json
│  └─ psychologist/
│     ├─ definition.md
│     ├─ artifact.json
│     ├─ sheet.png
│     └─ HISTORY/
├─ REFERENCES/
│  ├─ therapy-room.jpg
│  └─ therapy-room.json
└─ SEQUENCES/
   ├─ OPENING/
   │  ├─ WORKSPACE.json
   │  ├─ STORY.md
   │  ├─ STORYBOARD.md
   │  └─ SHOTS/
   │     └─ SHOT-01/
   │        ├─ plan.json
   │        ├─ start.png
   │        ├─ start.json
   │        ├─ video.mp4
   │        ├─ video.json
   │        └─ CHAT.json
   ├─ THERAPY/
   │  ├─ WORKSPACE.json
   │  ├─ STORY.md
   │  ├─ STORYBOARD.md
   │  ├─ REFERENCES/
   │  │  └─ couch-layout.png
   │  ├─ SHOTS/
   │  │  ├─ SHOT-01/
   │  │  │  ├─ plan.json
   │  │  │  ├─ start.png
   │  │  │  ├─ start.json
   │  │  │  ├─ end.png
   │  │  │  ├─ end.json
   │  │  │  ├─ video.mp4
   │  │  │  ├─ video.json
   │  │  │  └─ CHAT.json
   │  │  └─ SHOT-02/
   │  │     ├─ plan.json
   │  │     ├─ start.png
   │  │     ├─ start.json
   │  │     ├─ video.mp4
   │  │     ├─ video.json
   │  │     └─ CHAT.json
   │  ├─ INSERTS/
   │  │  └─ PANDA-EYE-CLOSEUP/
   │  │     ├─ WORKSPACE.json
   │  │     ├─ STORYBOARD.md
   │  │     └─ SHOTS/
   │  │        └─ SHOT-01/
   │  │           ├─ plan.json
   │  │           ├─ start.png
   │  │           ├─ start.json
   │  │           └─ CHAT.json
   │  └─ ALT-TAKES/
   │     └─ DRIER-COMEDY/
   │        ├─ WORKSPACE.json
   │        ├─ STORY.md
   │        └─ SHOTS/
   │           └─ SHOT-02/
   │              ├─ plan.json
   │              └─ CHAT.json
   └─ ENDING/
      ├─ WORKSPACE.json
      ├─ STORYBOARD.md
      └─ SHOTS/
         └─ SHOT-01/
            ├─ plan.json
            ├─ video.mp4
            ├─ video.json
            └─ CHAT.json
```

## Focused Visibility Examples

### Example: Sequence Workspace

Inside `SEQUENCES/THERAPY/`, the visible scope includes:

- `SEQUENCES/THERAPY/**`
- root files such as `IDEA.md`
- root shared canon such as `CHARACTERS/**`
- root shared references such as `REFERENCES/**`

It does **not** include:

- `SEQUENCES/OPENING/**`
- `SEQUENCES/ENDING/**`

### Example: Nested Insert Workspace

Inside `SEQUENCES/THERAPY/INSERTS/PANDA-EYE-CLOSEUP/`, the visible scope includes:

- that insert workspace
- `SEQUENCES/THERAPY/**`
- root project canon and references

It does **not** include:

- `SEQUENCES/THERAPY/ALT-TAKES/**`
- `SEQUENCES/OPENING/**`

## Artifact-Local Chat and Versioning

### Local Chat

Artifact-local iterative chat lives in `CHAT.json` within the routed workspace folder.

Examples:

- `SHOTS/SHOT-01/CHAT.json`
- `SEQUENCES/THERAPY/CHAT.json`
- `CHARACTERS/panda/HISTORY/CHAT.json`

This keeps artifact-local working context close to the artifact or local workspace without polluting the main global thread.

### Image Versioning

Image artifacts use a selected-versus-history pattern:

- the stable selected artifact lives at a public path such as `sheet.png`
- generated or previously selected variants are retained under `HISTORY/`
- `artifact.json` at the artifact root acts as the stable control file for that logical artifact

The agreed character-image pattern is:

```text
CHARACTERS/panda/
  definition.md
  artifact.json
  sheet.png
  HISTORY/
    CHAT.json
    v1.png
    v1.json
    v2.png
    v2.json
    v3.png
    v3.json
```

In this pattern:

- `sheet.png` is the stable selected artifact used by downstream consumers by default
- `HISTORY/` retains prior generations
- version files use simple sequential names such as `v1.png`, `v2.png`, `v3.png`

This PRD does not define how version selection is stored internally or how downstream consumers pin exact versions. It defines placement and naming only.

## User-Supplied References

`REFERENCES/` is an optional folder at any workspace root.

Examples:

- root project references in `REFERENCES/`
- sequence-specific references in `SEQUENCES/THERAPY/REFERENCES/`

Rules:

- a workspace can use references from itself
- a workspace can use references from ancestors
- a workspace cannot see references from siblings
- reference image sidecars are optional

Example:

```text
REFERENCES/
  panda-face.png
  panda-face.json
  therapy-room.jpg
  mood-board-01.png
```

If a sidecar exists, it may carry extra machine-readable metadata. If it does not, the reference is still a valid first-class reference asset.

This PRD does not define how reference ranking, selection, or injection into generation calls should work.

## Out of Scope

The following are intentionally out of scope for this PRD:

- internal graph or node data model
- state machine design
- stale or review-needed propagation
- generation harness implementation
- validation rules
- migration from the current flat `workspace/` layout
- recursive `STATUS.json`

## Adoption Notes

When implementation begins, the recursive convention should be introduced as a new architecture layer rather than silently treated as already shipped.

Until that implementation exists:

- the current flat `workspace/` documentation remains correct for the running repo
- this PRD serves as the design reference for the recursive convention
