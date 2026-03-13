# Model Prompting Best Practices

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
