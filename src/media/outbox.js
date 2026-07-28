const STABLE_URL_RE = /^https:\/\/\S+$/i;

export function isStableMediaReference(value) {
  return STABLE_URL_RE.test(String(value ?? ''));
}

/**
 * 只把稳定公网引用写入持久队列。data URL / blob / 本地路径继续即时投递，
 * 避免把大块 base64 或机器路径复制进 jobs。
 */
export async function dispatchMediaOutbox({
  asset = {},
  route = {},
  eventId = null,
  projection = 'media',
  enqueue,
  deliverNow,
} = {}) {
  if (!isStableMediaReference(asset.url) || typeof enqueue !== 'function') {
    const result = await deliverNow?.(asset);
    return { durable: false, mode: 'direct', result };
  }

  const safeAsset = {
    url: String(asset.url),
    kind: asset.kind ?? null,
    reason: asset.reason ?? null,
    tags: Array.isArray(asset.tags) ? asset.tags.map(String).slice(0, 20) : [],
    cached: Boolean(asset.cached),
  };
  const job = await enqueue(
    { ...route, asset: safeAsset, eventId },
    {
      idempotencyKey: eventId ? `${eventId}:${projection}` : null,
    },
  );
  return { durable: true, mode: 'outbox', job };
}
