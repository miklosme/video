# KEYFRAMES

## Purpose

This file is the still-image development layer between storyboard and final video prompting. Use it to design and lock frame targets, especially when transitions, identity consistency, or environment continuity need to be solved visually before motion generation.

## Active Model

Imagen 4 Fast (model card `google/imagen-4.0-fast-generate-001`)

## Workflow Notes

- Keep exploratory still-image prompts here, not in `PROMPT-PACK.md`.
- Promote approved keyframes into `REFERENCES.md` with file paths once images exist.
- If an approved keyframe changes canon, update `CHARACTERS.md`, `STYLE.md`, `STORYBOARD.md`, or `CONTINUITY.md` before continuing.
- When a shot needs transition precision, define both a start frame target and an end frame target.

## Project-Wide Consistency Anchors

### House Anchor

- Isolated rural Central or Eastern European house in a muted field.
- Whitewashed plaster walls, dark pitched roof, single chimney, two front-facing windows.
- Overcast daylight, soft gray sky, subdued straw and earth palette.
- Modest, weathered, real, never picturesque or storybook-pretty.

### Woman Anchor

- Elderly rural woman, late 70s to mid 80s, deeply lined face, strong cheekbones, weathered hands.
- Gray hair mostly covered by a headscarf.
- Traditional folk clothing: muted blouse, apron, layered vest or dress, worn natural fabrics, subtle embroidery.
- Seated and knitting with contained emotion, domestic stillness, no theatrical grief.

### Soldier Anchor

- Young husband in his mid 20s to early 30s, lean, serious, farm-bred face, same facial structure as the portrait.
- Older-war uniform only, practical and worn, never glossy or heroic.
- Smoke, mud, and strain on the battlefield.
- Monochrome origin that can bloom into muted color.

## Shot Keyframes

### S1-SH01

#### FRAME GOAL

Opening exterior establishing image of the isolated rural house in the field.

#### START KEYFRAME PROMPT

A photo of an isolated rural Central European house standing alone in a muted grassy field under soft overcast daylight, whitewashed plaster walls, dark pitched roof, single chimney, two front-facing windows, the house small in frame with wide negative space around it, pale gray sky, late autumn field texture, restrained natural color palette of straw, weathered white, brown earth, and soot gray, quiet observational composition, realistic documentary-photography detail, subtle film grain, modest lived-in architecture, no people outside, no vehicles, no power lines, no text, no stylization.

#### END KEYFRAME PROMPT

A photo of the same isolated rural house under the same overcast daylight, camera position closer and more centered on the front facade, whitewashed walls, dark roof, single chimney, two front-facing windows now clearly legible, muted field grass in the foreground, soft gray sky, realistic rural texture, restrained somber mood, natural photographic detail, subtle film grain, the building larger in frame but still surrounded by open field, exact same architecture as the opening frame, no people outside, no modern clutter, no text.

#### APPROVED IMAGE

TBD

### S1-SH02

#### FRAME GOAL

Interior image of the Woman knitting, with domestic stillness and the portrait beginning to matter in the composition.

#### START KEYFRAME PROMPT

A photo of an elderly rural woman seated indoors knitting in a modest farmhouse room, weathered hands prominent in the foreground holding wool yarn and knitting needles, deeply lined face in three-quarter profile, gray hair under a headscarf, muted folk clothing with apron and layered natural fabrics, soft overcast window light falling across old wood furniture and worn plaster walls, the framed portrait of her young soldier husband visible but secondary in the background, intimate stillness, restrained realism, textured materials, subtle film grain, natural earthy palette, no posed glamour, no theatrical sadness, no modern decor, no text.

#### END KEYFRAME PROMPT

A photo of the same elderly woman in the same room continuing to knit, same headscarf, apron, and weathered hands, composition shifted so the aged framed portrait of her young soldier husband becomes more visually dominant behind her, soft window light, worn plaster wall, raw wood and wool textures, domestic stillness, muted reds, browns, off-whites, and dark greens, realistic rural interior detail, gentle falloff in the shadows, the woman calm and rooted while the portrait quietly pulls the eye, no costume-pageant styling, no modern objects, no text.

#### APPROVED IMAGE

TBD

### S1-SH03

#### FRAME GOAL

Portrait push-in target that can bridge the domestic wall object into the memory threshold.

#### START KEYFRAME PROMPT

A photo of an aged modest framed portrait hanging on a worn plaster wall inside a rural house, the portrait showing a young soldier husband with a lean serious face in an older-war uniform, monochrome portrait treatment, tarnished frame, soft natural window light, traces of the room still visible around it, subtle grain and paper texture, reverent but uneasy mood, realistic wall texture and household context, composition prepared for a slow push-in, the portrait clearly a physical object, no fantasy glow, no ornate decoration, no text.

#### END KEYFRAME PROMPT

A photo of the same framed portrait pushed in until the young soldier husband's monochrome face nearly fills the image, the aged frame edges only barely visible at the margins and beginning to disappear into darkness and grain, the portrait texture feeling like paper becoming space, lean serious face, older-war uniform collar, soft shadows and drifting particulate hinting at depth beyond the image plane, uncanny threshold mood, still mostly black and white, realistic texture, no abrupt fantasy effects, no text.

#### APPROVED IMAGE

TBD

### S2-SH04

#### FRAME GOAL

Portrait image becoming a dimensional monochrome battlefield with the Soldier still clearly the same man.

#### START KEYFRAME PROMPT

A photo of the young soldier husband's monochrome portrait face at extreme close range as the flat image begins to become dimensional, lean farm-bred features matching the framed portrait, older-war uniform, smoke-like particulate drifting in shallow depth around him, black-and-white tonal range, paper texture giving way to atmospheric depth, uncanny suspended mood, the image still mostly portrait-like but no longer flat, realistic grain, no heroic pose, no decorative studio glamour, no text.

