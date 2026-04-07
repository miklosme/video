# Model Prompting Guide

## Character Reference Images For Veo

if a still image will later be reused as a Veo character reference, prompt it like a **reference asset**, not like a hero shot.

**what consistently helps:**

- **single subject only.** one character, isolated and readable. no grids, collages, split panels, or extra people/animals.
- **make identity legible.** prefer framing that shows the full body when practical, or at least enough of the body to read face, silhouette, wardrobe, markings, and posture.
- **choose neutral clarity over drama.** plain or seamless background, soft even lighting, sharp detail, and a neutral pose or slight three-quarter view usually outperform moody lighting or extreme angles.
- **include only stable identity anchors.** wardrobe, accessories, props, or background elements should appear only when they are canon and need to persist across shots.
- **avoid “pretty shot” instincts.** cinematic atmosphere, heavy stylization, scene clutter, motion, text, and logos usually make weaker reusable reference assets.

**practical prompt shape:**

```
A clean studio reference photo of [character], single subject,
[full-body or clearly readable framing], [neutral pose or slight
three-quarter view], [plain background], [soft even lighting],
[stable identity details that must persist]
```

## BFL Flux 2 Klein

for `bfl/flux-2-klein-9b`, assume the prompt you write is the prompt the model sees. there is no magical cleanup pass anymore, so storyboard prompts should already be explicit, visual, and model-ready.

**the core approach**

- write **2-4 sentences of natural visual prose**, not keyword piles
- **front-load the subject and action** in the first sentence
- make **framing explicit** inside the prompt itself: medium-wide, close-up, eye-level, slight low angle, etc.
- specify the **environment, lighting, and spatial relationships** instead of leaving them implied
- end with a **`Style:` line** that locks the rough storyboard treatment

**what consistently helps for storyboard prompts**

- describe **what the frame literally shows**, not the abstract intent behind it
- include the **comic or dramatic contrast** only through visible staging, posture, props, and expressions
- keep the prompt **positive and concrete**; don't use negative prompts or tag syntax
- if a reference image is attached, the prompt should still stand on its own and describe the desired end frame clearly

**recommended shape**

```
[Framing] storyboard frame of [main subject and action], [immediate setting and supporting action].
[Visible character details, props, blocking, environment, lighting, and what should read most clearly].
Style: black-and-white rough graphite storyboard sketch, loose previs linework, light grayscale shading, readable silhouettes, unfinished but cinematic.
```

**example**

```
A medium-wide eye-level storyboard frame of an anxious Renaissance merchant freezing in a crowded market as he checks a worn leather satchel and realizes he is disastrously late, while the crowd continues moving around him. Keep his strained face and clutched satchel as the focal point, with fabric stalls, produce, and passing bodies creating readable depth behind him. Style: black-and-white rough graphite storyboard sketch, loose previs linework, light grayscale shading, clear silhouettes, unfinished but cinematic.
```

## Imagen 4 Fast / Ultra

**the core framework**

`Subject + Context/Background + Style + Details`

that's it. imagen 4 thrives on descriptive, layered prompts that guide its understanding of styles, lighting, and composition. think photographer, not director (opposite of veo).

**what actually works:**

**lead with medium declaration.** start prompts with "A photo of..." for photorealistic output, or "A [style] of..." for artistic styles. this is the single strongest steering signal. "A photo of..." triggers photorealism mode. "A painting of...", "A sketch of...", "An illustration of..." each pull from different aesthetic spaces.

**photography language > cinematic language.** unlike veo where you think DP-on-set, imagen 4 wants photographer glass: specify perspective ("close-up"), lighting ("golden hour"), environment, and action. lens specs, aperture language, lighting setups — all work great here. think "35mm prime lens, shallow depth of field, Rembrandt lighting" not "slow dolly-in, tracking shot."

**specificity is everything.** every unspecified dimension defaults to bland. the more concrete details you pack in — materials, textures, color palette, time of day, weather — the better the output. hex codes work too for precise color control.

**the prompt rewriter is on by default.** an LLM-based prompt rewriting tool will always automatically add more detail to the provided prompt. this means your sparse prompts get expanded before generation. you can disable it with `enhance_prompt: false` but google says it may hurt quality. worth testing both ways — for your dark digital romanticism stuff, the rewriter might dilute your specific aesthetic, so try disabling it.

**negative prompts are legacy.** negative prompts are a legacy feature and are not included with imagen models starting with imagen-3.0-generate-002 and newer. so for imagen 4 fast, just describe what you want positively. if you need to exclude stuff, weave it into the prompt naturally: "clean background, no text, no logos."

