/**
 * 出图 / 穿搭成片 · 统一提示词套件
 * - 参考图仅锁：脸型轮廓 + 五官比例
 * - 成熟人妻感、韵味、克制、非幼态非擦边
 * - 全身 + 完整鞋履（出图硬规则）
 */

/** 身份锁：仅脸型轮廓与五官比例 */
export const IDENTITY_LOCK =
  'same woman identity lock: match only face shape contour and facial feature proportions; adult East Asian Korean-style face (not Western); ' +
  'photorealistic skin with natural pores and fine texture; consistent identity across images';

/** 有参考图时必带：作用域禁区 */
export const REFERENCE_SCOPE_BAN =
  'Use reference image ONLY for face shape and facial proportions. ' +
  'Do NOT copy or inherit from reference: expression, gaze direction, eye focus, head angle, chin tilt, mouth, brow emotion, ' +
  'hairstyle, hair color, makeup, hand pose, finger pose, stance, posture, body orientation, leg pose, overall vibe, ' +
  'outfit, shoes, accessories, background, lighting, composition, or camera angle. ' +
  'Completely redesign expression, gaze, pose, and body language so they visibly differ from the reference.';

/** 成熟人妻感气质（非幼态、非擦边） */
export const MATURE_WIFE_AURA =
  'mature elegant adult East Asian woman, refined married-woman elegance (renqi-gan), soft warmth, relaxed poise, tasteful femininity, ' +
  'graceful body language, high-end lifestyle aesthetic, not schoolgirl, not childish, not vulgar sexy, not influencer thirst-trap';

/** 写实胶片摄影 */
export const REALISM_FILM =
  'ultra realistic editorial fashion photography, low saturation, soft film grain, shallow depth of field, low contrast, ' +
  'wet catchlights in eyes, clear iris texture, natural flyaway hair strands, fabric weave and drape detail, no plastic skin';

/** 全身 + 鞋履硬规则 */
export const FULL_BODY_SHOES =
  'full body head-to-toe full-length fashion portrait, entire figure in frame, feet not cropped, ' +
  'shoes fully visible and clearly described, footwear required, no barefoot, no bare feet, no missing shoes';

/** 统一负向（并入 prompt 尾或独立 negative） */
export const IMAGE_NEGATIVE =
  'copied pose from reference, copied expression from reference, copied gaze from reference, copied head angle from reference, ' +
  'copied body posture from reference, copied hand position from reference, same mood as reference, ' +
  'minor, underage, childish face, schoolgirl, vulgar, cheap sexy, pornographic, explicit nudity, lingerie showcase, ' +
  'transparent clothing, fetish pose, exaggerated breasts, exaggerated hips, barefoot, bare feet, no shoes, missing shoes, ' +
  'cropped feet, cropped ankles, incomplete outfit, bad anatomy, deformed, extra fingers, plastic skin, heavy beauty filter, ' +
  'western face, European face, collage, grid, multiple panels, multiple people, low quality, anime, illustration';

const BAREFOOT_RE = /赤脚|光脚|barefoot|bare feet|no shoes|真空赤脚/i;

/**
 * 出图用鞋履净化：赤脚 → 得体可见鞋履
 */
export function sanitizeShoesForImage(shoesText = '') {
  const s = String(shoesText || '').trim();
  if (!s || BAREFOOT_RE.test(s)) {
    return 'soft neutral house mules or elegant low heels fully visible';
  }
  return s;
}

/**
 * 穿搭出图 mods：保证 summary + 鞋履 + 全身可见提示
 */
export function wrapOutfitImageMods(outfitMods = [], pieces = {}) {
  const mods = [...(outfitMods || []).map(String).filter(Boolean)];
  const shoes = sanitizeShoesForImage(pieces?.shoes);
  if (shoes && !mods.some((m) => /shoe|鞋|heel|mule|sandal|boot/i.test(m))) {
    mods.push(`wearing ${shoes}, shoes fully visible`);
  } else if (pieces?.shoes && BAREFOOT_RE.test(String(pieces.shoes))) {
    mods.push(`wearing ${shoes}, shoes fully visible (not barefoot)`);
  }
  if (!mods.some((m) => /full.?body|head-to-toe|full-length/i.test(m))) {
    mods.push('full-length outfit clearly readable');
  }
  return mods;
}

/**
 * 情绪 → 人妻感动作/神态修饰（禁止幼态）
 */
export function moodModsForImage(emotion = {}, life = {}, now = Date.now()) {
  const mods = [];
  const valence = Number(emotion.valence) || 0;
  if (life?.sick_until && new Date(life.sick_until).getTime() > now) {
    mods.push('slightly tired soft expression, gentle composure, still elegant');
  } else if (valence > 0.3) {
    mods.push('soft warm almost-smile, tender mature gaze, relaxed married-woman charm');
  } else if (valence < -0.2) {
    mods.push('quiet reserved expression, soft melancholy, restrained elegance');
  } else {
    mods.push('calm poised expression, soft composed eyes, tasteful mature presence');
  }
  return mods;
}