#### END KEYFRAME PROMPT

A photo of the same young soldier now fully inside a dimensional monochrome battlefield, medium-tight framing with smoke moving around him and depth emerging behind, older-war uniform worn and dirty, serious strained expression, daylight filtered through smoke, mud and ash textures, black-and-white image with rich contrast and natural grain, the portrait identity clearly preserved while the static relic has become lived memory, haunted and uneasy atmosphere, no modern gear, no triumphant action pose, no text.

#### APPROVED IMAGE

TBD

### S2-SH05

#### FRAME GOAL

Battlefield running image that resolves the Soldier, the older-war setting, and the tank on his forward line.

#### START KEYFRAME PROMPT

A photo of the same young soldier husband breaking into motion through an older-war battlefield, medium-wide framing, nearly monochrome image with only the faintest hint of muted color beginning to emerge, smoke swallowing the background, mud underfoot, worn historical uniform, lean serious face under strain, survival-driven movement, daylight through haze, fear and urgency rather than heroism, realistic battlefield grime, subtle motion energy frozen in a single frame, tank silhouette barely beginning to appear ahead on his forward path, no modern special-operations styling, no text.

#### END KEYFRAME PROMPT

A photo of the same soldier in full muted color running toward an older-war tank that now dominates the forward path, medium tracking perspective, ash gray smoke, mud brown ground, rusted steel, fire-tinted haze, worn historical uniform, same face as the portrait, urgent survival energy, daylight through battlefield smoke, the tank hull filling much of the frame ahead as an inevitable destination, tactile realism, moral ugliness, no glamorous action-movie styling, no modern weapons language, no text.

#### APPROVED IMAGE

TBD

### S3-SH06

#### FRAME GOAL

Tank-entry image that converts battlefield space into a centered mechanical tunnel.

#### START KEYFRAME PROMPT

A photo of an older-war tank hull filling the frame at extreme close range, seen on the same forward vector as the running soldier, muted battlefield color, smoke and grime still visible around the steel surface, bolts, seams, scratched paint, mud, rust, and soot rendered in tactile detail, the camera almost colliding with the armor, claustrophobic mechanistic mood, realistic historical hardware, no futuristic design cues, no cutaway diagram feel, no text.

#### END KEYFRAME PROMPT

A photo from inside a dark mechanical tunnel aligned like the center of a tank barrel, the interior resolving into concentric steel geometry with scraped metal, soot, darkness, and a bright circular exit ahead, smooth forward-axis composition, old war machine texture, color compressed toward cold steel gray and dirty brown, relentless tunnel perspective, impossible but believable spatial continuity, no people visible, no futuristic CGI shine, no text.

#### APPROVED IMAGE

TBD

### S3-SH07

#### FRAME GOAL

Barrel-exit image that establishes the FPV field direction without HUD elements.

#### START KEYFRAME PROMPT

A photo looking through the interior of a dark barrel-like tunnel toward a bright circular exit, centered forward-axis composition, scraped steel, soot, and mechanical wear around the edges, the bright opening filling the far end of the frame, transition from enclosed machine interior to exterior daylight, cold inhuman mood, realistic texture, no interface graphics, no futuristic styling, no text.

#### END KEYFRAME PROMPT

A photo from a low fast first-person flight over a muted rural field in overcast daylight, the horizon stabilized and the direction toward the isolated whitewashed house now readable ahead, grass streaking below, subtle cold steel undertone in the palette, no HUD, no targeting graphics, no timestamps, same field atmosphere as the opening shot, committed weapon-like forward perspective, realistic aerial motion feel frozen as a single frame, the house still distant but clearly on the trajectory line, no text.

#### APPROVED IMAGE

TBD

### S4-SH08

#### FRAME GOAL

Fast house-approach image that confirms the target is the same building from the opening.

#### START KEYFRAME PROMPT

A photo from a low fast FPV-like approach over the same rural field toward the same isolated house, overcast daylight matching the opening, whitewashed walls, dark pitched roof, single chimney, two front-facing windows, the building clearly recognizable at a distance ahead, grass and ground texture streaking below, slight rise in camera angle to keep the facade legible, predatory forward energy, realistic photographic detail, no interface graphics, no ornamental drone cinematography, no text.

#### END KEYFRAME PROMPT

A photo from milliseconds before collision with the same rural house, the front facade now nearly filling the frame, two front-facing windows and weathered plaster wall still identifiable, dark roof edge and chimney briefly visible, overcast daylight, muted field color at the margins, brutal forward motion frozen at the brink of impact, exact same house geometry as the opening shot, no stylized action framing, no HUD, no text.

#### APPROVED IMAGE

TBD

### S4-SH09

#### FRAME GOAL

Impact image where the house is recognizable at the instant of collision before obliteration.

#### START KEYFRAME PROMPT

A photo at the instant of impact with the front wall of the same house, recognizable window and whitewashed facade still visible at first contact, overcast daylight, splintering plaster, wood fragments, dust, and the first burst of orange-white detonation beginning to engulf the frame, violent but anti-spectacle, realistic debris and structural breakage, no blockbuster fireball styling, no HUD, no text.

#### END KEYFRAME PROMPT

A photo consumed by the immediate aftermath of the collision, the frame filled with orange-white blast light, dust, debris, shattered plaster, wood fragments, and collapsing orientation, only the faintest remnants of house material readable inside the chaos, brutal finality, realistic explosion texture rather than glossy spectacle, white-orange and gray dust palette, image breakup and engulfing debris cloud, no cinematic heroism, no text.

#### APPROVED IMAGE

TBD
