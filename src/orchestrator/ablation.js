/**
 * 消融 flag 兼容层。
 * 旧 narration=false 在未显式提供新 flag 时同时关闭 classifier 与 prompt；
 * 一旦显式提供拆分 flag，则拆分 flag 优先。
 */
export function normalizeAblationFlags(defaults = {}, overrides = {}) {
  const merged = { ...(defaults ?? {}), ...(overrides ?? {}) };
  const hasLegacy = Object.prototype.hasOwnProperty.call(overrides ?? {}, 'narration');
  const hasPrompt = Object.prototype.hasOwnProperty.call(overrides ?? {}, 'narrationPrompt');
  const hasClassifier = Object.prototype.hasOwnProperty.call(
    overrides ?? {},
    'narrationClassifier',
  );
  if (!hasPrompt && (hasLegacy || merged.narration === false)) {
    merged.narrationPrompt = hasLegacy ? overrides.narration : false;
  }
  if (!hasClassifier && (hasLegacy || merged.narration === false)) {
    merged.narrationClassifier = hasLegacy ? overrides.narration : false;
  }

  const hasLegacyDesire = Object.prototype.hasOwnProperty.call(overrides ?? {}, 'desire');
  const hasDesirePrompt = Object.prototype.hasOwnProperty.call(overrides ?? {}, 'desirePrompt');
  const hasDesireInference = Object.prototype.hasOwnProperty.call(
    overrides ?? {},
    'desireInference',
  );
  if (!hasDesirePrompt && (hasLegacyDesire || merged.desire === false)) {
    merged.desirePrompt = hasLegacyDesire ? overrides.desire : false;
  }
  if (!hasDesireInference && (hasLegacyDesire || merged.desire === false)) {
    merged.desireInference = hasLegacyDesire ? overrides.desire : false;
  }
  return merged;
}