/**
 * 组装人物出图 prompt
 * @param {{ appearance, outfitMods, moodMods, scene, kind, hasReferences, companionTrigger, appendNegative }}
 */
export function assemblePersonImagePrompt({
  appearance = '',
  outfitMods = [],
  moodMods = [],
  scene = '',
  kind = 'lookbook', // selfie | lookbook | album
  hasReferences = false,
  companionTrigger = '',
  appendNegative = true,
  pieces = {},
} = {}) {
  const parts = [];
  if (companionTrigger) parts.push(String(companionTrigger).trim());
  if (hasReferences) parts.push(REFERENCE_SCOPE_BAN);
  parts.push(IDENTITY_LOCK);
  parts.push(MATURE_WIFE_AURA);

  const face = String(appearance || '').trim() || 'elegant adult East Asian woman with refined facial proportions';
  parts.push(face);

  const outfit = wrapOutfitImageMods(outfitMods, pieces);
  if (outfit.length) parts.push(outfit.join(', '));

  if (moodMods?.length) parts.push(moodMods.join(', '));
  if (scene) parts.push(String(scene).trim());

  // framing
  if (kind === 'selfie') {
    parts.push(
      'natural phone selfie or candid half-to-three-quarter portrait preferred, still mature elegant, ' +
        'if full body then shoes visible; soft home or lifestyle light',
    );
  } else {
    parts.push(FULL_BODY_SHOES);
    parts.push('luxury fashion editorial or refined lifestyle photography, natural or soft cinematic light');
  }
  parts.push(REALISM_FILM);
  parts.push('no text, no watermark, no logo');

  let prompt = parts.filter(Boolean).join('. ').replace(/\.\s*\./g, '.');
  if (appendNegative) {
    prompt = `${prompt}. Avoid: ${IMAGE_NEGATIVE}`;
  }
  return {
    prompt,
    negative: IMAGE_NEGATIVE,
    tags: [],
  };
}

/**
 * 给已有长 prompt 包一层身份锁 + 参考图禁区 + 负向（**套装/人像卡**用）
 */
export function applyPromptKit(rawPrompt = '', { hasReferences = false, forceFullBody = true, appendNegative = true } = {}) {
  const body = String(rawPrompt || '').trim();
  const head = [
    hasReferences ? REFERENCE_SCOPE_BAN : '',
    IDENTITY_LOCK,
    MATURE_WIFE_AURA,
    forceFullBody ? FULL_BODY_SHOES : '',
  ]
    .filter(Boolean)
    .join('. ');
  let prompt = body ? `${head}. ${body}` : head;
  if (forceFullBody && !/shoe|鞋|heel|full body|head-to-toe/i.test(prompt)) {
    prompt += `. ${FULL_BODY_SHOES}`;
  }
  if (appendNegative && !/Avoid:|negative/i.test(prompt)) {
    prompt += `. Avoid: ${IMAGE_NEGATIVE}`;
  }
  return { prompt, negative: IMAGE_NEGATIVE };
}

/** 单品出图：禁止出现人物 */
export const PRODUCT_ONLY =
  'luxury product photography of a single item only, no person, no model, no human face, no body, no hands as portrait subject, ' +
  'isolated product or premium still life, soft studio light, material texture detail, clean background, no text, no watermark';

export const IMAGE_NEGATIVE_PRODUCT =
  'person, model, woman, man, face, portrait, full body, human hands holding as lifestyle portrait, multiple products clutter, ' +
  'collage, grid, text, watermark, logo, low quality, cartoon, plastic cheap materials';

/**
 * 单品卡 prompt 包装：只有产品，没有人
 */
export function applyProductPromptKit(rawPrompt = '', { appendNegative = true } = {}) {
  const body = String(rawPrompt || '').trim();
  // 去掉误拼的人像套件残留
  const cleaned = body
    .replace(/same woman[^.]*\./gi, '')
    .replace(/full body head-to-toe[^.]*\./gi, '')
    .replace(/married-woman[^.]*\./gi, '')
    .replace(/East Asian woman[^.]*\./gi, '')
    .trim();
  let prompt = `${PRODUCT_ONLY}. ${cleaned || 'premium luxury item'}`;
  if (appendNegative && !/Avoid:|no person/i.test(prompt)) {
    prompt += `. Avoid: ${IMAGE_NEGATIVE_PRODUCT}`;
  }
  return { prompt, negative: IMAGE_NEGATIVE_PRODUCT };
}

/** 是否「有人」的套装/着装卡 */
export function isPersonOutfitCard(kind = '') {
  return kind === 'look' || kind === 'lingerie';
}
