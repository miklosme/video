# Recursive Workspace Data Model — PRD (v2)

## Overview

The current repository uses a flat, stage-based workspace model with a small set of canonical files and sidecars. That model works for a linear workflow, but it does not scale cleanly to recursive workspaces, artifact-local iteration, inherited scope, and user-supplied references.

The recursive workspace convention introduces a path-based structure where work can happen in nested local contexts. That structure requires a matching data-model architecture:

- persisted state must live close to the artifacts it describes
- artifact identity and visibility must respect workspace ancestry
- the harness must assemble a working model from the visible filesystem rather than rely on one global state blob

This PRD defines that v2 data-model architecture. It builds directly on [DOCS/RECURSIVE_WORKSPACE_CONVENTION_PRD.md](/Users/miklosme/github/video/DOCS/RECURSIVE_WORKSPACE_CONVENTION_PRD.md).

This document is forward-looking. It does **not** change the current runtime implementation or the current flat `workspace/` source-of-truth files.

## Design Center

The intended design center is:

- persisted state is distributed across colocated JSON files in the visible workspace tree
- TypeScript and Zod definitions centralize schema logic in code
- the harness derives an in-memory runtime view by scanning the current workspace and its ancestors

This avoids a separate global graph database while still keeping the model strongly typed and machine-readable.

## Core Model Principles

### Filesystem Route Defines Identity and Scope

Artifact identity is route-based.

- the folder path determines where an artifact lives
- the filename determines its role within that routed workspace
- the extension determines its medium

The filesystem is not just storage. It is part of the model.

### Persistence Is Distributed

Persisted model state lives in colocated JSON files rather than in one central monolithic file.

Examples:

- `WORKSPACE.json`
- `plan.json`
- `start.json`
- `video.json`
- `artifact.json`
- `CHAT.json`
- `REFERENCES/*.json`
- `HISTORY/v2.json`

This keeps machine-readable state close to the relevant artifact or local workspace.

### Runtime View Is Derived

The runtime graph or assembled artifact view is derived in memory.

The harness should:

- resolve the active workspace from the nearest `WORKSPACE.json`
- collect visible files from the current workspace plus ancestors
- read colocated JSON contracts
- derive the in-memory working model from those visible files

The persisted model is distributed; the operational view is assembled at runtime.

### Visibility Follows Workspace Ancestry

Visibility is inherited from the recursive workspace convention:

- current workspace is visible
- ancestor workspaces are visible
- siblings and sibling descendants are not visible

This applies to both artifacts and machine-readable JSON that describes them.

### Root-Level Status Remains Flat

`STATUS.json` stays single-root in this version.

The recursive data model must assume:

- one project-level `STATUS.json`
- no nested `STATUS.json` composition yet

## Persisted File and Interface Contracts

This section defines the intended role of the core persisted files. It does not lock exact JSON schemas.

### `WORKSPACE.json`

`WORKSPACE.json` marks a workspace root and provides workspace-local machine-readable metadata needed for routing and discovery.

It is a workspace contract, not the whole project state.

### JSON-Native Artifacts

Some artifacts are naturally JSON-native and are themselves first-class persisted data nodes.

Examples:

- `plan.json`
- future workspace-local structured manifests

These files do not require a second metadata suffix by default. The JSON file is the artifact.

### Non-JSON Artifacts With Same-Basename Sidecars

Non-JSON artifacts use same-basename JSON sidecars when machine-readable state or regeneration inputs are needed.

Examples:

- `start.png` with `start.json`
- `end.png` with `end.json`
- `video.mp4` with `video.json`
- `sheet.png` with `sheet.json`

This is the standard persisted pair for non-JSON artifacts.

### `artifact.json`

`artifact.json` is the logical-artifact control file.

It exists when an artifact has logical identity beyond one concrete file generation, especially when the model must distinguish:

- the logical artifact
- the latest version
- the selected version

In this architecture, `artifact.json` is where logical-artifact control state lives, including selected-vs-latest semantics.

### `CHAT.json`

`CHAT.json` stores local conversational memory for a routed workspace or artifact-local area.

Examples:

- `SHOTS/SHOT-01/CHAT.json`
- `SEQUENCES/THERAPY/CHAT.json`
- `CHARACTERS/panda/HISTORY/CHAT.json`

This local chat memory is part of the working model. It keeps artifact-local iteration and rationale near the artifact rather than in one global thread.

### `HISTORY/` and `vN.*`

`HISTORY/` stores retained generated revisions for versioned image and video artifacts.

Version files use simple sequential names such as:

