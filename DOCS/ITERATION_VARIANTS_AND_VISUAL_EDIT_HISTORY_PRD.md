# Iteration, Variants, and Visual Edit History — PRD (v2)

## Overview

The current v1 workflow around images and videos is too indirect for iterative visual work.

Today, a user typically needs to:

- ask the agent to write or rewrite a sidecar
- inspect or edit that sidecar in an editor or through chat
- run a generation script
- only then see whether the prompt change was correct

That flow breaks the natural order of visual iteration. In practice, users want to:

- look at the artifact first
- describe only the change they want
- reuse the current artifact as a reference input
- regenerate quickly
- move backward or forward through prior versions if needed

This PRD defines the v2 product model for focused artifact iteration in the forthcoming Next.js app.

It covers:

- focused artifact editing for images and videos
- chat-driven incremental edits
- linear version history
- selected versus latest version behavior
- artifact-local history persistence on the filesystem
- simple undo and redo semantics across versions
- high-level web app implications for replacing the current review server

This document is intentionally simple. It does **not** attempt to define advanced review systems, branching version trees, or automated visual analysis in detail.

## Goal

Define the v2 workflow for iteratively editing visual artifacts so a user can review an artifact, request a targeted change in chat, approve the edit, generate a new version using the current artifact as reference, and navigate a simple linear history of prior versions stored on the filesystem.

## Goals

- Make visual iteration happen in the same place where the artifact is reviewed
- Let users edit an artifact by describing only the intended change rather than re-describing the whole artifact
- Pass the current artifact version back into generation as the reference input for incremental edits
- Support a simple linear version stack for images and videos
- Preserve artifact-local edit history on disk so the session can resume after restart
- Replace the v1 review-server experience with a proper Next.js application in v2
- Keep the persistence model local-first and filesystem-based

## Non-Goals

- Defining a branching version tree
- Defining region comments, annotations, or image hotspots
- Defining before/after diff tooling or compare views
- Defining automated review, consistency scoring, or approval gates
- Replacing external generation scripts with an in-app renderer
- Defining partial video edits, clip-range edits, or timeline-local regeneration
- Introducing this workflow into the current v1 flat implementation
- Defining exact JSON schemas or exact TypeScript APIs

## Product Principles

### Review Before Rewrite

Users should see the current artifact before deciding what to change.

The product should optimize for:

- observing the current artifact
- describing the delta
- regenerating quickly

### Edit The Delta, Not The Whole

Incremental prompting is the core interaction.

The prompt for an edit should describe what must change in the current artifact rather than restating the entire artifact from scratch.

### Keep The History Model Simple

For this feature, variants and edit-history steps are the same concept.

The model should be:

- linear
- easy to inspect on disk
- easy to resume after app restart

### Latest By Default, Manual Promotion Allowed

The newest successful generation should become the selected version by default.

The user must still be able to manually reselect an older version from history.

## Scope

### In Scope

- image artifact iteration
- video artifact iteration using the same mental model
- focused artifact edit mode in the Next.js app
- artifact-local version navigation
- approval before generation
- filesystem-backed edit and version history
- hot-refresh behavior when files change on disk

### Out Of Scope For MVP

- branching
- compare mode
- visual diffs
- inline comments on the image or video
- automated review
- agent-side prompt rewriting
- non-chat editing affordances

## Primary User Workflow

### Entry Points

The user can enter focused artifact edit mode from:

- an artifact preview shown by the agent in the Next.js app
- browsing an existing artifact in the artifact browser

### Focused Edit Mode

Focused edit mode should present:

- the current artifact on one side
- the artifact-local chat or edit history on the other side
- a compact version-history control for switching between retained versions

This view should feel like editing one artifact in place rather than browsing a gallery.

### Core Loop

The intended loop is:

1. the user opens an artifact
2. the latest version is shown by default
3. the user describes the change they want in chat
4. the agent prepares the proposed edit request without rewriting the user's wording into a different prompting style
5. the user approves the request
6. the external generation script runs, using the currently active artifact version as reference input
7. a new output is written to the filesystem
8. the newest successful generation becomes the latest and selected version automatically
9. the view refreshes in near real time

## Editing Semantics

### Base Version

The default base for an edit is the latest version of the artifact.

If the user manually activates an older version in the history UI and then requests an edit, that historical version becomes the working base for the next regeneration. The system still remains linear: the newly generated result is added to the top of the history stack rather than creating a branch.

### Prompt Handling

For this version of the product:

- edits are always mediated through the agent
- the user must approve before generation runs
- the system stores what the user actually typed
- the system does **not** require agent-side prompt rewriting

The product may later introduce prompt normalization or model-specific prompt expansion, but this PRD intentionally does not require that.

### Media Reference Handling

Incremental edits require the current artifact to be passed back into generation as a reference.

For images:

- the active image version is passed as the reference input

For videos:

- the whole active video artifact is passed as the reference input

This keeps the image and video mental model aligned even if the underlying generation backends differ.

## Versioning Model

### Logical Artifact

This PRD builds on the v2 data-model distinction between:

- the logical artifact
- the latest generated version
- the selected version used by downstream consumers

The latest version is usually the selected version, but the user may manually promote an older retained version back to selected.

### Linear History Only

History is a single linear stack.

This PRD does **not** support:

