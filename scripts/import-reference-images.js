import fs from 'node:fs';
import path from 'node:path';
import { listReferenceImages, saveReferenceImage } from '../src/appearance/references.js';

const sourceDir = process.argv[2] || '/Users/shenqingci/清词照片';
const userId = process.argv[3] || '*';
const companionId = process.argv[4] || 'default';
const avatarName = process.argv[5] || '脸部特写.png';
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const PRIORITY = ['脸部特写.png', '正面.png', '侧身45度角.png', '大头照.png', '怼脸自拍.png', '01.png', '02.png', '03.png'];

const files = fs.readdirSync(sourceDir)
  .filter((name) => MIME[path.extname(name).toLowerCase()])
  .sort((a, b) => {
    const ai = PRIORITY.indexOf(a); const bi = PRIORITY.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return a.localeCompare(b, 'zh-CN');
  });

const before = listReferenceImages(userId, companionId).length;
let processed = 0;
for (const name of files) {
  const file = path.join(sourceDir, name);
  saveReferenceImage({
    userId, companionId, name, mime: MIME[path.extname(name).toLowerCase()],
    data: fs.readFileSync(file).toString('base64'), isAvatar: name === avatarName, source: file,
  });
  processed += 1;
}
const total = listReferenceImages(userId, companionId).length;
console.log(JSON.stringify({ ok: true, sourceDir, userId, companionId, processed, added: total - before, total, avatarName }));
