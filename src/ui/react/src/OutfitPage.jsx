import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check, Copy, ImagePlus, LoaderCircle, RefreshCw, Shirt, Sparkles, Upload, WandSparkles, X,
} from 'lucide-react';

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

function OutfitFlipCard({
  card,
  worn,
  onWear,
  onSavePrompt,
  onUpload,
  onClearImage,
  wearing,
  busyId,
}) {
  const [flipped, setFlipped] = useState(false);
  const [prompt, setPrompt] = useState(card.prompt || '');
  const [copied, setCopied] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const inputRef = useRef(null);
  const isBusy = busyId === card.id;

  useEffect(() => { setPrompt(card.prompt || ''); }, [card.prompt, card.id]);

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
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await onUpload(card, file);
  };

  const initials = (card.title || '?').slice(0, 1);

  return (
    <article className={`outfit-card ${flipped ? 'is-flipped' : ''} ${worn ? 'is-worn' : ''} ${card.hasImage ? 'has-image' : ''}`}>
      <div className="outfit-card-inner">
        <button type="button" className="outfit-card-face outfit-card-front" onClick={() => setFlipped(true)} aria-label={`${card.title} · 点开看提示词`}>
          <div className="outfit-card-media">
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
          </div>
          <div className="outfit-card-meta">
            <div className="outfit-card-kicker">
              <span>{card.subtitle || card.kind}</span>
              {card.context && <span className="outfit-chip">{CONTEXT_LABEL[card.context] || card.context}</span>}
            </div>
            <h4>{card.title}</h4>
            <p>{card.summary || '—'}</p>
            {(card.tags || []).slice(0, 3).length > 0 && (
              <div className="outfit-card-tags">
                {card.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}
              </div>
            )}
          </div>
          <div className="outfit-card-hint">点击翻转 · 看 AI 提示词</div>
        </button>

        <div className="outfit-card-face outfit-card-back">
          <div className="outfit-card-back-head">
            <button type="button" className="outfit-card-back-flipzone" onClick={() => setFlipped(false)} aria-label="翻回正面">
              <div>
                <span className="outfit-card-kicker">IMAGE PROMPT</span>
                <strong>{card.title}</strong>
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
          </div>
          <button type="button" className="outfit-card-flip-hint" onClick={() => setFlipped(false)}>点击标题或此处翻回正面</button>
          <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={onFile} />
        </div>
      </div>
    </article>
  );
}

export default function OutfitPage({ scope, api, qs, json, Header, Loading, ErrorBox, Empty }) {
  const companionId = scope.companionId || 'default';
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [tab, setTab] = useState('looks');
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState('');
  const [wearingId, setWearingId] = useState('');
  const [toast, setToast] = useState('');

  const load = async () => {
    setState((s) => ({ ...s, loading: true, error: '' }));
    try {
      const data = await api(`/api/outfit?${qs({ userId: scope.userId || '', companionId })}`);
      setState({ loading: false, data, error: '' });
    } catch (e) {
      setState({ loading: false, data: null, error: e.message });
    }
  };

  useEffect(() => { load(); }, [scope.userId, companionId]);

  const flash = (message) => {
    setToast(message);
    setTimeout(() => setToast(''), 2200);
  };

  const current = state.data?.current;
  const currentLookId = current?.current?.id || null;

  const cards = useMemo(() => {
    const list = state.data?.[tab] || [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((card) => {
      const blob = [card.title, card.subtitle, card.summary, card.prompt, ...(card.tags || [])].join(' ').toLowerCase();
      return blob.includes(q);
    });
  }, [state.data, tab, query]);

  const counts = state.data?.counts || {};

  const onSavePrompt = async (card, prompt) => {
    setBusyId(card.id);
    try {
      const result = await api('/api/outfit/card', json('PUT', { companionId, cardId: card.id, prompt }));
      if (!result.ok) throw new Error(result.message || '保存失败');
      flash('提示词已保存');
      await load();
    } catch (e) {
      flash(e.message);
    } finally {
      setBusyId('');
    }
  };

  const onUpload = async (card, file) => {
    setBusyId(card.id);
    try {
      const data = await fileToBase64(file);
      const result = await api('/api/outfit/card/image', json('POST', {
        companionId,
        cardId: card.id,
        mime: file.type,
        name: file.name,
        data,
      }));
      if (!result.ok) throw new Error(result.message || '上传失败');
      flash('图片已挂上正面');
      await load();
    } catch (e) {
      flash(e.message);
    } finally {
      setBusyId('');
    }
  };

  const onClearImage = async (card) => {
    if (!confirm('清除这张卡片的正面图？')) return;
    setBusyId(card.id);
    try {
      const result = await api('/api/outfit/card/image', json('DELETE', { companionId, cardId: card.id }));
      if (!result.ok) throw new Error(result.message || '清除失败');
      flash('已清除图片');
      await load();
    } catch (e) {
      flash(e.message);
    } finally {
      setBusyId('');
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

  if (state.loading && !state.data) return <Loading />;
  if (state.error) return <ErrorBox error={state.error} />;

  const d = state.data || {};
  const meta = KIND_META[tab];

  return (
    <div className="outfit-page">
      <Header
        title="穿搭系统"
        text="衣橱 · 单品 · 包柜 · 妆台 · 内衣。正面是图，背面是 AI 出图提示词；生成后上传，造型可一键上身。想看她穿上的整套成片 → 侧栏「穿搭相册」。"
        action={(
          <button className="btn" onClick={load}>
            <RefreshCw size={15} />
            刷新
          </button>
        )}
      />

      <section className="outfit-now panel">
        <div className="outfit-now-copy">
          <span className="page-header-kicker">NOW WEARING</span>
          <h3>{current?.current?.summary || '尚未选定造型'}</h3>
          <p>
            {current?.context
              ? `情境 ${CONTEXT_LABEL[current.context] || current.context}`
              : '对话后会按作息自动换装；也可在下方点「上身」。'}
            {current?.current?.id ? ` · look ${current.current.id}` : ''}
          </p>
        </div>
        <div className="outfit-now-stats">
          <div><b>{counts.looks || 0}</b><span>造型</span></div>
          <div><b>{counts.shoes || 0}</b><span>鞋</span></div>
          <div><b>{counts.bags || 0}</b><span>包</span></div>
          <div><b>{counts.jewelry || 0}</b><span>珠宝</span></div>
          <div><b>{counts.beauty || 0}</b><span>美妆</span></div>
          <div><b>{counts.lingerie || 0}</b><span>内衣</span></div>
        </div>
      </section>

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
          <p>{meta.hint} · 点卡片翻转看提示词 · 用 AI 生成后点「上传图」挂到正面</p>
        </div>
        <span className="badge">{cards.length} 张卡片</span>
      </div>

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
              wearing={wearingId === card.id}
              busyId={busyId}
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
            <li>点卡片翻转，复制背面提示词</li>
            <li>到你习惯的 AI 绘图工具出图</li>
            <li>回到这里「上传图」挂到正面</li>
            <li>整套造型点「上身」，写入当前穿着（影响对话与自拍）</li>
          </ol>
        </div>
      </section>

      {toast && <div className="outfit-toast" role="status">{toast}</div>}
    </div>
  );
}
