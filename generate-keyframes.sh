#!/usr/bin/env bash

set -euo pipefail

MODEL="google/imagen-4.0-fast-generate-001"
ASPECT_RATIO="16:9"
SAFETY_FILTER_LEVEL="OFF"
N=1
SCRIPT="generate-imagen-options.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required but was not found in PATH." >&2
  exit 1
fi

generate_keyframe() {
  local shot_id="$1"
  local frame_type="$2"
  local prompt="$3"
  local output_dir="keyframes/${shot_id}"

  echo "Generating ${shot_id} ${frame_type} -> ${output_dir}"
  bun "$SCRIPT" \
    --prompt "$prompt" \
    --model "$MODEL" \
    --n "$N" \
    --aspect-ratio "$ASPECT_RATIO" \
    --safety-filter-level "$SAFETY_FILTER_LEVEL" \
    --output-dir "$output_dir" \
    --name-prefix "${frame_type}"
}

generate_keyframe "S1-SH01" "start" "A photo of an isolated rural Central European house standing alone in a muted grassy field under soft overcast daylight, whitewashed plaster walls, dark pitched roof, single chimney, two front-facing windows, the house small in frame with wide negative space around it, pale gray sky, late autumn field texture, restrained natural color palette of straw, weathered white, brown earth, and soot gray, quiet observational composition, realistic documentary-photography detail, subtle film grain, modest lived-in architecture, no people outside, no vehicles, no power lines, no text, no stylization."
generate_keyframe "S1-SH01" "end" "A photo of the same isolated rural house under the same overcast daylight, camera position closer and more centered on the front facade, whitewashed walls, dark roof, single chimney, two front-facing windows now clearly legible, muted field grass in the foreground, soft gray sky, realistic rural texture, restrained somber mood, natural photographic detail, subtle film grain, the building larger in frame but still surrounded by open field, exact same architecture as the opening frame, no people outside, no modern clutter, no text."

generate_keyframe "S1-SH02" "start" "A photo of an elderly rural woman seated indoors knitting in a modest farmhouse room, weathered hands prominent in the foreground holding wool yarn and knitting needles, deeply lined face in three-quarter profile, gray hair under a headscarf, muted folk clothing with apron and layered natural fabrics, soft overcast window light falling across old wood furniture and worn plaster walls, the framed portrait of her young soldier husband visible but secondary in the background, intimate stillness, restrained realism, textured materials, subtle film grain, natural earthy palette, no posed glamour, no theatrical sadness, no modern decor, no text."
generate_keyframe "S1-SH02" "end" "A photo of the same elderly woman in the same room continuing to knit, same headscarf, apron, and weathered hands, composition shifted so the aged framed portrait of her young soldier husband becomes more visually dominant behind her, soft window light, worn plaster wall, raw wood and wool textures, domestic stillness, muted reds, browns, off-whites, and dark greens, realistic rural interior detail, gentle falloff in the shadows, the woman calm and rooted while the portrait quietly pulls the eye, no costume-pageant styling, no modern objects, no text."

generate_keyframe "S1-SH03" "start" "A photo of an aged modest framed portrait hanging on a worn plaster wall inside a rural house, the portrait showing a young soldier husband with a lean serious face in an older-war uniform, monochrome portrait treatment, tarnished frame, soft natural window light, traces of the room still visible around it, subtle grain and paper texture, reverent but uneasy mood, realistic wall texture and household context, composition prepared for a slow push-in, the portrait clearly a physical object, no fantasy glow, no ornate decoration, no text."
generate_keyframe "S1-SH03" "end" "A photo of the same framed portrait pushed in until the young soldier husband's monochrome face nearly fills the image, the aged frame edges only barely visible at the margins and beginning to disappear into darkness and grain, the portrait texture feeling like paper becoming space, lean serious face, older-war uniform collar, soft shadows and drifting particulate hinting at depth beyond the image plane, uncanny threshold mood, still mostly black and white, realistic texture, no abrupt fantasy effects, no text."

generate_keyframe "S2-SH04" "start" "A photo of the young soldier husband's monochrome portrait face at extreme close range as the flat image begins to become dimensional, lean farm-bred features matching the framed portrait, older-war uniform, smoke-like particulate drifting in shallow depth around him, black-and-white tonal range, paper texture giving way to atmospheric depth, uncanny suspended mood, the image still mostly portrait-like but no longer flat, realistic grain, no heroic pose, no decorative studio glamour, no text."
generate_keyframe "S2-SH04" "end" "A photo of the same young soldier now fully inside a dimensional monochrome battlefield, medium-tight framing with smoke moving around him and depth emerging behind, older-war uniform worn and dirty, serious strained expression, daylight filtered through smoke, mud and ash textures, black-and-white image with rich contrast and natural grain, the portrait identity clearly preserved while the static relic has become lived memory, haunted and uneasy atmosphere, no modern gear, no triumphant action pose, no text."