- alternate branches
- parallel variant trees
- merge semantics

When a user edits from an older historical version, the next successful output is simply appended as the newest version in the single stack.

### Undo And Redo

Undo and redo are version-selection actions, not semantic reversal of edit operations.

In practice this means:

- moving to an older version behaves like undo
- moving forward to a newer retained version behaves like redo
- manually promoting a prior version is allowed

This feature does not require replaying edit operations as commands.

### Selection Rule

By default:

- the latest successful generation is automatically selected

The user may override selection by choosing an older retained version from history.

## History Responsibilities

### Root Agent History

The main agent conversation should continue to be stored in the root history file for the workspace or app session.

That root history is responsible for preserving the broader conversation and allowing the agent to resume where it left off.

### Artifact-Local History

Artifact-specific edit and version history should be stored next to the artifact in its `HISTORY/` area.

Artifact-local history is responsible for:

- user edit instructions for that artifact
- approval state for those edits
- version-to-version lineage in the linear stack
- metadata needed to reopen the focused artifact editor

### Persistence Simplicity

The persistence model should stay minimal:

- store the user input that led to an artifact edit
- store the generated output as files on disk
- store enough metadata to reconstruct version navigation and resumption

This PRD does not require rich storage for speculative intermediate states.

It is acceptable for failed or abandoned attempts to remain outside durable artifact-local history if the broader root chat history already captures that interaction.

## Filesystem Model

### Placement

This PRD assumes the v2 convention where:

- the stable selected artifact lives at the public path
- retained versions live under `HISTORY/`
- logical artifact control state lives in `artifact.json`

Example:

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

The example above is conceptual. This PRD locks the responsibilities, not the exact schema.

### Minimal Responsibilities Of `artifact.json`

At a conceptual level, `artifact.json` should be able to express:

- what the logical artifact is
- which retained version is the latest
- which retained version is currently selected
- what the stable public artifact path represents

### Minimal Responsibilities Of `HISTORY/`

At a conceptual level, `HISTORY/` should contain:

- retained media versions
- artifact-local chat or edit history
- per-version metadata needed to reconstruct the edit sequence

This PRD does not require one specific storage style beyond that. Implementation may choose either:

- one event log plus version files
- one sidecar per retained version
- or a hybrid of both

As long as the result remains grep-friendly, local-first, and easy to inspect manually.

## UX Shape In The Next.js App

### Layout

The focused artifact editor should use a simple two-panel layout:

- artifact viewer
- chat and approval panel

A small version-history control should remain visible so the user can move across retained versions without leaving the focused view.

### Approval Flow

Before generation starts, the user should explicitly approve the pending edit request.

For v2 MVP, approval only needs to confirm the proposed edit action at a high level. This PRD does not require a highly detailed approval inspector for every model parameter.

### Real-Time Filesystem Reactivity

Because the filesystem remains the persistence layer, the app should feel live with respect to file changes.

At a high level, the Next.js implementation should refresh artifact state when relevant files are:

- created
- modified
- deleted
- promoted to selected

This is especially important because generation scripts remain external to the app.

### Session Resumption

If the app or agent restarts, reopening a focused artifact should restore the artifact-local history view from disk and allow the agent to continue from the root conversation history plus artifact-local state.

## Relationship To Generation Scripts

Generation remains outside the web app in this version.

The app should act as:

- the review surface
- the edit request surface
- the approval surface
- the history surface

The generation script remains:

- an external executable
- idempotent by default
- responsible for writing new outputs to disk

This keeps the v2 web experience richer without forcing a complete rewrite of the underlying generation harness.

## Images And Videos

### Shared Mental Model

Image and video editing should feel the same from the user perspective:

- open the artifact
- inspect it
- request a change in chat
- approve
- regenerate
- navigate history

### Video Constraints

For simplicity, a video edit means generation of a new whole-video artifact.

This PRD does **not** define:

- timeline-local edits
- frame-range edits
- segment-specific references

Those can be introduced later without changing the core mental model.

## Relationship To The Current Review Server

The current [`artifact-review-server.ts`](/artifact-review-server.ts) is a simple v1 bridge to review artifacts in a browser.

This PRD assumes that in v2:

- the focused artifact workflow moves into the Next.js app
- the review server is no longer the long-term UI for this capability

The review server remains useful historical context, but it is not the target architecture for this feature.

## Future Extensions

The model defined here should leave room for later additions such as:

- automated visual review
- consistency checks
- compare mode
- region comments
- richer approval inspection
- branching variant trees
- event-based visual analysis over the retained history

These are intentionally deferred so the core iteration loop can remain simple and strong.

## Open Implementation Questions

The following questions are intentionally left for implementation design rather than product scope:

- the exact JSON schema for `artifact.json`
- the exact JSON schema for artifact-local history entries
- whether artifact-local history is stored as a single log, per-version sidecars, or both
- how the Next.js app watches and rehydrates filesystem changes
- the exact command boundary between the app and external generation scripts

## Adoption Notes

This PRD is for v2 only.

It does **not** change the current v1 implementation directly.

The current flat `workspace/` model and the current review tooling remain the live system until the v2 architecture is introduced.

When v2 implementation begins, this feature should be designed around the recursive workspace and distributed artifact model rather than retrofitted as a thin extension of the current v1 review flow.
