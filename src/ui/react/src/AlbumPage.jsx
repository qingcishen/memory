import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check, Copy, ImagePlus, LoaderCircle, MessageCircle, Plus, RefreshCw, Sparkles, Upload, WandSparkles, X,
} from 'lucide-react';

const CONTEXT_LABEL = {
  all: '全部',
  home: '居家', work: '职场', date: '约会', outing: '外出',
  sport: '运动', sleep: '睡眠', intimate: '私密', sick: '病中',
};

const CONTEXT_TABS = ['all', 'date', 'work', 'outing', 'home', 'intimate', 'sleep', 'sport', 'sick'];

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function AlbumFlipCard({ card, onSavePrompt, onUpload, onClearImage, onQuoteToChat, busyId }) {
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
    } catch { /* ignore */ }
  };

  const savePrompt = async (event) => {
    event.stopPropagation();
    await onSavePrompt(card, prompt);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1400);
  };

  const onFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await onUpload(card, file);
  };

  const initials = (card.title || '?').slice(0, 1);

  return (
    <article className={`outfit-card album-card ${flipped ? 'is-flipped' : ''} ${card.hasImage ? 'has-image' : ''}`}>
      <div className="outfit-card-inner">
        <button type="button" className="outfit-card-face outfit-card-front" onClick={() => setFlipped(true)} aria-label={`${card.title} · 点开看提示词`}>
          <div className="outfit-card-media">
            {card.imageUrl
              ? <img src={card.imageUrl} alt={card.title} />
              : (
                <div className="outfit-card-placeholder" data-kind="album">
                  <span className="outfit-card-mark">{initials}</span>
                  <small>待生成上身图</small>
                </div>
              )}
            {card.hasImage && <em className="outfit-card-image-dot" aria-hidden="true" />}
            {card.context && (
              <b className="album-context-badge">{CONTEXT_LABEL[card.context] || card.context}</b>
            )}
          </div>
          <div className="outfit-card-meta">
            <div className="outfit-card-kicker">
              <span>{card.subtitle || '上身效果'}</span>
              {card.source === 'custom' && <span className="outfit-chip">自定义</span>}
            </div>
            <h4>{card.title}</h4>
            <p>{card.summary || '—'}</p>
            {(card.tags || []).slice(0, 3).length > 0 && (
              <div className="outfit-card-tags">
                {card.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}
              </div>
            )}
          </div>
          <div className="outfit-card-hint">点击翻转 · 复制提示词去生成她穿上的样子</div>
        </button>

        <div className="outfit-card-face outfit-card-back">
          <div className="outfit-card-back-head">
            <button type="button" className="outfit-card-back-flipzone" onClick={() => setFlipped(false)} aria-label="翻回正面">
              <div>
                <span className="outfit-card-kicker">WEARING PROMPT</span>
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
            rows={9}
          />
          <div className="outfit-card-actions" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="btn" onClick={copyPrompt}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? '已复制' : '复制'}
            </button>
            <button type="button" className="btn" onClick={savePrompt} disabled={isBusy}>
              {savedFlash ? <Check size={14} /> : <WandSparkles size={14} />}
              {savedFlash ? '已存' : '存提示词'}
            </button>
            {onQuoteToChat && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={(e) => { e.stopPropagation(); onQuoteToChat(card); }}
                title="带进试聊：问她能不能穿这套 / 好不好看"
              >
                <MessageCircle size={14} />
                引用进对话
              </button>
            )}
            <button type="button" className="btn" onClick={() => inputRef.current?.click()} disabled={isBusy}>
              {isBusy ? <LoaderCircle size={14} className="animate-spin" /> : <Upload size={14} />}
              上传成片
            </button>
            {card.hasImage && (
              <button type="button" className="btn" onClick={() => onClearImage(card)} disabled={isBusy}>
                清图
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

export default function AlbumPage({ scope, api, qs, json, Header, Loading, ErrorBox, Empty, onQuoteToChat }) {
  const companionId = scope.companionId || 'default';
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [tab, setTab] = useState('all');
  const [filter, setFilter] = useState('all'); // all | filled | pending
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState('');
  const [toast, setToast] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSummary, setNewSummary] = useState('');
  const [newContext, setNewContext] = useState('date');
  const [newPrompt, setNewPrompt] = useState('');
  const [adding, setAdding] = useState(false);

  const load = async () => {
    setState((s) => ({ ...s, loading: true, error: '' }));
    try {
      const data = await api(`/api/album?${qs({ companionId })}`);
      setState({ loading: false, data, error: '' });
    } catch (e) {
      setState({ loading: false, data: null, error: e.message });
    }
  };

  useEffect(() => { load(); }, [companionId]);

  const flash = (message) => {
    setToast(message);
    setTimeout(() => setToast(''), 2200);
  };

  const cards = useMemo(() => {
    let list = state.data?.cards || [];
    if (tab !== 'all') list = list.filter((c) => c.context === tab);
    if (filter === 'filled') list = list.filter((c) => c.hasImage);
    if (filter === 'pending') list = list.filter((c) => !c.hasImage);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((c) => {
        const blob = [c.title, c.subtitle, c.summary, c.prompt, ...(c.tags || [])].join(' ').toLowerCase();
        return blob.includes(q);
      });
    }
    return list;
  }, [state.data, tab, filter, query]);

  const counts = state.data?.counts || {};

  const onSavePrompt = async (card, prompt) => {
    setBusyId(card.id);
    try {
      const result = await api('/api/album/card', json('PUT', { companionId, cardId: card.id, prompt }));
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
      const result = await api('/api/album/card/image', json('POST', {
        companionId,
        cardId: card.id,
        mime: file.type,
        name: file.name,
        data,
      }));
      if (!result.ok) throw new Error(result.message || '上传失败');
      flash('上身成片已挂上正面');
      await load();
    } catch (e) {
      flash(e.message);
    } finally {
      setBusyId('');
    }
  };

  const onClearImage = async (card) => {
    if (!confirm('清除这张上身效果图？')) return;
    setBusyId(card.id);
    try {
      const result = await api('/api/album/card/image', json('DELETE', { companionId, cardId: card.id }));
      if (!result.ok) throw new Error(result.message || '清除失败');
      flash('已清除');
      await load();
    } catch (e) {
      flash(e.message);
    } finally {
      setBusyId('');
    }
  };

  const onAddCustom = async () => {
    if (!newTitle.trim()) {
      flash('请填写标题');
      return;
    }
    setAdding(true);
    try {
      const result = await api('/api/album/custom', json('POST', {
        companionId,
        title: newTitle.trim(),
        summary: newSummary.trim(),
        context: newContext,
        prompt: newPrompt.trim(),
      }));
      if (!result.ok) throw new Error(result.message || '添加失败');
      flash('已加入相册');
      setShowAdd(false);
      setNewTitle('');
      setNewSummary('');
      setNewPrompt('');
      await load();
    } catch (e) {
      flash(e.message);
    } finally {
      setAdding(false);
    }
  };

  if (state.loading && !state.data) return <Loading />;
  if (state.error) return <ErrorBox error={state.error} />;

  return (
    <div className="outfit-page album-page">
      <Header
        title="穿搭相册"
        text="展示她穿上之后的样子。正面是成片，背面是出图提示词——从衣橱造型自动同步，也可加自定义场景。"
        action={(
          <div className="flex gap-2">
            <button className="btn" onClick={() => setShowAdd((v) => !v)}>
              <Plus size={15} />
              自定义
            </button>
            <button className="btn" onClick={load}>
              <RefreshCw size={15} />
              刷新
            </button>
          </div>
        )}
      />

      <section className="outfit-now panel album-hero">
        <div className="outfit-now-copy">
          <span className="page-header-kicker">LOOKBOOK · WEARING</span>
          <h3>她穿上的效果，一张卡一帧画面</h3>
          <p>
            每套衣橱造型自动生成一张相册卡。复制背面提示词 → AI 出图 → 上传成片。
            与「穿搭系统」里的单品图不同：这里要的是<strong>人穿着</strong>的完整样子。
          </p>
        </div>
        <div className="outfit-now-stats album-stats">
          <div><b>{counts.total || 0}</b><span>全部</span></div>
          <div><b>{counts.withImage || 0}</b><span>已有成片</span></div>
          <div><b>{counts.pending || 0}</b><span>待生成</span></div>
          <div><b>{counts.date || 0}</b><span>约会</span></div>
          <div><b>{counts.work || 0}</b><span>职场</span></div>
          <div><b>{counts.custom || 0}</b><span>自定义</span></div>
        </div>
      </section>

      {showAdd && (
        <section className="panel album-add mb-4 space-y-3">
          <h3 className="font-bold">添加自定义相册卡</h3>
          <p className="text-xs text-zinc-400">不绑衣橱造型，例如「雨夜下车」「酒店走廊」等场景成片。</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="field"><span>标题</span><input className="input" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="例如：雨夜下车" /></label>
            <label className="field">
              <span>情境</span>
              <select className="input" value={newContext} onChange={(e) => setNewContext(e.target.value)}>
                {['date', 'outing', 'home', 'work', 'intimate', 'sleep'].map((c) => (
                  <option key={c} value={c}>{CONTEXT_LABEL[c] || c}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="field"><span>画面描述</span><input className="input" value={newSummary} onChange={(e) => setNewSummary(e.target.value)} placeholder="一句话描述她在做什么、穿什么" /></label>
          <label className="field"><span>出图提示词（可选，可后填）</span><textarea className="input" rows={3} value={newPrompt} onChange={(e) => setNewPrompt(e.target.value)} placeholder="英文提示词更好出图…" /></label>
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={onAddCustom} disabled={adding}>{adding ? '添加中…' : '加入相册'}</button>
            <button className="btn" onClick={() => setShowAdd(false)}>取消</button>
          </div>
        </section>
      )}

      <div className="outfit-toolbar">
        <div className="outfit-tabs" role="tablist">
          {CONTEXT_TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`outfit-tab ${tab === id ? 'is-active' : ''}`}
              onClick={() => setTab(id)}
            >
              <strong>{CONTEXT_LABEL[id]}</strong>
              <small>{id === 'all' ? (counts.total || 0) : (counts[id] || 0)}</small>
            </button>
          ))}
        </div>
        <div className="album-filters">
          {[
            ['all', '全部'],
            ['filled', '已有成片'],
            ['pending', '待生成'],
          ].map(([id, label]) => (
            <button key={id} type="button" className={`outfit-tab ${filter === id ? 'is-active' : ''}`} onClick={() => setFilter(id)}>
              <strong>{label}</strong>
            </button>
          ))}
          <label className="outfit-search">
            <span className="sr-only">搜索</span>
            <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索造型 / 场景…" />
          </label>
        </div>
      </div>

      <div className="outfit-section-head">
        <div>
          <h3>{CONTEXT_LABEL[tab]} · 上身效果</h3>
          <p>点卡片翻转看提示词 · 生成后点「上传成片」挂到正面</p>
        </div>
        <span className="badge">{cards.length} 张</span>
      </div>

      {cards.length ? (
        <div className="outfit-grid">
          {cards.map((card) => (
            <AlbumFlipCard
              key={card.id}
              card={card}
              onSavePrompt={onSavePrompt}
              onUpload={onUpload}
              onClearImage={onClearImage}
              onQuoteToChat={onQuoteToChat}
              busyId={busyId}
            />
          ))}
        </div>
      ) : (
        <Empty>{query || filter !== 'all' ? '没有匹配的相册卡' : '还没有相册卡'}</Empty>
      )}

      <section className="outfit-howto panel">
        <div className="outfit-howto-icon"><ImagePlus size={18} /><Sparkles size={18} /></div>
        <div>
          <h3>和穿搭系统的区别</h3>
          <ol>
            <li><b>穿搭系统</b>：衣橱/包/鞋/妆的单品与造型卡，偏「物件」</li>
            <li><b>穿搭相册</b>：她<strong>穿上整套</strong>之后的成片，偏「人」</li>
            <li>提示词默认按造型 + 场景写好，可改可复制</li>
            <li>成片在 <b>Cloudflare R2</b> 图床；提示词与 URL 在 <b>Supabase</b> companion_card_assets</li>
          </ol>
        </div>
      </section>

      {toast && <div className="outfit-toast" role="status">{toast}</div>}
    </div>
  );
}