- `v1.png`
- `v1.json`
- `v2.mp4`
- `v2.json`

The versioned files in `HISTORY/` represent concrete retained generations. They are distinct from the stable public artifact path used by downstream consumers.

### `REFERENCES/`

`REFERENCES/` stores user-supplied reference assets.

It may exist at any workspace root. Reference sidecars are optional, but the reference asset itself is still a valid first-class input even without a sidecar.

Examples:

- `REFERENCES/panda-face.png`
- `REFERENCES/panda-face.json`
- `SEQUENCES/THERAPY/REFERENCES/couch-layout.png`

### Standard `references` Field

All sidecars in this model should include a standard `references` field.

That field is the consistent attachment point for:

- user-supplied reference assets
- inherited references from ancestor workspaces
- artifact-local references
- other explicit inputs that should be passed into downstream generation

This PRD does not define the exact entry shape for `references`, but it locks the requirement that it exists across sidecars as a standard part of the model.

## Versioning Model

### Supported Versioned Media

This PRD specifies versioning for:

- image artifacts
- video artifacts

It does **not** define version-history semantics for:

- text artifacts
- JSON-native artifacts

### Logical Artifact vs Latest vs Selected

The model must distinguish three concepts:

- logical artifact
- latest generated version
- selected version used by downstream consumers

The newest generation is not assumed to be the selected one.

### Placement Rules

Version placement aligns with the recursive workspace convention:

- the stable selected artifact lives at the public path
- older or alternate retained versions live under `HISTORY/`
- logical-artifact control state lives in `artifact.json`

Example pattern:

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

In this example:

- `sheet.png` is the stable selected artifact
- `HISTORY/vN.*` are retained revisions
- `artifact.json` governs the logical artifact

This PRD does not define how version selection is implemented internally. It defines the conceptual model and file responsibilities.

## Template Modules

The template system is part of the data-model architecture in v2.

Templates should move from static scaffold files toward TypeScript artifact-definition modules.

### Role of Template Modules

Template modules are the source of truth for how a given artifact type is created.

They exist to reduce harness-specific branching and to keep artifact-creation knowledge close to the artifact type rather than embedding it in generic orchestration logic.

### Conceptual Module Contract

At a conceptual level, a template module should provide:

- an LLM-facing input schema
- an output schema for the written artifact data
- a `materialize` transformation step that turns structured intermediate data into artifact-ready output
- artifact-specific instructions for how the model should create that artifact

This supports a two-step flow:

- the model produces structured intermediate data at the right level of abstraction
- programmatic logic materializes that into the final artifact JSON or artifact-sidecar data

This PRD does not define the exact TypeScript API surface. It locks the conceptual responsibilities only.

## Runtime Assembly Model

The harness should assemble the working model from the visible filesystem rather than from a separate persisted graph store.

### Assembly Steps

The intended runtime flow is:

1. resolve the active workspace from the nearest `WORKSPACE.json`
2. collect visible files from the current workspace plus ancestors
3. read colocated JSON contracts from those visible files
4. assemble the in-memory artifact view or graph from the gathered data

### Centralized Schema Logic

Although persisted state is distributed, schema logic should be centralized in code.

TypeScript and Zod should define:

- how persisted files are parsed
- how template-module contracts are represented
- how the harness validates and materializes artifact data

This keeps the persisted model distributed without making the overall system untyped or ad hoc.

### Derived Graph, Not Persisted Graph

The harness may build a graph-like runtime view, but that graph is derived from the visible filesystem and colocated JSON files.

This PRD does **not** require a separate always-persisted graph file.

## Relationship To Existing Flat Model

The current repository still uses the flat `workspace/` structure and its existing schemas.

This PRD does not redefine those current source-of-truth files. It defines the intended architecture for the recursive workspace system introduced in the companion PRD.

The old flat model and the v2 recursive model should be treated as separate architectural layers until implementation exists.

## Out of Scope

The following are intentionally out of scope for this PRD:

- exact JSON schema definitions
- exact TypeScript interface signatures
- state-machine details
- dependency invalidation or stale propagation
- review-needed semantics
- validation implementation details
- migration strategy from the old flat model
- reference ranking or selection heuristics
- model-selection heuristics
- versioning for text artifacts
- versioning for JSON-native artifacts

## Adoption Notes

When implementation begins, the recursive data model should be introduced as a new architecture layer that matches the recursive workspace convention rather than as a silent rewrite of the current flat system.

Until that implementation exists:

- the current flat `workspace/` model remains the truth for the running repository
- this PRD serves as the design reference for the recursive data-model architecture
