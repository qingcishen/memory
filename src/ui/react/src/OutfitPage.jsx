import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check, Copy, ImagePlus, LoaderCircle, Plus, RefreshCw, Save, Shirt, Sparkles, Trash2, Upload, WandSparkles, X,
} from 'lucide-react';

/** 穿搭页旁：IMAGE_* + 脸参考（与设置页共用 /api/config、/api/image-references） */
const IMAGE_FIELD_KEYS = [
  { key: 'IMAGE_BASE_URL', label: 'Base URL', placeholder: 'https://api.openai.com/v1', secret: false },
  { key: 'IMAGE_API_KEY', label: 'API Key', placeholder: '留空则不改 / 可复用 EMBED 密钥', secret: true },
  { key: 'IMAGE_MODEL', label: '图片模型', placeholder: 'gpt-image-2', secret: false },
  { key: 'IMAGE_SIZE', label: '尺寸', placeholder: '1024x1536', secret: false },
  { key: 'IMAGE_QUALITY', label: '画质', placeholder: 'high', secret: false },
];

const KIND_META = {
  looks: { label: '整套造型', hint: '可一键上身 · 完整 look', empty: '还没有造型' },
  pieces: { label: '单品衣物', hint: '上衣 / 下装 / 裙 · 鞋表珠宝走专柜', empty: '还没有单品' },
  shoes: { label: '鞋履柜', hint: '高跟鞋 · 乐福 · 靴 · 平底', empty: '鞋柜是空的' },
  bags: { label: '包柜', hint: 'Birkin · Kelly · Chanel…', empty: '包柜是空的' },
  jewelry: { label: '珠宝盒', hint: 'Cartier · VCA · 钻与珍珠', empty: '珠宝盒是空的' },
  watches: { label: '表盘', hint: 'Tank · Rolex · 运动表', empty: '表盘是空的' },
  accessories: { label: '配饰', hint: '丝巾 · 墨镜 · 腰带 · 度假', empty: '配饰是空的' },
  outerwear: { label: '外套柜', hint: '大衣 · 西装 · 羊绒', empty: '外套柜是空的' },
  travel: { label: '旅行箱', hint: 'Rimowa · 登机箱 · 护肤 mini', empty: '旅行箱是空的' },
  beauty: { label: '妆台', hint: '护肤 · 底妆 · 眼唇 · 香氛 · 旅行 mini', empty: '妆台是空的' },
  lingerie: { label: '内衣抽屉', hint: 'La Perla · AP · Eres · Wolford', empty: '抽屉是空的' },
};

const CONTEXT_LABEL = {
  home: '居家', work: '职场', date: '约会', outing: '外出',
  sport: '运动', sleep: '睡眠', intimate: '私密', sick: '病中',
};

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

/** 有限并发并行执行（多图上传用） */
async function mapPool(items, concurrency, worker) {
  const list = Array.from(items || []);
  const results = new Array(list.length);
  let next = 0;
  const run = async () => {
    while (next < list.length) {
      const i = next;
      next += 1;
      results[i] = await worker(list[i], i);
    }
  };
  const n = Math.max(1, Math.min(concurrency || 3, list.length || 1));
  await Promise.all(Array.from({ length: n }, () => run()));
  return results;
}

function isImageFile(file) {
  return file && /^image\/(png|jpeg|webp)$/i.test(file.type);
}

/**
 * 生图模型配置 + 脸参考上传（放在今日穿搭旁边）
 */