**fast vs standard vs ultra — for your workflow:**

imagen 4 fast generates images approximately 10 times faster than imagen 3 at ~2.7s per image, $0.02/image. max resolution is 1408×768 across multiple aspect ratios. the tradeoff: imagen 4 handles prompts more literally, while ultra leans toward nuanced understanding with poetic or conceptual language. fast is great for iteration/exploration, but for your atmospheric, mood-heavy aesthetic you might find it a bit literal-minded.

**practical prompt template for your style:**

```
A [medium] of [subject with specific details], [setting/environment],
[lighting conditions], [color palette], [texture/material details],
[composition/framing], [mood/atmosphere], [style reference]
```

example tuned for dark digital romanticism:

```
A digital painting of a lone figure in an obsidian cloak standing before
a vast crystalline megastructure, deep space backdrop with dense nebula
formations in jewel-tone purples and teals, volumetric light piercing
through crystal facets, heavy film grain, rich blacks, dense textural
detail on rock formations, wide-angle composition with extreme scale
contrast, 1970s science fiction book cover aesthetic, painterly,
atmospheric, sublime
```

**key differences from your other tools:**

|                          | imagen 4 fast    | veo 3.1           | comfyui/flux              |
| ------------------------ | ---------------- | ----------------- | ------------------------- |
| think like a...          | photographer     | director          | photographer + technician |
| temporal                 | single frame     | sequence          | single frame              |
| negative prompts         | no (legacy)      | phrase positively | yes (cfg)                 |
| prompt length sweet spot | 50-200 words     | 100-150 words     | structured tags           |
| auto-rewrite             | yes (default on) | no                | no                        |
| audio                    | n/a              | first-class       | n/a                       |

**tldr for iteration strategy:** use fast mode for iteration, ultra for polished finals. start with ~50 word prompts to test directions, then expand to 100-200 when you find something worth refining. change one variable at a time. and definitely experiment with `enhance_prompt` on vs off — that rewriter is a wildcard for stylized work.

## Google Veo 3.1

veo 3.1 responds best to prompts structured as **mini shot lists**, not scene descriptions. think director, not novelist.

**`[cinematography] + [subject] + [action] + [context/setting] + [style & mood] + [audio]`**

sweet spot is **3-6 sentences, \~100-150 words**. enough to be specific, not so much that it chokes.

### **what actually matters**

**1\. lead with camera language.** this is the single highest-leverage element. shot type, lens, movement — veo uses these as the primary structural anchor for the whole generation.

- "close-up, shallow depth of field, slow dolly-in" \>\> "a beautiful close view"
- use real terms: crane shot, tracking shot, POV, wide-angle lens, macro, two-shot

**2\. audio is a first-class citizen now.** veo 3.1's big upgrade is synchronized audio generation. if you don't specify it, you get random guesses. always include:

- `Dialogue:` with quotes for speech ("She whispers, 'We need to go.'")
- `SFX:` for discrete sounds (SFX: glass shattering)
- `Ambient:` for background soundscape (Ambient: distant traffic, soft rain)

**3\. describe what IS there, not what ISN'T.** negative prompts work but need to be phrased positively — "a desolate landscape with no buildings or roads" beats "no man-made structures." veo interprets absence better when it has a concrete scene to anchor to.

**4\. specificity destroys generic output.** instead of "a woman walks in a park," go: "waist-up tracking shot at chest height, 35mm — a woman in her 30s in a camel overcoat walking through an oak-lined path, warm backlight filtering through autumn leaves, golden hour, melancholic." every unspecified dimension defaults to bland.

### **key differences from image prompting**

this is where your midjourney/flux instincts need recalibration:

- **no photographer/lens spec stacking** like you'd do for stills. veo wants cinematic language — shot types, camera movements, lighting mood. it's more "DP on set" than "photographer choosing glass"
- **temporal thinking is mandatory.** you're describing a _sequence_, not a frame. what changes? what moves? what enters/exits?
- **audio prompting is a parallel track.** treat it like a separate layer that runs alongside your visual description

### **advanced workflows worth knowing**

- **image-to-video:** generate your start frame with nano banana (gemini image gen), then animate with veo. the image locks subject/setting/style, your prompt just describes motion \+ audio
- **first & last frame:** provide start \+ end images, veo interpolates the transition. insane for controlled camera moves
- **ingredients to video:** upload reference images for character/object/style consistency across multiple clips
- **timestamp prompting:** choreograph progression within a single continuous shot — phase 1 at 0-3s, phase 2 at 3-6s, etc.

### **practical tips**

