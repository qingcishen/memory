// A1 · 外貌/自拍 门面统一出口。
export { MockImageProvider, HttpImageProvider, defaultImageProvider } from './provider.js';
export {
  shouldSendSelfie,
  canSendSelfie,
  buildSelfiePrompt,
  Selfie,
  readAppearanceAssets,
  insertAppearanceAsset,
} from './selfie.js';
