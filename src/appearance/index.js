// A1 · 外貌/自拍 门面统一出口。
export {
  MockImageProvider,
  HttpImageProvider,
  OpenAIImageProvider,
  defaultImageProvider,
  withReferenceIdentityPrefix,
} from './provider.js';
export {
  shouldSendSelfie,
  canSendSelfie,
  buildSelfiePrompt,
  buildUnifiedLookPrompt,
  buildScenePrompt,
  decidePhoto,
  imageQualityGate,
  FACE_LOCK,
  Selfie,
  readAppearanceAssets,
  insertAppearanceAsset,
  recentPhotoRateState,
} from './selfie.js';
export {
  IDENTITY_LOCK,
  REFERENCE_SCOPE_BAN,
  MATURE_WIFE_AURA,
  FULL_BODY_SHOES,
  IMAGE_NEGATIVE,
  assemblePersonImagePrompt,
  applyPromptKit,
  sanitizeShoesForImage,
} from './promptKit.js';