- clips are 4, 6, or 8 seconds. plan accordingly
- 720p or 1080p, 16:9 or 9:16
- break complex scenes into individual shots rather than cramming everything into one prompt
- iterate. first gen is a draft, not a final
- use gemini to enrich sparse prompts with cinematic detail if you're stuck

### **for your dark digital romanticism stuff**

veo could be interesting for animating those cosmic sublime scenes — tiny figure before a vast phenomenon, slow camera reveal. i'd try something like:

Slow crane shot ascending from ground level, a lone figure in a dark cloak standing at the edge of an obsidian cliff, facing an impossibly vast nebula that fills the entire sky. Deep blacks, jewel-tone purples and teals reflecting off crystalline rock formations. The camera rises to reveal the true scale — the figure becomes microscopic against the cosmic structure. Moody, 1970s sci-fi book cover brought to life, heavy film grain, anamorphic lens flare. Ambient: deep resonant hum, distant stellar winds, faint crystalline chiming.

that said — veo's strength is photorealism and cinematic naturalism. for heavily stylized painterly stuff you might need to lean hard on style keywords or use image-to-video with a pre-generated frame in your aesthetic as the anchor. worth experimenting both ways.

## Nano Banana 2

nano banana 2 is the gemini 3.1 flash image preview model (`gemini-3.1-flash-image-preview`). it sits between the original nano banana (gemini 2.5 flash) and nano banana pro (gemini 3 pro image). the key upgrade over the original: it combines the advanced world knowledge and reasoning from nano banana pro with flash-level speed.

**how it actually works under the hood**

this matters for prompting: nano banana's secret sauce is that its text encoder isn't just processing your prompt — it's generating autoregressive image tokens fed to the image decoder. so the LLM backbone _is_ the prompt understanding layer. this means it reasons about your prompt before rendering, which is why it handles complex multi-constraint prompts way better than pure diffusion models.

**the prompting formula**

google's official guide boils it down to:

**`[Subject] + [Action] + [Location/context] + [Composition] + [Style]`**

when starting from a blank canvas, you need to describe the scene narratively — a keyword list won't cut it. think photographer-style language: lens specs, lighting setups, material textures, camera angle.

**what actually moves the needle**

- **photographer language works here** (unlike veo which wants director language). specify camera hardware — GoPro for distorted action feel, Fujifilm for color science, disposable camera for raw nostalgic flash aesthetic. force perspective with explicit lens requests like "wide-angle lens" or "macro lens" or "shallow depth of field (f/1.8)".

- **lighting as a first-class dimension.** ask for specific setups: "three-point softbox setup" for product shots, "Chiaroscuro lighting with harsh, high contrast" for drama, "Golden hour backlighting creating long shadows".

- **materiality over abstraction.** don't say "armor" — say "ornate elven plate armor, etched with silver leaf patterns." don't say "suit jacket" — say "navy blue tweed". this is where it really diverges from midjourney vibes prompting.

- **color grading / film stock.** specify the emotional texture: "as if on 1980s color film, slightly grainy" or "cinematic color grading with muted teal tones".

- **positive framing always.** "empty street" instead of "no cars". same principle as every other model but it's especially important here.

**the pro-level tricks**

- **thinking levels:** you can adjust thinking from minimal (default) to high/dynamic, which lets the model reason through complex prompts before rendering — significantly improves output quality and prompt adherence. crank this up for anything compositionally complex.

- **web grounding:** it can actively search the web to generate images based on real-time information. wild for reference-accurate stuff — you can tell it to look up a real place/object and then render it.

- **multimodal references:** you can mix up to 14 reference images in a single prompt. formula: `[Reference images] + [Relationship instruction] + [New scenario]`.

- **text-first hack for in-image text:** when you need text rendered in an image, first have a conversation with gemini to generate the text concepts, then ask for the image with that text. two-step process beats one-shot.

- **resolutions:** 1K, 2K, 4K native, plus a new 512px tier for fast iteration. iterate at 512, finalize at 4K.

**the realism bias caveat**

nano banana pro (and by extension nb2) tends to push prompts toward realism — an understandable RLHF target for the median user, but it can cause issues with prompts that are inherently surreal. for your dark digital romanticism stuff this is the main friction point. the model's reasoning layer tries to "correct" surreal intent toward the median, which is exactly what you don't want when you're going for cosmic sublime painterly stuff.

**practical implication for your workflow:** for the heavily stylized aesthetic work, you're probably still better off in comfyui where you have granular diffusion control. but nb2 is excellent for generating photorealistic reference frames that you then feed into veo as keyframes — which is exactly the pipeline you already know about. it's also great for quickly iterating on compositions and lighting setups before committing to the heavier comfyui workflow.