function ImageGenAndFacePanel({
  scope,
  api,
  qs,
  json,
  flash,
  onReadyChange,
}) {
  const companionId = scope.companionId || 'default';
  const refInput = useRef(null);
  const [configMeta, setConfigMeta] = useState({});
  const [values, setValues] = useState({});
  const [dirty, setDirty] = useState({});
  const [refs, setRefs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  const [uploading, setUploading] = useState(false);
  const [busyRefId, setBusyRefId] = useState('');

  const loadAll = async () => {
    setLoading(true);
    try {
      const cfg = await api('/api/config');
      const meta = cfg?.values || {};
      setConfigMeta(meta);
      const next = {};
      for (const f of IMAGE_FIELD_KEYS) {
        // secret 不回填明文，只显示空（已配置时用 preview）
        next[f.key] = f.secret ? '' : (meta[f.key]?.value ?? '');
      }
      setValues(next);
      setDirty({});

      if (scope.userId) {
        const r = await api(`/api/image-references?${qs({ userId: scope.userId, companionId })}`);
        setRefs(r?.items || []);
      } else {
        setRefs([]);
      }
    } catch (e) {
      flash?.(e.message || '加载生图配置失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); }, [scope.userId, companionId]);

  const modelSet = Boolean(configMeta.IMAGE_MODEL?.value || values.IMAGE_MODEL);
  const keySet = Boolean(configMeta.IMAGE_API_KEY?.set || dirty.IMAGE_API_KEY);
  const imageReady = modelSet && (keySet || configMeta.EMBED_API_KEY?.set || configMeta.LLM_API_KEY?.set);
  const refsReady = refs.length > 0;

  useEffect(() => {
    onReadyChange?.({ imageReady, refsReady, refCount: refs.length, model: values.IMAGE_MODEL || configMeta.IMAGE_MODEL?.value || '' });
  }, [imageReady, refsReady, refs.length, values.IMAGE_MODEL, configMeta.IMAGE_MODEL?.value]);

  const setField = (key, v) => {
    setValues((x) => ({ ...x, [key]: v }));
    setDirty((x) => ({ ...x, [key]: v }));
  };

  const saveConfig = async () => {
    setSaving(true);
    try {
      const payload = { ...dirty };
      for (const f of IMAGE_FIELD_KEYS) {
        if (f.secret && payload[f.key] === '') delete payload[f.key];
      }
      if (!Object.keys(payload).length) {
        flash?.('没有改动需要保存');
        return;
      }
      const result = await api('/api/config', json('PUT', { values: payload }));
      if (result?.ok === false) throw new Error(result.message || '保存失败');
      flash?.('生图配置已保存到本机 .env');
      setDirty({});
      await loadAll();
    } catch (e) {
      flash?.(e.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const testImage = async () => {
    setTesting(true);
    setTestMsg('');
    try {
      const result = await api('/api/test/image', { method: 'POST' });
      setTestMsg(`${result.ok ? '✓' : '✗'} ${result.message || (result.ok ? 'OK' : '失败')}${result.ms != null ? ` · ${result.ms}ms` : ''}`);
    } catch (e) {
      setTestMsg(`✗ ${e.message}`);
    } finally {
      setTesting(false);
    }
  };

  const onPickRefs = async (event) => {
    const files = Array.from(event.target.files || []).filter(isImageFile);
    const skipped = (event.target.files?.length || 0) - files.length;
    event.target.value = '';
    if (!files.length) {
      flash?.(skipped ? '没有支持的格式（PNG/JPEG/WebP）' : '未选择文件');
      return;
    }
    if (!scope.userId) {
      flash?.('请先在顶部选择用户和角色');
      return;
    }
    setUploading(true);
    try {
      // 并行上传（最多 4 路），避免一张张串行卡住
      const results = await mapPool(files, 4, async (file, index) => {
        const data = await fileToBase64(file);
        const result = await api('/api/image-references', json('POST', {
          scope: { userId: scope.userId, companionId },
          mime: file.type,
          name: file.name,
          data,
          // 仅当前无参考且本批第一张成功时设头像
          isAvatar: refs.length === 0 && index === 0,
        }));
        if (!result.ok) throw new Error(result.message || `${file.name} 上传失败`);
        return result;
      });
      const okCount = results.filter(Boolean).length;
      flash?.(
        okCount
          ? `已并行上传 ${okCount} 张脸参考${skipped ? `（跳过 ${skipped} 个非图片）` : ''}`
          : '没有成功上传的图片',
      );
      await loadAll();
    } catch (e) {
      flash?.(e.message || '上传失败');
      await loadAll();
    } finally {
      setUploading(false);
    }
  };

  const setAvatar = async (item) => {
    if (!scope.userId) return;
    setBusyRefId(item.id);
    try {
      await api(`/api/image-references/${item.id}/avatar`, json('PATCH', {
        scope: { userId: scope.userId, companionId },
      }));
      flash?.('已设为脸锁头像');
      await loadAll();
    } catch (e) {
      flash?.(e.message);
    } finally {
      setBusyRefId('');
    }
  };

  const deleteRef = async (item) => {
    if (!scope.userId) return;
    if (!confirm('删除这张脸参考图？')) return;
    setBusyRefId(item.id);
    try {
      const result = await api(`/api/image-references/${item.id}?${qs({ userId: scope.userId, companionId })}`, {
        method: 'DELETE',
      });
      if (!result.ok) throw new Error(result.message || '删除失败');
      flash?.('已删除参考图');
      await loadAll();
    } catch (e) {
      flash?.(e.message);
    } finally {
      setBusyRefId('');
    }
  };

  return (
    <section className="panel outfit-image-setup">
      <div className="outfit-image-setup-head">
        <div>
          <span className="page-header-kicker">IMAGE · 脸锁</span>
          <h3>生图配置与脸参考</h3>
          <p>
            生成今日照片需要图片模型（IMAGE_*）和脸参考图。配置写入本机 .env；参考图按当前用户+角色保存。
          </p>
        </div>
        <div className="outfit-image-setup-badges">
          <span className={`badge ${imageReady ? 'badge-ok' : 'badge-warn'}`}>
            {imageReady ? `模型就绪${configMeta.IMAGE_MODEL?.value ? ` · ${configMeta.IMAGE_MODEL.value}` : ''}` : '模型未配置'}
          </span>
          <span className={`badge ${refsReady ? 'badge-ok' : 'badge-warn'}`}>
            {refsReady ? `${refs.length} 张脸参考` : '无脸参考'}
          </span>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-400">加载中…</p>
      ) : (
        <div className="outfit-image-setup-grid">
          <div className="outfit-image-setup-config">
            <h4>图片模型 IMAGE_*</h4>
            <div className="config-fields outfit-image-fields">
              {IMAGE_FIELD_KEYS.map((f) => {
                const meta = configMeta[f.key];
                const secretSet = Boolean(f.secret && meta?.set);
                return (
                  <label className="field" key={f.key}>
                    <span>
                      {f.label}
                      {secretSet && (
                        <em className="config-secret-set">
                          已配置{meta?.preview ? ` · ${meta.preview}` : ''}
                        </em>
                      )}
                    </span>
                    <input
                      className="input"
                      type={f.secret ? 'password' : 'text'}
                      autoComplete="off"
                      placeholder={f.placeholder}
                      value={values[f.key] ?? ''}
                      onChange={(e) => setField(f.key, e.target.value)}
                    />
                  </label>
                );
              })}
            </div>
            <div className="outfit-card-actions" style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-primary" disabled={saving || !Object.keys(dirty).length} onClick={saveConfig}>
                {saving ? <LoaderCircle size={14} className="animate-spin" /> : <Save size={14} />}
                保存生图配置
              </button>
              <button type="button" className="btn" disabled={testing} onClick={testImage}>
                {testing ? '测试中…' : '测试连接'}
              </button>
              <button type="button" className="btn" onClick={loadAll}>
                <RefreshCw size={14} />
                刷新
              </button>
            </div>
            {testMsg && (
              <div className={`config-test-msg ${testMsg.startsWith('✓') ? 'is-ok' : 'is-bad'}`} style={{ marginTop: 8 }}>
                {testMsg}
              </div>
            )}
          </div>

          <div className="outfit-image-setup-refs">
            <div className="mb-3 flex items-center justify-between gap-2 flex-wrap">
              <div>
                <h4>脸参考图</h4>
                <p className="mt-1 text-xs text-zinc-400">
                  上传正面清晰脸照；生成时优先头像 + 最多 3 张核心图锁脸。
                </p>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!scope.userId || uploading}
                onClick={() => refInput.current?.click()}
              >
                {uploading ? <LoaderCircle size={14} className="animate-spin" /> : <Upload size={14} />}
                {uploading ? '上传中…' : '上传参考图'}
              </button>
              <input
                ref={refInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                hidden
                onChange={onPickRefs}
              />
            </div>
            {!scope.userId ? (
              <p className="text-sm text-amber-700">请先在顶部选择用户和角色，才能上传脸参考。</p>
            ) : refs.length ? (
              <div className="photo-wall outfit-ref-wall">
                {refs.map((item) => (
                  <div className={`photo-tile ${item.isAvatar ? 'is-avatar' : ''}`} key={item.id}>
                    <img src={item.url} alt={item.name || '脸参考'} />
                    {item.isAvatar ? <b>当前头像</b> : (
                      <em
                        onClick={() => !busyRefId && setAvatar(item)}
                        style={{ opacity: busyRefId === item.id ? 0.5 : 1 }}
                      >
                        设为头像
                      </em>
                    )}
                    <em
                      onClick={() => !busyRefId && deleteRef(item)}
                      style={{ color: 'var(--sw-danger, #b91c1c)', opacity: busyRefId === item.id ? 0.5 : 1 }}
                    >
                      删除
                    </em>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-zinc-400">还没有脸参考。点「上传参考图」选 1～数张正面清晰照片。</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** 可点击复制的标题 / 单品名 */
function CopyableName({ text, className = '', as: Tag = 'span', title, onCopied }) {
  const [flash, setFlash] = useState(false);
  const value = String(text || '').trim();
  if (!value) return null;
  const copy = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setFlash(true);
      onCopied?.(value);
      setTimeout(() => setFlash(false), 1200);
    } catch {
      /* ignore */
    }
  };
  return (
    <Tag
      className={`copyable-name ${flash ? 'is-copied' : ''} ${className}`.trim()}
      onClick={copy}
      title={title || `点击复制：${value}`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          copy(e);
        }
      }}
    >
      {flash ? '已复制' : value}
    </Tag>
  );
}

function OutfitFlipCard({
  card,
  worn,
  onWear,
  onSavePrompt,
  onUpload,
  onClearImage,
  onDeleteCustom,
  wearing,
  busyId,
  onNameCopied,
}) {
  const [flipped, setFlipped] = useState(false);
  const [prompt, setPrompt] = useState(card.prompt || '');
  const [copied, setCopied] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const inputRef = useRef(null);
  const isBusy = busyId === card.id;

  useEffect(() => { setPrompt(card.prompt || ''); }, [card.prompt, card.id]);

  const pieceEntries = useMemo(() => {
    const p = card.pieces && typeof card.pieces === 'object' ? card.pieces : {};
    const labels = {
      dress: '裙', top: '上', bottom: '下', outer: '外', shoes: '鞋', bag: '包',
      jewelry: '饰', watch: '表', hair: '发', makeup: '妆', accessories: '配',
    };
    return Object.entries(p)
      .filter(([, v]) => v != null && String(v).trim())
      .map(([k, v]) => ({
        key: k,
        label: labels[k] || k,
        value: Array.isArray(v) ? v.join('、') : String(v),
      }))
      .slice(0, 8);
  }, [card.pieces]);

  const copyPrompt = async (event) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(prompt || card.prompt || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  };

  const savePrompt = async (event) => {
    event.stopPropagation();
    await onSavePrompt(card, prompt);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1400);
  };

  const pickImage = (event) => {
    event.stopPropagation();
    inputRef.current?.click();
  };

  const onFile = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    // 支持多选：交给上层（可并行挂到本卡主图，或系列批量）
    if (typeof onUpload === 'function') {
      await onUpload(card, files.length === 1 ? files[0] : files);
    }
  };

  const initials = (card.title || '?').slice(0, 1);

  return (
    <article className={`outfit-card ${flipped ? 'is-flipped' : ''} ${worn ? 'is-worn' : ''} ${card.hasImage ? 'has-image' : ''}`}>
      <div className="outfit-card-inner">
        <div className="outfit-card-face outfit-card-front">
          <button
            type="button"
            className="outfit-card-media"
            onClick={() => setFlipped(true)}
            aria-label={`${card.title} · 点开看提示词`}
          >
            {card.imageUrl
              ? <img src={card.imageUrl} alt={card.title} />
              : (
                <div className="outfit-card-placeholder" data-kind={card.kind}>
                  <span className="outfit-card-mark">{initials}</span>
                  <small>待生成图片</small>
                </div>
              )}
            {worn && <b className="outfit-card-worn-badge">此刻穿着</b>}
            {card.hasImage && <em className="outfit-card-image-dot" aria-hidden="true" />}
          </button>
          <div className="outfit-card-meta">
            <div className="outfit-card-kicker">
              <span>{card.subtitle || card.kind}</span>
              {card.source === 'custom' && <span className="outfit-chip">自定义</span>}
              {card.seriesId && (
                <span className="outfit-chip">
                  系列{card.seriesIndex != null ? ` ${card.seriesIndex}` : ''}
                </span>
              )}
              {card.context && <span className="outfit-chip">{CONTEXT_LABEL[card.context] || card.context}</span>}
            </div>
            <h4>
              <CopyableName
                text={card.title}
                className="copyable-title"
                onCopied={onNameCopied}
              />
            </h4>
            <p className="outfit-card-summary">
              {card.summary ? (
                <CopyableName text={card.summary} className="copyable-summary" onCopied={onNameCopied} />
              ) : '—'}
            </p>
            {pieceEntries.length > 0 && (
              <div className="outfit-card-tags outfit-piece-chips">
                {pieceEntries.map((item) => (
                  <CopyableName
                    key={item.key}
                    text={item.value}
                    className="outfit-piece-chip"
                    title={`点击复制${item.label}：${item.value}`}
                    onCopied={onNameCopied}
                  />
                ))}
              </div>
            )}
            {pieceEntries.length === 0 && (card.tags || []).slice(0, 3).length > 0 && (
              <div className="outfit-card-tags">
                {card.tags.slice(0, 3).map((tag) => (
                  <CopyableName key={tag} text={tag} onCopied={onNameCopied} />
                ))}
              </div>
            )}
          </div>
          <button type="button" className="outfit-card-hint" onClick={() => setFlipped(true)}>
            点标题/单品名复制 · 点图或此处翻转看提示词
          </button>
        </div>

        <div className="outfit-card-face outfit-card-back">
          <div className="outfit-card-back-head">
            <button type="button" className="outfit-card-back-flipzone" onClick={() => setFlipped(false)} aria-label="翻回正面">
              <div>
                <span className="outfit-card-kicker">IMAGE PROMPT</span>
                <strong onClick={(e) => e.stopPropagation()}>
                  <CopyableName text={card.title} className="copyable-title" onCopied={onNameCopied} />
                </strong>
              </div>
            </button>
            <button type="button" className="outfit-icon-btn" onClick={(e) => { e.stopPropagation(); setFlipped(false); }} aria-label="关闭背面">
              <X size={15} />
            </button>
          </div>
          <textarea
            className="outfit-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            spellCheck={false}
            rows={8}
          />
          <div className="outfit-card-actions" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="btn" onClick={copyPrompt} title="复制提示词">
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? '已复制' : '复制'}
            </button>
            <button type="button" className="btn" onClick={savePrompt} disabled={isBusy}>
              {savedFlash ? <Check size={14} /> : <WandSparkles size={14} />}
              {savedFlash ? '已存' : '存提示词'}
            </button>
            <button type="button" className="btn" onClick={pickImage} disabled={isBusy}>
              {isBusy ? <LoaderCircle size={14} className="animate-spin" /> : <Upload size={14} />}
              上传图
            </button>
            {card.hasImage && (
              <button type="button" className="btn" onClick={() => onClearImage(card)} disabled={isBusy}>
                清图
              </button>
            )}
            {card.wearable && (
              <button
                type="button"
                className={`btn ${worn ? 'btn-ghost' : 'btn-primary'}`}
                onClick={() => onWear(card)}
                disabled={wearing || worn}
              >
                <Shirt size={14} />
                {worn ? '已上身' : wearing ? '上身中' : '上身'}
              </button>
            )}
            {card.source === 'custom' && onDeleteCustom && (
              <button
                type="button"
                className="btn"
                onClick={() => onDeleteCustom(card)}
                disabled={isBusy}
                title="删除自定义造型"
              >
                <Trash2 size={14} />
                删除
              </button>
            )}
          </div>
          <button type="button" className="outfit-card-flip-hint" onClick={() => setFlipped(false)}>点击标题或此处翻回正面</button>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            onChange={onFile}
          />
        </div>
      </div>
    </article>
  );
}

export default function OutfitPage({ scope, api, qs, json, Header, Loading, ErrorBox, Empty }) {
  const companionId = scope.companionId || 'default';
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [daily, setDaily] = useState(null);
  const [tab, setTab] = useState('looks');
  const [query, setQuery] = useState('');
  const [busyIds, setBusyIds] = useState(() => new Set());
  const [wearingId, setWearingId] = useState('');
  const [dailyBusy, setDailyBusy] = useState('');
  const [toast, setToast] = useState('');
  const [bulkUploading, setBulkUploading] = useState(false);
  const bulkInputRef = useRef(null);
  const [imageReadyState, setImageReadyState] = useState({ imageReady: false, refsReady: false, refCount: 0, model: '' });
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const markBusy = (id, on) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [parsePreview, setParsePreview] = useState(null);
  const [seriesFilter, setSeriesFilter] = useState('');
  const [draft, setDraft] = useState({
    title: '',
    summary: '',
    context: 'date',
    dress: '',
    top: '',
    bottom: '',
    shoes: '',
    bag: '',
    prompt: '',
  });

  const load = async () => {
    setState((s) => ({ ...s, loading: true, error: '' }));
    try {
      const data = await api(`/api/outfit?${qs({ userId: scope.userId || '', companionId })}`);
      setState({ loading: false, data, error: '' });
      if (scope.userId) {
        const d = await api(`/api/outfit/daily?${qs({ userId: scope.userId, companionId })}`).catch(() => null);
        if (d?.ok) setDaily(d);
      } else {
        setDaily(null);
      }
    } catch (e) {
      setState({ loading: false, data: null, error: e.message });
    }
  };

  useEffect(() => { load(); }, [scope.userId, companionId]);

  const flash = (message) => {
    setToast(message);
    setTimeout(() => setToast(''), 2200);
  };

  const onNameCopied = (text) => {
    const short = String(text || '').length > 28 ? `${String(text).slice(0, 28)}…` : text;
    flash(`已复制：${short}`);
  };

  const current = state.data?.current;
  const currentLookId = current?.current?.id || null;

  const seriesOptions = useMemo(() => {
    const looks = state.data?.looks || [];
    const map = new Map();
    for (const c of looks) {
      if (!c.seriesId) continue;
      if (!map.has(c.seriesId)) {
        map.set(c.seriesId, { id: c.seriesId, title: c.seriesTitle || c.seriesId, count: 0 });
      }
      map.get(c.seriesId).count += 1;
    }
    return [...map.values()];
  }, [state.data]);

  const cards = useMemo(() => {
    let list = state.data?.[tab] || [];
    if (tab === 'looks' && seriesFilter) {
      list = list.filter((c) => c.seriesId === seriesFilter);
    }
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((card) => {
      const blob = [card.title, card.subtitle, card.summary, card.prompt, ...(card.tags || [])].join(' ').toLowerCase();
      return blob.includes(q);
    });
  }, [state.data, tab, query, seriesFilter]);

  const counts = state.data?.counts || {};

  const onSavePrompt = async (card, prompt) => {
    markBusy(card.id, true);
    try {
      const result = await api('/api/outfit/card', json('PUT', { companionId, cardId: card.id, prompt }));
      if (!result.ok) throw new Error(result.message || '保存失败');
      flash('提示词已保存');
      await load();
    } catch (e) {
      flash(e.message);
    } finally {
      markBusy(card.id, false);
    }
  };

  const uploadOneCardImage = async (card, file) => {
    const data = await fileToBase64(file);
    const result = await api('/api/outfit/card/image', json('POST', {
      companionId,
      cardId: card.id,
      mime: file.type,
      name: file.name,
      data,
    }));
    if (!result.ok) throw new Error(result.message || `${file.name} 上传失败`);
    return result;
  };

  /** 单卡一张或多张：多张时并行上传，仅最后一张保留为主图（同卡 id）→ 多张请用系列批量 */
  const onUpload = async (card, fileOrFiles) => {
    const files = (Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles]).filter(isImageFile);
    if (!files.length) {
      flash('请选择 PNG / JPEG / WebP');
      return;
    }
    markBusy(card.id, true);
    try {
      if (files.length === 1) {
        await uploadOneCardImage(card, files[0]);
        flash('图片已挂上正面');
      } else {
        // 同卡多图：并行传完，用最后一张作正面（同 cardId 会覆盖）
        await mapPool(files, 3, async (file) => uploadOneCardImage(card, file));
        flash(`已并行上传 ${files.length} 张（同卡最终显示最后一张）。系列请用「批量挂到系列」按序分配`);
      }
      await load();
    } catch (e) {
      flash(e.message);
      await load();
    } finally {
      markBusy(card.id, false);
    }
  };

  /** 系列筛选下：多选图片按序号并行挂到系列各卡 */
  const onBulkSeriesUpload = async (event) => {
    const files = Array.from(event.target.files || []).filter(isImageFile);
    event.target.value = '';
    if (!files.length) return;
    if (!seriesFilter) {
      flash('请先筛选一个系列，再批量上传');
      return;
    }
    const seriesCards = [...(state.data?.looks || [])]
      .filter((c) => c.seriesId === seriesFilter)
      .sort((a, b) => (a.seriesIndex || 0) - (b.seriesIndex || 0));
    if (!seriesCards.length) {
      flash('当前系列没有造型卡');
      return;
    }
    setBulkUploading(true);
    try {
      const pairs = files.slice(0, seriesCards.length).map((file, i) => ({ file, card: seriesCards[i] }));
      if (files.length > seriesCards.length) {
        flash(`选了 ${files.length} 张，系列只有 ${seriesCards.length} 卡，多出的已忽略`);
      }
      const results = await mapPool(pairs, 4, async ({ file, card }) => {
        markBusy(card.id, true);
        try {
          await uploadOneCardImage(card, file);
          return { ok: true, title: card.title };
        } finally {
          markBusy(card.id, false);
        }
      });
      const ok = results.filter((r) => r?.ok).length;
      flash(`系列已并行挂图 ${ok}/${pairs.length} 张`);
      await load();
    } catch (e) {
      flash(e.message || '批量上传失败');
      await load();
    } finally {
      setBulkUploading(false);
    }
  };

  const onClearImage = async (card) => {
    if (!confirm('清除这张卡片的正面图？')) return;
    markBusy(card.id, true);
    try {
      const result = await api('/api/outfit/card/image', json('DELETE', { companionId, cardId: card.id }));
      if (!result.ok) throw new Error(result.message || '清除失败');
      flash('已清除图片');
      await load();
    } catch (e) {
      flash(e.message);
    } finally {
      markBusy(card.id, false);
    }
  };

  const onWear = async (card) => {
    if (!scope.userId) {
      flash('请先在顶部选择用户，才能写入当前穿着');
      return;
    }
    if (!card.lookId) return;
    setWearingId(card.id);
    try {
      const result = await api('/api/outfit/wear', json('POST', {
        scope: { userId: scope.userId, companionId },
        lookId: card.lookId,
      }));
      if (!result.ok) throw new Error(result.message || '上身失败');
      flash(result.message || '已上身');
      await load();
    } catch (e) {
      flash(e.message);
    } finally {
      setWearingId('');
    }
  };

  const onCreateLook = async () => {
    if (!draft.title.trim() && !draft.summary.trim()) {
      flash('请填写造型标题或摘要');
      return;
    }
    setCreating(true);
    try {
      const pieces = {};
      if (draft.dress.trim()) pieces.dress = draft.dress.trim();
      if (draft.top.trim()) pieces.top = draft.top.trim();
      if (draft.bottom.trim()) pieces.bottom = draft.bottom.trim();
      if (draft.shoes.trim()) pieces.shoes = draft.shoes.trim();
      if (draft.bag.trim()) pieces.bag = draft.bag.trim();
      const result = await api('/api/outfit/looks', json('POST', {
        companionId,
        title: draft.title.trim() || draft.summary.trim().slice(0, 24),
        style: draft.title.trim() || draft.summary.trim().slice(0, 24),
        summary: draft.summary.trim() || draft.title.trim(),
        context: draft.context,
        pieces,
        shoes: draft.shoes.trim(),
        bag: draft.bag.trim(),
        dress: draft.dress.trim(),
        top: draft.top.trim(),
        bottom: draft.bottom.trim(),
        prompt: draft.prompt.trim(),
      }));
      if (!result.ok) throw new Error(result.message || '创建失败');
      flash(result.message || '已创建造型');
      setShowCreate(false);
      setDraft({
        title: '', summary: '', context: 'date',
        dress: '', top: '', bottom: '', shoes: '', bag: '', prompt: '',
      });
      setTab('looks');
      await load();
    } catch (e) {
      flash(e.message);
    } finally {
      setCreating(false);
    }
  };

  const onDeleteCustom = async (card) => {
    if (!card.lookId || card.source !== 'custom') return;
    if (!confirm(`删除自定义造型「${card.title}」？正面图和提示词会一并清理。`)) return;
    markBusy(card.id, true);
    try {
      const result = await api('/api/outfit/looks', json('DELETE', {
        companionId,
        lookId: card.lookId,
      }));
      if (!result.ok) throw new Error(result.message || '删除失败');
      flash(result.message || '已删除');
      await load();
    } catch (e) {
      flash(e.message);
    } finally {
      markBusy(card.id, false);
    }
  };

  const onParseSeries = async () => {
    if (!importText.trim()) {
      flash('请先粘贴系列提示词');
      return;
    }
    setImporting(true);
    setParsePreview(null);
    try {
      const result = await api('/api/outfit/looks/parse-series', json('POST', {
        text: importText,
        useLlm: true,
      }));
      if (!result.ok) throw new Error(result.message || '识别失败');
      setParsePreview(result);
      flash(result.message || `识别到 ${result.count} 套`);
    } catch (e) {
      flash(e.message);
    } finally {
      setImporting(false);
    }
  };

  const onImportSeries = async () => {
    if (!importText.trim() && !parsePreview?.looks?.length) {
      flash('请先粘贴系列提示词');
      return;
    }
    setImporting(true);
    try {
      const result = await api('/api/outfit/looks/import-series', json('POST', {
        companionId,
        text: importText,
        useLlm: true,
        parsed: parsePreview?.looks ? {
          seriesTitle: parsePreview.seriesTitle,
          seriesId: parsePreview.seriesId,
          looks: parsePreview.looks,
          method: parsePreview.method,
        } : undefined,
      }));
      if (!result.ok) throw new Error(result.message || '导入失败');
      flash(result.message || `已创建 ${result.count} 张`);
      setShowImport(false);
      setImportText('');
      setParsePreview(null);
      if (result.seriesId) setSeriesFilter(result.seriesId);
      setTab('looks');
      await load();
    } catch (e) {
      flash(e.message);
    } finally {
      setImporting(false);
    }
  };

  const onRecomposeDaily = async () => {
    if (!scope.userId) {
      flash('请先选择用户');
      return;
    }
    setDailyBusy('compose');
    try {
      const result = await api('/api/outfit/daily', json('POST', {
        scope: { userId: scope.userId, companionId },
      }));
      if (!result.ok) throw new Error(result.message || '重组失败');
      flash(result.message || '已重组今日穿搭');
      await load();
    } catch (e) {
      flash(e.message);
    } finally {
      setDailyBusy('');
    }
  };

  const onGenerateDailyPhoto = async (force = false) => {
    if (!scope.userId) {
      flash('请先选择用户');
      return;
    }
    if (!imageReadyState.imageReady) {
      flash('请先在下方配置 IMAGE 模型并保存');
      return;
    }
    if (!imageReadyState.refsReady) {
      flash('建议先上传脸参考图（下方），否则脸可能不稳定');
    }
    setDailyBusy('photo');
    flash('正在生成今日照片，gpt-image 全身图通常要 1～3 分钟，请稍候…');
    try {
      const result = await api('/api/outfit/daily/photo', json('POST', {
        scope: { userId: scope.userId, companionId },
        force,
      }));
      if (!result.ok) throw new Error(result.message || '生成失败');
      flash(result.message || (result.skipped ? '今日成片已存在' : '今日成片已生成'));
      await load();
    } catch (e) {
      flash(e.message || '生成失败');
    } finally {
      setDailyBusy('');
    }
  };

  if (state.loading && !state.data) return <Loading />;
  if (state.error) return <ErrorBox error={state.error} />;

  const d = state.data || {};
  const meta = KIND_META[tab];
  const dailyPieces = daily?.pieces || daily?.outfit?.current?.pieces || {};
  const dailyChips = [
    dailyPieces.dress || [dailyPieces.top, dailyPieces.bottom].filter(Boolean).join(' + '),
    dailyPieces.outer,
    dailyPieces.shoes,
    dailyPieces.bag,
    dailyPieces.watch,
    dailyPieces.jewelry,
  ].filter(Boolean);

  return (
    <div className="outfit-page">
      <Header
        title="穿搭系统"
        text="每日自动从衣橱+包柜/鞋柜组合今日穿搭，可用已接入的生图模型出「今日成片」；单品卡仍是产品图，整套/日更是人像。侧栏「穿搭相册」看上身效果。"
        action={(
          <button className="btn" onClick={load}>
            <RefreshCw size={15} />
            刷新
          </button>
        )}
      />

      <section className="outfit-now panel">
        <div className="outfit-now-copy">
          <span className="page-header-kicker">TODAY · 今日穿搭</span>
          <h3>{daily?.summary || current?.current?.summary || '尚未组合今日造型'}</h3>
          <p>
            {daily?.dailyKey ? `日键 ${daily.dailyKey}` : ''}
            {(daily?.outfit?.context || current?.context)
              ? ` · 情境 ${CONTEXT_LABEL[daily?.outfit?.context || current?.context] || daily?.outfit?.context || current?.context}`
              : ''}
            {daily?.composedFrom?.lookId ? ` · look ${daily.composedFrom.lookId}` : ''}
            {daily?.hasPhoto ? ' · 成片已生成' : ' · 成片待生成'}
          </p>
          {dailyChips.length > 0 && (
            <div className="outfit-card-tags" style={{ marginTop: 8 }}>
              {dailyChips.slice(0, 6).map((t) => (
                <CopyableName key={t} text={t} onCopied={onNameCopied} />
              ))}
            </div>
          )}
          <div className="outfit-card-actions" style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn"
              disabled={!scope.userId || Boolean(dailyBusy)}
              onClick={onRecomposeDaily}
            >
              {dailyBusy === 'compose' ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              重新组合今日
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!scope.userId || Boolean(dailyBusy) || !imageReadyState.imageReady}
              onClick={() => onGenerateDailyPhoto(Boolean(daily?.hasPhoto))}
              title={!imageReadyState.imageReady ? '请先配置下方 IMAGE 模型' : undefined}
            >
              {dailyBusy === 'photo' ? <LoaderCircle size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {dailyBusy === 'photo'
                ? '生成中 1～3 分钟…'
                : (daily?.hasPhoto ? '重新生成今日照片' : '生成今日照片')}
            </button>
          </div>
          {dailyBusy === 'photo' && (
            <p className="mt-2 text-xs text-zinc-500">模型在画全身成片，请不要关闭页面；失败会自动降级重试。</p>
          )}
          {!imageReadyState.imageReady && (
            <p className="mt-2 text-xs text-amber-700">生图未就绪：请在下方填写 IMAGE_MODEL / API Key 并保存。</p>
          )}
          {imageReadyState.imageReady && !imageReadyState.refsReady && (
            <p className="mt-2 text-xs text-amber-700">还没有脸参考：请在下方上传正面清晰照片，锁脸更稳。</p>
          )}
        </div>
        <div className="outfit-now-media">
          {daily?.photo?.url ? (
            <img src={daily.photo.url} alt="今日穿搭成片" style={{ maxWidth: 160, borderRadius: 12 }} />
          ) : (
            <div className="outfit-now-stats">
              <div><b>{counts.looks || 0}</b><span>造型</span></div>
              <div><b>{counts.shoes || 0}</b><span>鞋</span></div>
              <div><b>{counts.bags || 0}</b><span>包</span></div>
              <div><b>{counts.jewelry || 0}</b><span>珠宝</span></div>
              <div><b>{counts.beauty || 0}</b><span>美妆</span></div>
              <div><b>{counts.lingerie || 0}</b><span>内衣</span></div>
            </div>
          )}
        </div>
      </section>

      <ImageGenAndFacePanel
        scope={scope}
        api={api}
        qs={qs}
        json={json}
        flash={flash}
        onReadyChange={setImageReadyState}
      />

      {(d.style || d.beautyNotes) && (
        <section className="outfit-style-note panel">
          {d.style && <p><strong>衣橱气质</strong>{d.style}</p>}
          {d.beautyNotes && <p><strong>妆台</strong>{d.beautyNotes}</p>}
        </section>
      )}

      <div className="outfit-toolbar">
        <div className="outfit-tabs" role="tablist">
          {Object.entries(KIND_META).map(([id, item]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`outfit-tab ${tab === id ? 'is-active' : ''}`}
              onClick={() => setTab(id)}
            >
              <strong>{item.label}</strong>
              <small>{counts[id] ?? 0}</small>
            </button>
          ))}
        </div>
        <label className="outfit-search">
          <span className="sr-only">搜索</span>
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`搜索${meta.label}…`}
          />
        </label>
      </div>

      <div className="outfit-section-head">
        <div>
          <h3>{meta.label}</h3>
          <p>
            {meta.hint}
            {tab === 'looks' ? ' · 可新建自定义造型 · 点卡片翻转存提示词/上传图 · 可上身' : ' · 点卡片翻转看提示词 · 生成后上传挂正面'}
          </p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          {tab === 'looks' && (
            <>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => { setShowImport((v) => !v); setShowCreate(false); }}
              >
                <Sparkles size={15} />
                {showImport ? '收起导入' : '导入系列提示词'}
              </button>
              <button type="button" className="btn" onClick={() => { setShowCreate((v) => !v); setShowImport(false); }}>
                <Plus size={15} />
                {showCreate ? '收起' : '新建造型'}
              </button>
            </>
          )}
          <span className="badge">{cards.length} 张卡片</span>
        </div>
      </div>

      {tab === 'looks' && seriesOptions.length > 0 && (
        <div className="outfit-series-filter mb-3 flex flex-wrap gap-2 items-center">
          <span className="text-xs text-zinc-400">系列小相册</span>
          <button
            type="button"
            className={`outfit-chip-btn ${!seriesFilter ? 'is-active' : ''}`}
            onClick={() => setSeriesFilter('')}
          >
            全部
          </button>
          {seriesOptions.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`outfit-chip-btn ${seriesFilter === s.id ? 'is-active' : ''}`}
              onClick={() => setSeriesFilter(s.id)}
            >
              {s.title} · {s.count} 张
            </button>
          ))}
          {seriesFilter && (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={bulkUploading}
                onClick={() => bulkInputRef.current?.click()}
              >
                {bulkUploading ? <LoaderCircle size={14} className="animate-spin" /> : <Upload size={14} />}
                {bulkUploading ? '并行上传中…' : '批量挂图到系列'}
              </button>
              <input
                ref={bulkInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                hidden
                onChange={onBulkSeriesUpload}
              />
              <span className="text-xs text-zinc-400">多选按 1…N 顺序并行挂到各卡</span>
            </>
          )}
        </div>
      )}

      {tab === 'looks' && showImport && (
        <section className="panel outfit-import-series mb-4">
          <div className="mb-3">
            <span className="page-header-kicker">SERIES IMPORT · DEEPSEEK</span>
            <h3 className="mt-1 text-base font-bold">粘贴系列提示词 → 自动拆成多张造型卡</h3>
            <p className="mt-1 text-xs text-zinc-400">
              支持「1 暖灰针织… 2 酒红…」格式。用 DeepSeek 识别每张的裙/鞋/包/发，并生成独立出图提示词填入卡片背面。
              导入后形成系列小相册（筛选查看）；每张卡仍是正面图 + 背面提示词，可上身、可上传成片。
            </p>
          </div>
          <label className="field">
            <span>完整系列提示词</span>
            <textarea
              className="input outfit-import-textarea"
              rows={12}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder="粘贴整段系列提示词（含编号 1～8 的造型描述）…"
              spellCheck={false}
            />
          </label>
          <div className="mt-3 flex gap-2 flex-wrap">
            <button type="button" className="btn" disabled={importing || !importText.trim()} onClick={onParseSeries}>
              {importing ? <LoaderCircle size={14} className="animate-spin" /> : <WandSparkles size={14} />}
              仅识别预览
            </button>
            <button type="button" className="btn btn-primary" disabled={importing || !importText.trim()} onClick={onImportSeries}>
              {importing ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={14} />}
              识别并创建全部卡片
            </button>
            <button type="button" className="btn" onClick={() => { setShowImport(false); setParsePreview(null); }}>取消</button>
          </div>
          {parsePreview?.looks?.length > 0 && (
            <div className="outfit-parse-preview mt-4">
              <div className="flex items-center justify-between gap-2 mb-2">
                <strong className="text-sm">
                  预览 · {parsePreview.seriesTitle} · {parsePreview.count} 张
                  <em className="ml-2 text-xs font-normal text-zinc-400">
                    {parsePreview.method}
                    {parsePreview.llmError ? `（${parsePreview.llmError}）` : ''}
                  </em>
                </strong>
              </div>
              <ol className="outfit-parse-list">
                {parsePreview.looks.map((look) => (
                  <li key={look.index || look.title}>
                    <b>
                      {look.index}.{' '}
                      <CopyableName text={look.title} onCopied={onNameCopied} />
                    </b>
                    {look.summary && (
                      <span>
                        <CopyableName text={look.summary} onCopied={onNameCopied} />
                      </span>
                    )}
                    <small className="outfit-piece-chips">
                      {[
                        look.pieces?.dress,
                        look.pieces?.top,
                        look.pieces?.outer,
                        look.pieces?.shoes,
                        look.pieces?.bag,
                        look.pieces?.hair,
                      ].filter(Boolean).map((name) => (
                        <CopyableName key={name} text={name} className="outfit-piece-chip" onCopied={onNameCopied} />
                      ))}
                    </small>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      )}

      {tab === 'looks' && showCreate && (
        <section className="panel outfit-create-look mb-4">
          <div className="mb-3">
            <span className="page-header-kicker">NEW LOOK</span>
            <h3 className="mt-1 text-base font-bold">创建整套造型卡</h3>
            <p className="mt-1 text-xs text-zinc-400">
              与系统造型一样：可上身、可存提示词、可上传正面图。自定义保存在本机角色目录。
            </p>
          </div>
          <div className="outfit-create-grid">
            <label className="field">
              <span>标题 *</span>
              <input className="input" value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} placeholder="例如：酒红晚宴裹身裙" />
            </label>
            <label className="field">
              <span>情境</span>
              <select className="input" value={draft.context} onChange={(e) => setDraft((d) => ({ ...d, context: e.target.value }))}>
                {Object.entries(CONTEXT_LABEL).map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
            </label>
            <label className="field outfit-create-full">
              <span>摘要 / 穿着描述</span>
              <textarea className="input" rows={2} value={draft.summary} onChange={(e) => setDraft((d) => ({ ...d, summary: e.target.value }))} placeholder="一整句描述她穿什么、什么场合" />
            </label>
            <label className="field">
              <span>裙装</span>
              <input className="input" value={draft.dress} onChange={(e) => setDraft((d) => ({ ...d, dress: e.target.value }))} placeholder="可选" />
            </label>
            <label className="field">
              <span>上衣</span>
              <input className="input" value={draft.top} onChange={(e) => setDraft((d) => ({ ...d, top: e.target.value }))} placeholder="可选" />
            </label>
            <label className="field">
              <span>下装</span>
              <input className="input" value={draft.bottom} onChange={(e) => setDraft((d) => ({ ...d, bottom: e.target.value }))} placeholder="可选" />
            </label>
            <label className="field">
              <span>鞋</span>
              <input className="input" value={draft.shoes} onChange={(e) => setDraft((d) => ({ ...d, shoes: e.target.value }))} placeholder="可选，建议写明" />
            </label>
            <label className="field">
              <span>包</span>
              <input className="input" value={draft.bag} onChange={(e) => setDraft((d) => ({ ...d, bag: e.target.value }))} placeholder="可选" />
            </label>
            <label className="field outfit-create-full">
              <span>出图提示词（可选，可建卡后再编辑）</span>
              <textarea className="input" rows={4} value={draft.prompt} onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))} placeholder="英文/中文均可；不填则按摘要自动生成人像套装提示词" spellCheck={false} />
            </label>
          </div>
          <div className="mt-3 flex gap-2 flex-wrap">
            <button type="button" className="btn btn-primary" disabled={creating} onClick={onCreateLook}>
              {creating ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={14} />}
              {creating ? '创建中…' : '创建并加入造型柜'}
            </button>
            <button type="button" className="btn" onClick={() => setShowCreate(false)}>取消</button>
          </div>
        </section>
      )}

      {cards.length ? (
        <div className="outfit-grid">
          {cards.map((card) => (
            <OutfitFlipCard
              key={card.id}
              card={card}
              worn={Boolean(card.wearable && card.lookId && card.lookId === currentLookId)}
              onWear={onWear}
              onSavePrompt={onSavePrompt}
              onUpload={onUpload}
              onClearImage={onClearImage}
              onDeleteCustom={onDeleteCustom}
              onNameCopied={onNameCopied}
              wearing={wearingId === card.id}
              busyId={busyIds.has(card.id) ? card.id : ''}
            />
          ))}
        </div>
      ) : (
        <Empty>{query ? '没有匹配的卡片' : meta.empty}</Empty>
      )}

      <section className="outfit-howto panel">
        <div className="outfit-howto-icon"><ImagePlus size={18} /><Sparkles size={18} /></div>
        <div>
          <h3>使用方式</h3>
          <ol>
            <li>整套造型可点「新建造型」：填描述、提示词，再上传正面图，效果与系统卡相同（可上身）</li>
            <li>在「生图配置与脸参考」填 IMAGE 模型并上传脸照</li>
            <li>每天自动从衣橱 + 包/鞋抽屉组合「今日穿搭」；可点「生成今日照片」</li>
            <li>单品卡是产品图；对话问穿什么按当前穿着 / 今日组合答</li>
          </ol>
        </div>
      </section>

      {toast && <div className="outfit-toast" role="status">{toast}</div>}
    </div>
  );
}