generate_keyframe "S2-SH05" "start" "A photo of the same young soldier husband breaking into motion through an older-war battlefield, medium-wide framing, nearly monochrome image with only the faintest hint of muted color beginning to emerge, smoke swallowing the background, mud underfoot, worn historical uniform, lean serious face under strain, survival-driven movement, daylight through haze, fear and urgency rather than heroism, realistic battlefield grime, subtle motion energy frozen in a single frame, tank silhouette barely beginning to appear ahead on his forward path, no modern special-operations styling, no text."
generate_keyframe "S2-SH05" "end" "A photo of the same soldier in full muted color running toward an older-war tank that now dominates the forward path, medium tracking perspective, ash gray smoke, mud brown ground, rusted steel, fire-tinted haze, worn historical uniform, same face as the portrait, urgent survival energy, daylight through battlefield smoke, the tank hull filling much of the frame ahead as an inevitable destination, tactile realism, moral ugliness, no glamorous action-movie styling, no modern weapons language, no text."

generate_keyframe "S3-SH06" "start" "A photo of an older-war tank hull filling the frame at extreme close range, seen on the same forward vector as the running soldier, muted battlefield color, smoke and grime still visible around the steel surface, bolts, seams, scratched paint, mud, rust, and soot rendered in tactile detail, the camera almost colliding with the armor, claustrophobic mechanistic mood, realistic historical hardware, no futuristic design cues, no cutaway diagram feel, no text."
generate_keyframe "S3-SH06" "end" "A photo from inside a dark mechanical tunnel aligned like the center of a tank barrel, the interior resolving into concentric steel geometry with scraped metal, soot, darkness, and a bright circular exit ahead, smooth forward-axis composition, old war machine texture, color compressed toward cold steel gray and dirty brown, relentless tunnel perspective, impossible but believable spatial continuity, no people visible, no futuristic CGI shine, no text."

generate_keyframe "S3-SH07" "start" "A photo looking through the interior of a dark barrel-like tunnel toward a bright circular exit, centered forward-axis composition, scraped steel, soot, and mechanical wear around the edges, the bright opening filling the far end of the frame, transition from enclosed machine interior to exterior daylight, cold inhuman mood, realistic texture, no interface graphics, no futuristic styling, no text."
generate_keyframe "S3-SH07" "end" "A photo from a low fast first-person flight over a muted rural field in overcast daylight, the horizon stabilized and the direction toward the isolated whitewashed house now readable ahead, grass streaking below, subtle cold steel undertone in the palette, no HUD, no targeting graphics, no timestamps, same field atmosphere as the opening shot, committed weapon-like forward perspective, realistic aerial motion feel frozen as a single frame, the house still distant but clearly on the trajectory line, no text."

generate_keyframe "S4-SH08" "start" "A photo from a low fast FPV-like approach over the same rural field toward the same isolated house, overcast daylight matching the opening, whitewashed walls, dark pitched roof, single chimney, two front-facing windows, the building clearly recognizable at a distance ahead, grass and ground texture streaking below, slight rise in camera angle to keep the facade legible, predatory forward energy, realistic photographic detail, no interface graphics, no ornamental drone cinematography, no text."
generate_keyframe "S4-SH08" "end" "A photo from milliseconds before collision with the same rural house, the front facade now nearly filling the frame, two front-facing windows and weathered plaster wall still identifiable, dark roof edge and chimney briefly visible, overcast daylight, muted field color at the margins, brutal forward motion frozen at the brink of impact, exact same house geometry as the opening shot, no stylized action framing, no HUD, no text."

generate_keyframe "S4-SH09" "start" "A photo at the instant of impact with the front wall of the same house, recognizable window and whitewashed facade still visible at first contact, overcast daylight, splintering plaster, wood fragments, dust, and the first burst of orange-white detonation beginning to engulf the frame, violent but anti-spectacle, realistic debris and structural breakage, no blockbuster fireball styling, no HUD, no text."
generate_keyframe "S4-SH09" "end" "A photo consumed by the immediate aftermath of the collision, the frame filled with orange-white blast light, dust, debris, shattered plaster, wood fragments, and collapsing orientation, only the faintest remnants of house material readable inside the chaos, brutal finality, realistic explosion texture rather than glossy spectacle, white-orange and gray dust palette, image breakup and engulfing debris cloud, no cinematic heroism, no text."

echo "All keyframe generation jobs completed."
