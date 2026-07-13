// A1 · 外貌/自拍 门面统一出口。
export { MockImageProvider, HttpImageProvider, OpenAIImageProvider, defaultImageProvider } from './provider.js';
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
