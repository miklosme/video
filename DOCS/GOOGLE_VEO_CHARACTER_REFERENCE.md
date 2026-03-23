# Character Consistency — Feature Spec (Pre-MVP)

## Overview

Enable consistent character identity across multiple generated video clips using Veo 3.1's reference image system. The goal is a minimal, working pipeline — not a sophisticated selection engine.

## Constraints (Veo 3.1 API)

- Max 3 reference images per `generateVideos` call (`referenceImages` with `referenceType: "asset"`)
- Duration locked to 8 seconds when using references
- `personGeneration: "allow_adult"` only when references are used
- Model: `veo-3.1-generate-preview` only
- The `image` parameter (starting frame) is independent of `referenceImages` — both can be used simultaneously

## Character Creation Flow

### Step 1: Text Description

User provides a natural language description of the character. The agent extracts structured attributes via LLM:

```
Input:  "A weathered Hungarian shepherd in his 60s, deep-set eyes,
         sun-darkened skin, wearing a traditional felt hat and
         a heavy linen shirt"

Output: {
  name: "shepherd",
  description: "...",       // full text, passed into video prompts later
  physicalTraits: string,   // face, build, age, skin, hair
  wardrobe: string,         // clothing, accessories
  distinctiveFeatures: string // scars, tattoos, props, anything unique
}
```

This structured form is used to generate consistent image prompts downstream. The raw description is preserved verbatim for prompt injection into video generation.

### Step 2: Variant Generation

Generate 4 candidate images of the character using Imagen 4 Fast (`imagen-4.0-generate-preview-05-20`). All candidates use the same base prompt — a clean, neutral-pose, waist-up portrait against a simple background.

Prompt template:

```
Portrait photograph, waist-up, neutral expression, soft studio lighting,
plain gray background. {character.description}
```

User picks the best variant. This becomes the **canonical image** — the single source of truth for this character's appearance.

### Step 3: Reference Shot Generation

From the canonical image, generate exactly 2 additional reference shots using Imagen 4 (img2img or prompt variation, depending on what holds identity best):

| Slot                         | Purpose                              | Prompt Modifier                                                                                 |
| ---------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| **R1: Identity (canonical)** | Frontal face, maximum clarity        | The selected variant from Step 2, used as-is                                                    |
| **R2: Three-quarter view**   | Adds dimensional understanding       | `"Three-quarter view portrait, same person, {physicalTraits}, {wardrobe}"`                      |
| **R3: Full body**            | Establishes build, posture, wardrobe | `"Full body photograph, standing, same person, {physicalTraits}, {wardrobe}, plain background"` |

User reviews R2 and R3 for identity consistency against R1. If either drifts, regenerate that slot only.

**Important:** Each reference is a clean, isolated, single-subject image. No grids, no collages, no multi-panel sheets.

### Storage

```
character/
  {characterId}/
    meta.json           // structured attributes from Step 1
    canonical.png        // the picked variant
    ref-identity.png     // R1 (copy of canonical)
    ref-three-quarter.png // R2
    ref-full-body.png    // R3
```

## Video Generation with Character References

When generating a video clip featuring a stored character:

```typescript
const operation = await client.models.generateVideos({
  model: 'veo-3.1-generate-preview',
  prompt: buildScenePrompt(scene, character), // includes character description inline
  image: startingFrame, // optional, from Nano Banana / Imagen
  config: {
    referenceImages: [
      { image: character.refs.identity, referenceType: 'asset' },
      { image: character.refs.threeQuarter, referenceType: 'asset' },
      { image: character.refs.fullBody, referenceType: 'asset' },
    ],
    durationSeconds: 8,
    aspectRatio: scene.aspectRatio,
  },
})
```

### Prompt Construction

The scene prompt must explicitly describe the character's appearance. Veo matches reference images to textual descriptions — if the prompt doesn't mention the character's wardrobe, the references for wardrobe are underutilized.

```typescript
function buildScenePrompt(scene: Scene, character: Character): string {
  // Cinematic language first (camera, composition, movement)
  // Then character description woven into the action
  // Then setting, mood, audio

  return [
    scene.cinematography, // "Medium tracking shot, 35mm, eye-level"
    scene.characterAction, // "A weathered shepherd in his 60s with deep-set eyes and sun-darkened skin, wearing a felt hat and linen shirt, walks slowly across..."
    scene.settingAndMood, // "...the cracked alkali flats under a pale sky, desolate, still"
    scene.audio, // "Ambient: wind across dry earth, distant bird call"
  ].join(' ')
}
```

The `scene.characterAction` block should always include key physical traits and wardrobe from `character.meta` — this is the textual anchor that Veo correlates with the reference images.

## Multi-Character Scenes

Not supported in pre-MVP. Veo's 3 reference slots are fully consumed by a single character. Two characters in one shot would require splitting the slots (e.g., 2 refs for character A, 1 for character B), which will degrade consistency for both.

**Workaround for now:** Cut between single-character shots. Classic shot/reverse-shot editing.

## What's Explicitly Out of Scope

- Expression-specific reference selection (test whether it's needed post-MVP)
- Dynamic reference slot allocation based on shot content
- Character aging or wardrobe changes across scenes
- Multi-character identity in a single generation
- Automated identity consistency scoring between clips

## Open Questions for Testing

1. Does the three-quarter reference actually improve consistency vs. just using 3 slightly different frontals?
2. How much does the starting frame (`image` param) help lock identity compared to references alone?
3. At what point does cross-scene drift become noticeable — after 5 clips? 10? 20?
4. Does Imagen 4 img2img produce better angle variants than text-prompted regeneration for maintaining identity?

Test these during the first week of implementation. Answers determine whether the reference generation step needs iteration.
