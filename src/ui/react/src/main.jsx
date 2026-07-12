import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, Bell, Bot, Brain, ChevronDown, ChevronRight, CircleGauge, Database, Heart,
  Hash, Headphones, Image, LoaderCircle, Menu, MessageCircle, Mic, Moon, MoreHorizontal,
  Network, Pin, Plus, RefreshCw, Save, Search, Settings2, ShieldCheck, Smile, Sparkles,
  SquareTerminal, Sun, UserRound, UsersRound, WandSparkles, X, Zap,
} from 'lucide-react';
import './index.css';

const api = async (path, options) => {
  const token = localStorage.getItem('cyber-memory-admin-token') || '';
  const response = await fetch(path, { ...options, headers: { ...(options?.headers || {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (response.status === 401) {
    const next = window.prompt('请输入管理控制台 Token');
    if (next) { localStorage.setItem('cyber-memory-admin-token', next); return api(path, options); }
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
  return data;
};
const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const qs = (scope, extra = {}) => new URLSearchParams({ userId: scope.userId || '', companionId: scope.companionId || 'default', ...extra }).toString();
const fmt = (value) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
const pct = (value) => `${Math.round(Number(value || 0) * 100)}%`;

const nav = [
  ['overview', '运行总览', CircleGauge], ['companion-v2', '伴侣升级', Sparkles], ['state', '情绪与身体', Heart],
  ['personas', '角色人设', UserRound], ['world', '世界状态', Zap], ['gallery', '图片工作室', Image],
  ['memories', '记忆库', Brain], ['prospective', '主动提醒', Bell], ['graph', '知识图谱', Network],
  ['operations', '自动化运维', SquareTerminal], ['chat', '试聊调试', MessageCircle], ['config', '设置与模型', Settings2],
];

const navDescriptions = {
  overview: '关系与系统状态总览', 'companion-v2': '需求、故事与多模态能力', state: '情绪、关系与身体轨迹',
  personas: '角色档案与人格管理', world: '连续背景与动态世界线', gallery: '参考图、自拍与照片资产',
  memories: '长期事实、事件与偏好', prospective: '定时与语境主动提醒', graph: '实体关系与知识联想',
  operations: '后台任务、健康与维护', chat: '使用真实管线试聊', config: '模型、数据库与服务凭证',
};

const navGroups = [
  { id: 'inner', label: '内在', kana: '心', icon: Heart, items: ['overview', 'companion-v2', 'state'] },
  { id: 'identity', label: '角色', kana: '人', icon: UserRound, items: ['personas', 'world', 'gallery'] },
  { id: 'memory', label: '记忆', kana: '忆', icon: Brain, items: ['memories', 'prospective', 'graph'] },
  { id: 'system', label: '系统', kana: '控', icon: SquareTerminal, items: ['operations', 'chat', 'config'] },
];

function Sidebar({ active, go, scope, bot, startBot, mobile, closeMobile }) {
  const companionId = scope.companionId;
  const [photos] = useEndpoint(`/api/image-references?${qs(scope)}`, [scope.userId, scope.companionId]);
  const [companionState] = useEndpoint('/api/companions', []);
  const references = photos.data?.items || [];
  const avatar = references.find(item => item.isAvatar) || references[0];
  const companion = (companionState.data?.companions || []).find(item => item.id === companionId);
  const companionName = companion?.name || (companionId === 'default' ? '沈清词' : companionId);
  const activeGroup = navGroups.find(group => group.items.includes(active)) || navGroups[0];
  const [panelGroup, setPanelGroup] = useState(activeGroup.id);
  const [panelOpen, setPanelOpen] = useState(false);
  useEffect(() => setPanelGroup(activeGroup.id), [activeGroup.id]);
  const group = navGroups.find(item => item.id === panelGroup) || activeGroup;
  const items = group.items.map(id => nav.find(item => item[0] === id));
  const openGroup = id => { setPanelGroup(id); setPanelOpen(true); };
  return <aside className={`sidebar-shell ${panelOpen || mobile ? 'panel-open' : ''} ${mobile ? 'mobile-open' : ''}`} onMouseLeave={() => !mobile && setPanelOpen(false)}>
    <div className="sidebar-rail">
      <div className="rail-logo">Lumen</div>
      <nav className="rail-nav scrollbar" aria-label="控制台分组">
        {navGroups.map(({ id, label, icon: Icon }) => <button key={id} className={`rail-button ${activeGroup.id === id ? 'is-active' : ''} ${panelOpen && panelGroup === id ? 'is-panel' : ''}`} aria-label={label} onMouseEnter={() => openGroup(id)} onFocus={() => openGroup(id)} onClick={() => openGroup(id)}><Icon size={18}/><span className="rail-tooltip">{label}</span></button>)}
      </nav>
      <div className="rail-bottom">
        <button className={`rail-button ${bot?.running ? 'is-running' : ''}`} aria-label={bot?.running ? '停止消息渠道' : '启动消息渠道'} onClick={startBot}><Bot size={17}/><span className="rail-tooltip">{bot?.running ? '停止消息渠道' : '启动消息渠道'}</span></button>
      </div>
    </div>
    <div className="sidebar-panel">
      <div className="sidebar-panel-inner">
        <div className="panel-topline"><span>{group.label}</span><button className="panel-close" onClick={() => { setPanelOpen(false); closeMobile(); }} aria-label="收起侧边栏"><X size={16}/></button></div>
        <button className="companion-card" onClick={() => { go('gallery'); if (mobile) closeMobile(); }} aria-label="打开清词照片墙">
          <div className="companion-avatar">{avatar ? <img src={avatar.url} alt="清词"/> : (companionId || 'D').slice(0,1).toUpperCase()}</div>
          <div><strong>{companionName}</strong><small>{references.length ? `${references.length} 张照片 · 查看照片墙` : '探索 · 记录 · 陪伴'}</small></div>
        </button>
        <nav className="panel-links" aria-label={`${group.label}导航`}>
          {items.map(([id, label, Icon]) => <button key={id} className={`panel-link ${active === id ? 'is-active' : ''}`} onClick={() => { go(id); if (mobile) closeMobile(); }}><span className="panel-link-icon"><Icon size={17}/></span><span className="panel-link-copy"><strong>{label}</strong><small>{navDescriptions[id]}</small></span></button>)}
        </nav>
        <div className="panel-kana" aria-hidden="true">{group.kana}</div>
      </div>
    </div>
  </aside>;
}

function Loading() { return <div className="loading-shell" aria-label="正在读取数据"><div className="loading-mark"><LoaderCircle className="animate-spin" size={18}/><span>SYNCING MEMORY</span></div><div className="loading-lines"><i/><i/><i/></div></div>; }
function Empty({ children = '暂无数据' }) { return <div className="rounded-xl border border-dashed border-zinc-200 px-4 py-10 text-center text-sm text-zinc-400">{children}</div>; }
function ErrorBox({ error }) { return <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>; }
function Header({ title, text, action }) { return <div className="page-header"><div><span className="page-header-kicker">Memory system · Console</span><h2>{title}</h2><p>{text}</p></div>{action && <div className="page-header-action">{action}</div>}</div>; }
function Metric({ label, value, tone = 'violet' }) { const colors = { violet: 'from-violet-500 to-indigo-500', rose: 'from-rose-400 to-orange-400', emerald: 'from-emerald-400 to-teal-500' }; return <div className="panel"><p className="text-xs font-semibold text-zinc-400">{label}</p><div className="mt-3 flex items-end gap-3"><strong className="text-3xl tracking-tight">{value}</strong><div className="mb-1 h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100"><div className={`h-full w-2/3 rounded-full bg-gradient-to-r ${colors[tone]}`}/></div></div></div>; }
function ListRow({ title, sub, end }) { return <div className="flex items-center gap-3 border-b border-zinc-100 py-3 last:border-0"><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{title}</div>{sub && <div className="mt-0.5 truncate text-xs text-zinc-400">{sub}</div>}</div>{end}</div>; }

function useEndpoint(path, deps = []) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const load = async () => { setState(s => ({ ...s, loading: true, error: '' })); try { setState({ loading: false, data: await api(path), error: '' }); } catch (e) { setState({ loading: false, data: null, error: e.message }); } };
  useEffect(() => { load(); }, deps);
  return [state, load];
}

function Overview({ scope }) {
  const [s, reload] = useEndpoint(`/api/overview?${qs(scope)}`, [scope.userId, scope.companionId]);
  if (s.loading) return <Loading/>; if (s.error) return <ErrorBox error={s.error}/>;
  const d = s.data || {}; const a = d.affect || d.state?.affect || {}; const life = d.life || d.state?.life || {}; const rel = a.relationship || {}; const counts = d.counts || {};
  const moodScore = Math.round((Number(a.mood?.valence || 0) + 1) * 50);
  const closeness = Math.round(Number(rel.closeness || 0) * 100);
  const moodWord = Number(rel.tension || 0) > .55 ? '有些紧绷' : moodScore > 68 ? '轻盈明亮' : moodScore < 36 ? '低落安静' : '平静柔和';
  const recent = d.recentChat || [];
  return <div className="overview-page">
    <div className="overview-lead">
      <div><p className="overview-kicker">Memory OS · Live Portrait</p><h2>她，此刻正在发生。</h2><p>不是一组后台数字，而是一段持续变化的关系、记忆与生活。</p></div>
      <button className="overview-refresh" onClick={reload}><RefreshCw size={15}/><span>同步此刻</span></button>
    </div>

    <div className="overview-grid">
      <section className="overview-pulse">
        <div className="overview-section-head"><span>Relationship pulse</span><span>{scope.companionId || 'default'} / now</span></div>
        <div className="pulse-main">
          <div className="pulse-orbit" style={{ '--pulse-value': `${closeness * 3.6}deg` }}><div><strong>{closeness}</strong><span>亲密指数</span></div></div>
          <div className="pulse-copy"><span className="pulse-eyebrow">CURRENT FEELING</span><h3>{moodWord}</h3><p>{life.current_activity || '她正在自己的生活里，等下一次与你相遇。'}</p><div className="pulse-signals"><span>信任 <b>{pct(rel.trust)}</b></span><span>紧张 <b>{pct(rel.tension)}</b></span><span>心情 <b>{moodScore}</b></span></div></div>
        </div>
      </section>

      <section className="overview-index">
        <div className="overview-section-head"><span>System index</span><span>04 signals</span></div>
        <div className="index-row"><span>01</span><div><b>长期记忆</b><small>仍在关系里发挥作用</small></div><strong>{counts.memories ?? 0}</strong></div>
        <div className="index-row"><span>02</span><div><b>待触发提醒</b><small>未来会主动提起</small></div><strong>{counts.pending ?? 0}</strong></div>
        <div className="index-row"><span>03</span><div><b>照片资产</b><small>角色形象与生活切片</small></div><strong>{counts.photos ?? 0}</strong></div>
        <div className="index-row"><span>04</span><div><b>异常任务</b><small>需要人工关注</small></div><strong className={Number(counts.failedJobs) ? 'is-alert' : ''}>{counts.failedJobs ?? 0}</strong></div>
      </section>

      <section className="overview-now">
        <div className="overview-section-head"><span>Context / 情境</span><span>{fmt(d.world?.updated_at)}</span></div>
        <div className="now-story"><span>世界线</span><h3>{d.world?.arc || '生活仍在缓慢展开'}</h3><p>{d.world?.last_event || d.world?.atmosphere || '还没有写下明确的情节，留一点空间给下一次相遇。'}</p></div>
        <div className="now-meta"><div><span>ENERGY</span><b>{pct(life.energy)}</b></div><div><span>HEALTH</span><b>{pct(life.health)}</b></div><div><span>ACTIVITY</span><b>{life.current_activity || '自由时间'}</b></div></div>
      </section>

      <section className="overview-conversation">
        <div className="overview-section-head"><span>Recent traces</span><span>{recent.length} entries</span></div>
        {recent.length ? recent.slice(-3).reverse().map((item, index) => <div className="trace-row" key={`${item.created_at}-${index}`}><span>{item.role === 'user' ? 'YOU' : 'HER'}</span><p>{item.content}</p><time>{fmt(item.created_at)}</time></div>) : <div className="trace-empty"><MessageCircle size={20}/><p>最近没有对话痕迹。</p><small>下一句话会从这里开始留下回声。</small></div>}
      </section>
    </div>
  </div>;
}
function Mini({ label, value }) { return <div className="rounded-xl bg-zinc-50 p-4"><div className="text-xs text-zinc-400">{label}</div><div className="mt-2 text-2xl font-bold">{pct(value)}</div></div>; }

function CompanionV2({ scope }) {
  const [s, reload] = useEndpoint(`/api/companion-v2?${qs(scope)}`, [scope.userId, scope.companionId]);
  if (s.loading) return <Loading/>; if (s.error) return <ErrorBox error={s.error}/>; const d=s.data||{}, desires=d.affect?.desires||{}, voice=d.capabilities?.voice||{}, image=d.capabilities?.image||{};
  return <><Header title="伴侣升级" text="她的内在需求、故事线、纪念日与多模态能力。" action={<button className="btn" onClick={reload}><RefreshCw size={15}/>刷新</button>}/><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Metric label="关注需求" value={pct(desires.attention)}/><Metric label="分享欲" value={pct(desires.sharing)} tone="rose"/><Metric label="安慰需求" value={pct(desires.comfort)} tone="emerald"/><Metric label="安全感缺口" value={pct(desires.security)}/></div><div className="mt-5 grid gap-5 lg:grid-cols-2"><Card title="生活故事" icon={WandSparkles}>{(d.story||[]).length ? d.story.map(x=><ListRow key={x.storyline_key||x.title} title={x.title||'故事线'} sub={x.last_beat||x.next_beat_hint||x.stage}/>) : <Empty>还没有活跃故事线</Empty>}</Card><Card title="纪念日日历" icon={Bell}>{(d.annuals||[]).length ? d.annuals.map(x=><ListRow key={x.id} title={x.content} sub={`${fmt(x.trigger_at)} · ${x.status}`}/>) : <Empty>生日和初次聊天纪念日会出现在这里</Empty>}</Card><Card title="行为策略" icon={ShieldCheck}><ListRow title="已读不回次数" sub={String(d.behavior?.stonewall_count||0)}/><ListRow title="修复台阶" sub={d.behavior?.mustGiveRepairStep?'下一轮必须主动修复':'当前无修复债'} end={<span className={`badge ${d.behavior?.mustGiveRepairStep?'badge-warn':'badge-ok'}`}>{d.behavior?.mustGiveRepairStep?'需处理':'稳定'}</span>}/></Card><Card title="声音与形象" icon={Sparkles}><ListRow title="TTS Voice" sub={voice.voice||'nova'} end={<span className={`badge ${voice.configured?'badge-ok':''}`}>{voice.configured?'就绪':'未配置'}</span>}/><ListRow title="角色 LoRA" sub={image.loraId||image.loraTrigger||'尚未绑定'} end={<span className="badge">{image.loraStatus||'not_started'}</span>}/></Card></div></>;
}
function Card({ title, icon: Icon, children }) { return <section className="panel"><div className="mb-3 flex items-center gap-2"><span className="rounded-lg bg-violet-50 p-2 text-violet-600"><Icon size={17}/></span><h3 className="font-bold">{title}</h3></div>{children}</section>; }

function StateView({ scope }) {
  const [s, reload] = useEndpoint(`/api/state?${qs(scope)}`, [scope.userId, scope.companionId]); const [form,setForm]=useState(null); const [saving,setSaving]=useState(false);
  useEffect(()=>{if(s.data)setForm(structuredClone(s.data));},[s.data]); if(s.loading||!form)return <Loading/>; if(s.error)return <ErrorBox error={s.error}/>;
  const groups=[['情绪与关系','affect',[['心情正负','mood.valence',-1,1],['情绪唤起','mood.arousal',0,1],['亲密度','relationship.closeness',0,1],['信任','relationship.trust',0,1],['紧张','relationship.tension',0,1],['和好债','relationship.repair_debt',0,1]]],['内在需求','affect',[['被关注','desires.attention',0,1],['分享欲','desires.sharing',0,1],['被安慰','desires.comfort',0,1],['安全感缺口','desires.security',0,1]]],['身体状态','life',[['精力','energy',0,1],['饱腹','satiety',0,1],['健康','health',0,1]]]];
  const get=(obj,path)=>path.split('.').reduce((a,k)=>a?.[k],obj)??0; const set=(root,path,v)=>{const n=structuredClone(form);let o=n[root];const p=path.split('.');p.slice(0,-1).forEach(k=>o=o[k]??={});o[p.at(-1)]=Number(v);setForm(n)};
  const save=async()=>{setSaving(true);try{await api('/api/state',json('PUT',{scope,affect:form.affect,life:form.life}));await reload();}finally{setSaving(false)}};
  return <><Header title="情绪与身体" text="调整后会真实影响下一轮对话。" action={<button className="btn btn-primary" onClick={save} disabled={saving}><Save size={15}/>{saving?'保存中':'保存状态'}</button>}/><div className="grid gap-5 lg:grid-cols-2">{groups.map(([title,root,items])=><section className="panel" key={title}><h3 className="font-bold">{title}</h3><div className="mt-5 space-y-5">{items.map(([label,path,min,max])=><label className="block" key={path}><span className="flex justify-between text-sm"><b>{label}</b><span className="text-zinc-400">{Number(get(form[root],path)).toFixed(2)}</span></span><input className="mt-3 h-1.5 w-full accent-violet-600" type="range" min={min} max={max} step="0.01" value={get(form[root],path)} onChange={e=>set(root,path,e.target.value)}/></label>)}</div></section>)}</div></>;
}
function Memories({ scope }) { const [query,setQuery]=useState(''); const [s,reload]=useEndpoint(`/api/memories?${qs(scope,{q:query,limit:'80'})}`,[scope.userId,scope.companionId]); const run=e=>{e.preventDefault();reload()}; return <><Header title="记忆库" text="浏览她保留下来的事实、偏好、事件与关系记忆。"/><form onSubmit={run} className="panel mb-5 flex gap-2"><div className="relative flex-1"><Search className="absolute left-3.5 top-3 text-zinc-400" size={17}/><input className="input pl-10" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索记忆内容…"/></div><button className="btn">搜索</button></form>{s.loading?<Loading/>:s.error?<ErrorBox error={s.error}/>:<div className="panel">{(s.data?.memories||s.data?.items||[]).length?(s.data.memories||s.data.items).map(m=><ListRow key={m.id} title={m.content} sub={`${m.type||'memory'} · 重要性 ${m.importance??'—'} · ${fmt(m.created_at)}`} end={<span className="badge">{m.subject_kind||m.modality||'text'}</span>}/>):<Empty/>}</div>}</> }

function Prospective({ scope }) { const [s,reload]=useEndpoint(`/api/prospectives?${qs(scope)}`,[scope.userId,scope.companionId]); const [content,setContent]=useState(''); const create=async()=>{if(!content.trim())return;await api('/api/prospectives',json('POST',{scope,content,triggerKind:'cue',cueText:content}));setContent('');reload()}; return <><Header title="主动提醒" text="她会在合适的时机，主动把重要的事提起来。"/><div className="panel mb-5 flex gap-2"><input className="input" value={content} onChange={e=>setContent(e.target.value)} placeholder="例如：下次聊到面试时，主动问结果"/><button className="btn btn-primary shrink-0" onClick={create}><Plus size={16}/>创建</button></div>{s.loading?<Loading/>:s.error?<ErrorBox error={s.error}/>:<div className="panel">{(s.data?.items||[]).length?s.data.items.map(x=><ListRow key={x.id} title={x.content} sub={`${x.trigger_kind==='annual'?'每年':x.trigger_kind} · ${fmt(x.trigger_at)}`} end={<span className={`badge ${x.status==='pending'?'badge-ok':''}`}>{x.status}</span>}/>):<Empty/>}</div>}</> }

function World({ scope }) { const [s,reload]=useEndpoint(`/api/world?${qs(scope)}`,[scope.userId,scope.companionId]); const [w,setW]=useState({}); useEffect(()=>setW(s.data?.world||{}),[s.data]); const save=async()=>{await api('/api/world',json('PUT',{scope,world:w}));reload()}; if(s.loading)return <Loading/>;return <><Header title="世界状态" text="持续变化的背景、氛围和最近发生的事。" action={<button className="btn btn-primary" onClick={save}><Save size={15}/>保存</button>}/><div className="panel space-y-4"><label className="field"><span>背景剧情线</span><textarea rows="5" className="input" value={w.arc||''} onChange={e=>setW({...w,arc:e.target.value})}/></label><label className="field"><span>当前氛围</span><input className="input" value={w.atmosphere||''} onChange={e=>setW({...w,atmosphere:e.target.value})}/></label><label className="field"><span>最近进展</span><textarea rows="4" className="input" value={w.last_event||''} onChange={e=>setW({...w,last_event:e.target.value})}/></label></div></> }

function Gallery({ scope }) {
  const [generated, reloadGenerated] = useEndpoint(`/api/gallery?${qs(scope)}`, [scope.userId, scope.companionId]);
  const [referenceState, reloadReferences] = useEndpoint(`/api/image-references?${qs(scope)}`, [scope.userId, scope.companionId]);
  const [prompt, setPrompt] = useState(''); const [busy, setBusy] = useState(false); const [selected, setSelected] = useState(null); const [generateError, setGenerateError] = useState('');
  const references = referenceState.data?.items || []; const assets = generated.data?.assets || [];
  const reload = () => { reloadGenerated(); reloadReferences(); };
  const generate = async () => { if (!prompt) return; setBusy(true); setGenerateError(''); try { const result = await api('/api/images/generate', json('POST', { scope, prompt, size: '1024x1536', quality: 'high', inputFidelity: 'high' })); if (!result.ok) throw new Error(result.message || '图片生成失败'); reloadGenerated(); } catch (error) { setGenerateError(error.message || '图片生成失败'); } finally { setBusy(false); } };
  const setAvatar = async (event, item) => { event.stopPropagation(); await api(`/api/image-references/${item.id}/avatar`, json('PATCH', { scope })); reloadReferences(); };
  const deleteAsset = async (event, item) => { event.stopPropagation(); if (!confirm('确定永久删除这张生成照片吗？')) return; await api(`/api/gallery/${item.id}?${qs(scope)}`, { method: 'DELETE' }); reloadGenerated(); };
  return <>
    <Header title="清词照片墙" text={`${references.length} 张角色参考照 · 生成自拍和生活照片时自动保持她的脸与外貌。`} action={<button className="btn" onClick={reload}><RefreshCw size={15}/>刷新</button>}/>
    <section className="panel mb-5"><div className="mb-4 flex items-center justify-between"><div><h3 className="font-bold">角色参考照片</h3><p className="mt-1 text-xs text-zinc-400">点击照片放大；标记为头像的照片会显示在左侧角色卡片。</p></div><span className="badge badge-ok">生成时自动引用</span></div>
      {referenceState.loading ? <Loading/> : references.length ? <div className="photo-wall">{references.map((item, index) => <button className={`photo-tile ${item.isAvatar ? 'is-avatar' : ''}`} key={item.id} onClick={() => setSelected(item)} aria-label={`查看清词照片 ${index + 1}`}><img src={item.url} alt="清词参考照片"/>{item.isAvatar ? <b>当前头像</b> : <em onClick={event => setAvatar(event, item)}>设为头像</em>}</button>)}</div> : <Empty>还没有导入角色照片</Empty>}
    </section>
    <section className="panel mb-5"><div className="mb-4"><h3 className="font-bold">生成新照片</h3><p className="mt-1 text-xs text-zinc-400">会自动使用头像与 3 张核心参考图，并以高一致性模式生成。</p></div><div className="flex gap-3"><textarea rows="3" className="input" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="描述画面、服装、光线和镜头感…"/><button className="btn btn-primary w-28 shrink-0" onClick={generate} disabled={busy}><WandSparkles size={16}/>{busy ? '生成中' : '生成'}</button></div>{generateError && <div className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{generateError}</div>}</section>
    <section><div className="mb-4 flex items-end justify-between"><div><h3 className="text-lg font-bold">生成记录</h3><p className="mt-1 text-xs text-zinc-400">自拍与生活场景会留在这里。</p></div><span className="badge">{assets.length} 张</span></div>{generated.loading ? <Loading/> : <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{assets.length ? assets.map(asset => <div className="panel relative overflow-hidden p-2 text-left" key={asset.id}><button className="block w-full text-left" onClick={() => setSelected({ ...asset, name: asset.prompt || '生成照片' })}><div className="aspect-[4/5] overflow-hidden rounded-xl bg-zinc-100">{asset.url && <img className="h-full w-full object-cover" src={asset.url} alt="生成照片"/>}</div><p className="line-clamp-2 px-2 pb-1 pt-3 text-sm text-zinc-600">{asset.prompt || '角色照片'}</p></button><button className="absolute right-4 top-4 grid size-8 place-items-center rounded-full bg-black/55 text-white backdrop-blur hover:bg-black/75" aria-label="删除这张生成照片" title="删除这张生成照片" onClick={event => deleteAsset(event, asset)}><X size={15}/></button></div>) : <div className="sm:col-span-2 xl:col-span-3"><Empty>还没有生成照片</Empty></div>}</div>}</section>
    {selected && <div className="photo-lightbox" role="dialog" aria-modal="true" aria-label="照片预览" onClick={() => setSelected(null)}><button className="photo-lightbox-close" onClick={() => setSelected(null)}><X size={20}/></button><img src={selected.url} alt="清词照片预览"/></div>}
  </>;
}

function Graph({ scope }) { const [s]=useEndpoint(`/api/graph?${qs(scope)}`,[scope.userId,scope.companionId]); if(s.loading)return <Loading/>; if(s.error)return <ErrorBox error={s.error}/>; const entities=s.data?.entities||[], relations=s.data?.relations||[]; return <><Header title="知识图谱" text="把零散事实连接成可推理的实体关系。"/><div className="grid gap-5 lg:grid-cols-2"><div className="panel"><h3 className="font-bold">实体 · {entities.length}</h3><div className="mt-4 flex flex-wrap gap-2">{entities.map(e=><span className="badge" key={e.id}>{e.name||e.canonical_name} · {e.kind||e.type}</span>)}</div>{!entities.length&&<Empty/>}</div><div className="panel"><h3 className="font-bold">关系 · {relations.length}</h3><div className="mt-3">{relations.map(r=><ListRow key={r.id} title={r.predicate||r.relation} sub={`${r.source_name||r.source_id} → ${r.target_name||r.target_id}`}/>)}</div>{!relations.length&&<Empty/>}</div></div></> }

function Personas({ scope, onCompanion }) {
  const [s, reload] = useEndpoint('/api/companions', []);
  const companions = s.data?.companions || [];
  const [selectedId, setSelectedId] = useState(scope.companionId || 'default');
  const [profileState, reloadProfile] = useEndpoint(`/api/companion-profile?companionId=${encodeURIComponent(selectedId)}`, [selectedId]);
  const [profile, setProfile] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (profileState.data?.profile) setProfile(profileState.data.profile); }, [profileState.data]);
  useEffect(() => { if (scope.companionId) setSelectedId(scope.companionId); }, [scope.companionId]);
  const create = async () => { const id = prompt('新角色 ID（字母、数字、短横线）'); if (!id) return; const name = prompt('她的名字') || id; await api('/api/companions', json('POST', { companionId: id, name, cloneFrom: scope.companionId || 'default' })); reload(); setSelectedId(id); onCompanion(id); };
  const setField = (key, value) => setProfile(current => ({ ...current, [key]: value }));
  const setMenstrual = (key, value) => setProfile(current => ({ ...current, menstrual: { ...(current?.menstrual || {}), [key]: value } }));
  const setFamily = (index, key, value) => setProfile(current => ({ ...current, family: (current?.family || []).map((member, i) => i === index ? { ...member, [key]: value } : member) }));
  const save = async () => { if (!profile) return; setSaving(true); try { const result = await api('/api/companion-profile', json('PUT', { companionId: selectedId, profile })); if (!result.ok) throw new Error(result.message || '保存失败'); setProfile(result.profile); reloadProfile(); } catch (error) { window.alert(error.message); } finally { setSaving(false); } };
  const addFamily = () => setProfile(current => ({ ...current, family: [...(current?.family || []), { relation: '家人', name: '', nickname: '', occupation: '', location: '', notes: '' }] }));
  const removeFamily = index => setProfile(current => ({ ...current, family: (current?.family || []).filter((_, i) => i !== index) }));
  const selected = companions.find(c => c.companionId === selectedId);
  return <><Header title="角色档案" text="把她的家庭、身份、成长背景和身体周期集中管理；证件字段只在本机保存并默认脱敏。" action={<button className="btn btn-primary" onClick={create}><Plus size={16}/>新建角色</button>}/><div className="personas-layout"><section className="personas-list"><div className="personas-list-title"><span>角色</span><small>{companions.length} 个</small></div>{companions.map(c => <button onClick={() => { setSelectedId(c.companionId); onCompanion(c.companionId); }} className={`persona-select-card ${selectedId === c.companionId ? 'is-selected' : ''}`} key={c.companionId}><span className="persona-select-avatar">{(c.name || c.companionId)[0]}</span><span><b>{c.name || c.companionId}</b><small>{c.companionId} · {c.format === 'dir' ? `${c.shardCount} 个档案分片` : '单文件人设'}</small></span><ChevronRight className="ml-auto" size={16}/></button>)}</section><section className="persona-profile-editor">{profileState.loading || !profile ? <Loading/> : profileState.error ? <ErrorBox error={profileState.error}/> : <><div className="persona-editor-head"><div><span className="page-header-kicker">Profile / {selected?.name || selectedId}</span><h3>她的完整背景</h3><p>未知的信息保持空白，不替她编造；填好后会进入角色档案和下一轮对话上下文。</p></div><button className="btn btn-primary" onClick={save} disabled={saving}><Save size={15}/>{saving ? '保存中' : '保存档案'}</button></div><div className="profile-section"><div className="profile-section-title"><span>01</span><div><b>身份与出生</b><small>对外身份、生日和小名</small></div></div><div className="profile-fields"><label className="field"><span>法定姓名</span><input className="input" value={profile.legalName || ''} onChange={e => setField('legalName', e.target.value)}/></label><label className="field"><span>小名 / 昵称（逗号分隔）</span><input className="input" value={(profile.nicknames || []).join('、')} onChange={e => setField('nicknames', e.target.value.split(/[、,，]/).map(x => x.trim()).filter(Boolean))}/></label><label className="field"><span>出生日期</span><input className="input" type="date" value={profile.birthDate || ''} onChange={e => setField('birthDate', e.target.value)}/></label><label className="field"><span>出生地</span><input className="input" value={profile.birthPlace || ''} onChange={e => setField('birthPlace', e.target.value)}/></label><label className="field"><span>性别</span><input className="input" value={profile.gender || ''} onChange={e => setField('gender', e.target.value)}/></label><label className="field"><span>国籍</span><input className="input" value={profile.nationality || ''} onChange={e => setField('nationality', e.target.value)}/></label></div></div><div className="profile-section"><div className="profile-section-title"><span>02</span><div><b>家庭关系</b><small>爸爸、妈妈和重要家人；可继续添加</small></div><button className="btn" onClick={addFamily}><Plus size={15}/>添加家人</button></div><div className="family-editor">{(profile.family || []).map((member, index) => <div className="family-row" key={`${member.relation}-${index}`}><div className="family-row-top"><b>{member.relation || '家人'}</b><button className="icon-button" onClick={() => removeFamily(index)} aria-label="删除家人"><X size={14}/></button></div><div className="profile-fields"><label className="field"><span>关系</span><input className="input" value={member.relation || ''} onChange={e => setFamily(index, 'relation', e.target.value)}/></label><label className="field"><span>姓名</span><input className="input" value={member.name || ''} onChange={e => setFamily(index, 'name', e.target.value)}/></label><label className="field"><span>职业 / 身份</span><input className="input" value={member.occupation || ''} onChange={e => setFamily(index, 'occupation', e.target.value)}/></label><label className="field"><span>所在地</span><input className="input" value={member.location || ''} onChange={e => setFamily(index, 'location', e.target.value)}/></label><label className="field field-wide"><span>相处与备注</span><input className="input" value={member.notes || ''} onChange={e => setFamily(index, 'notes', e.target.value)}/></label></div></div>)}{!(profile.family || []).length && <Empty>还没有家庭成员档案，点击“添加家人”开始建立。</Empty>}</div></div><div className="profile-section"><div className="profile-section-title"><span>03</span><div><b>证件信息</b><small>只用于角色身份连续性，页面默认不回显完整号码</small></div></div><div className="profile-fields"><label className="field"><span>身份证号</span><input className="input" type="password" placeholder={profile.idCardNumberMasked || '未填写；保存后只显示末 4 位'} value={profile.idCardNumber || ''} onChange={e => setField('idCardNumber', e.target.value)}/></label><label className="field"><span>护照号</span><input className="input" type="password" placeholder={profile.passportNumberMasked || '未填写；保存后只显示末 4 位'} value={profile.passportNumber || ''} onChange={e => setField('passportNumber', e.target.value)}/></label></div><p className="profile-privacy-note"><ShieldCheck size={15}/>证件原文不会进入对话提示词，接口也不会回传完整号码。</p></div><div className="profile-section"><div className="profile-section-title"><span>04</span><div><b>生理期与身体周期</b><small>用于更自然地理解疲倦、腹痛和需要照顾的日子</small></div></div><div className="profile-toggle-row"><label className="profile-switch"><input type="checkbox" checked={Boolean(profile.menstrual?.enabled)} onChange={e => setMenstrual('enabled', e.target.checked)}/><span>启用周期记录</span></label><label className="profile-switch"><input type="checkbox" checked={Boolean(profile.menstrual?.remindersEnabled)} onChange={e => setMenstrual('remindersEnabled', e.target.checked)}/><span>允许主动提醒</span></label></div><div className="profile-fields"><label className="field"><span>上次周期开始日</span><input className="input" type="date" value={profile.menstrual?.lastPeriodStart || ''} onChange={e => setMenstrual('lastPeriodStart', e.target.value)}/></label><label className="field"><span>平均周期（天）</span><input className="input" type="number" min="18" max="60" value={profile.menstrual?.cycleLengthDays || 28} onChange={e => setMenstrual('cycleLengthDays', Number(e.target.value))}/></label><label className="field"><span>经期长度（天）</span><input className="input" type="number" min="2" max="14" value={profile.menstrual?.periodLengthDays || 5} onChange={e => setMenstrual('periodLengthDays', Number(e.target.value))}/></label><label className="field field-wide"><span>身体备注</span><input className="input" value={profile.menstrual?.notes || ''} onChange={e => setMenstrual('notes', e.target.value)}/></label></div></div></>}</section></div></>;
}

function Operations({ scope }) { const [health,reload]=useEndpoint('/api/health',[]); const [jobs]=useEndpoint(`/api/jobs?${qs(scope)}`,[scope.userId,scope.companionId]); const actions=[['settle','状态回落'],['reflect','生成反思'],['story','更新故事'],['dedupe','合并记忆'],['nightly','夜间维护']]; const run=async action=>{await api('/api/actions',json('POST',{scope,action}));reload()}; return <><Header title="自动化与运维" text="健康检查、后台任务和日常维护入口。"/><div className="grid gap-5 lg:grid-cols-2"><Card title="一键维护" icon={Zap}><div className="grid grid-cols-2 gap-2">{actions.map(([id,label])=><button className="btn justify-start" key={id} onClick={()=>run(id)}>{label}</button>)}</div></Card><Card title="系统健康" icon={Activity}>{health.loading?<Loading/>:Object.entries(health.data?.config||{}).map(([k,v])=><ListRow key={k} title={k} end={<span className={`badge ${v?'badge-ok':'badge-warn'}`}>{v?'就绪':'未配置'}</span>}/>)}</Card><div className="panel lg:col-span-2"><h3 className="font-bold">任务队列</h3><div className="mt-3">{(jobs.data?.jobs||[]).slice(0,20).map(j=><ListRow key={j.id} title={j.kind} sub={`${fmt(j.created_at)} · 尝试 ${j.attempts||0}`} end={<span className="badge">{j.status}</span>}/>)}</div></div></div></> }

function Config() { const [s,reload]=useEndpoint('/api/config',[]); const [values,setValues]=useState({}); const [dirty,setDirty]=useState({}); useEffect(()=>setValues(Object.fromEntries(Object.entries(s.data?.values||{}).map(([k,v])=>[k,v?.value??'']))),[s.data]); const set=(k,v)=>{setValues(x=>({...x,[k]:v}));setDirty(x=>({...x,[k]:v}))}; const save=async()=>{await api('/api/config',json('PUT',{values:dirty}));setDirty({});reload()}; if(s.loading)return <Loading/>; return <div className="config-page"><Header title="设置与模型" text="凭证只保存在本机 .env，密钥读取时始终脱敏。" action={<button className="btn btn-primary" disabled={!Object.keys(dirty).length} onClick={save}><Save size={15}/>保存 {Object.keys(dirty).length||''}</button>}/><div className="config-grid">{(s.data?.schema||[]).map((group,index)=><section className={`panel config-card ${index===0?'config-card-featured':''}`} key={group.id}><div className="config-card-head"><span>{String(index+1).padStart(2,'0')}</span><div><h3>{group.title}</h3><p>{group.hint}</p></div></div><div className="config-fields">{[...(group.fields||[]),...(group.advanced||[])].map(f=><label className="field" key={f.key}><span>{f.label}</span>{f.options?<select className="input" value={values[f.key]||''} onChange={e=>set(f.key,e.target.value)}><option value="">请选择</option>{f.options.map(o=><option key={o}>{o}</option>)}</select>:<input className="input" type={f.secret?'password':f.type||'text'} value={values[f.key]||''} placeholder={f.secret&&s.data?.values?.[f.key]?.set?'已配置，输入新值才会替换':f.placeholder||''} onChange={e=>set(f.key,e.target.value)}/>}</label>)}</div></section>)}</div></div> }

function Chat({ scope }) {
  const [messages, setMessages] = useState([{ role: 'system', text: '这是和真实编排器相同的对话管线。发一句话开始。' }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [debug, setDebug] = useState(null);
  const [selectedPhoto, setSelectedPhoto] = useState(null);
  const [activeChannel, setActiveChannel] = useState('general');
  const logRef = useRef(null);
  const channels = [['general', '大厅'], ['daily', '日常记录'], ['memories', '记忆回声'], ['photos', '照片分享']];

  useEffect(() => { const log = logRef.current; if (log) log.scrollTop = log.scrollHeight; }, [messages, busy]);

  const send = async event => {
    event.preventDefault();
    const message = input.trim();
    if (!message || busy) return;
    setInput(''); setMessages(current => [...current, { role: 'user', text: message }]); setBusy(true);
    try {
      const result = await api('/api/chat', json('POST', { message, userId: scope.userId || 'ui:playground', companionId: scope.companionId, debug: debugEnabled }));
      if (!result.ok) throw new Error(result.message || '生成失败');
      const replyMessages = (result.parts || []).map(part => ({ role: part.type === 'narration' ? 'narration' : 'assistant', text: part.text }));
      const photoMessages = (result.photos || []).map(photo => ({ role: 'photo', ...photo }));
      setMessages(current => [...current, ...replyMessages, ...photoMessages]); setDebug(result.debug || null);
    } catch (error) { setMessages(current => [...current, { role: 'error', text: error.message }]); } finally { setBusy(false); }
  };

  const renderMessage = (item, index) => {
    if (item.role === 'system') return <div className="discord-welcome" key={index}><div className="discord-welcome-mark"><Hash size={34}/></div><h2>欢迎来到 #{activeChannel}</h2><p>这是你和沈清词的私密空间。发送第一条消息，开始留下新的记忆。</p></div>;
    if (item.role === 'photo') return <div className="discord-message" key={index}><div className="discord-avatar avatar-her">沈</div><div className="discord-message-body"><div className="discord-message-meta"><b>沈清词</b><time>刚刚</time></div><div className="discord-photo-wrap"><button className="discord-photo-button" onClick={() => setSelectedPhoto(item.url)}><img src={item.url} alt="她分享的照片"/>{item.reason && <span>{item.kind === 'selfie' ? '自拍' : '照片'} · {item.reason}</span>}</button><button className="discord-photo-remove" aria-label="删除这张照片" onClick={() => setMessages(current => current.filter((_, messageIndex) => messageIndex !== index))}><X size={14}/></button></div></div></div>;
    if (item.role === 'narration') return <div className="discord-narration" key={index}><span>SCENE</span>{item.text}</div>;
    const isUser = item.role === 'user';
    return <div className={`discord-message ${isUser ? 'is-user' : ''} ${item.role === 'error' ? 'is-error' : ''}`} key={index}><div className={`discord-avatar ${isUser ? 'avatar-user' : 'avatar-her'}`}>{isUser ? '你' : '沈'}</div><div className="discord-message-body"><div className="discord-message-meta"><b>{isUser ? '你' : '沈清词'}</b><time>刚刚</time></div><p>{item.text}</p></div></div>;
  };

  return <div className="discord-chat-shell">
    <aside className="discord-channel-sidebar"><div className="discord-server-header"><div><strong>Memory System</strong><small>私密工作区</small></div><ChevronDown size={16}/></div><div className="discord-channel-scroll scrollbar"><div className="discord-channel-category"><span>文字频道</span><Plus size={15}/></div>{channels.map(([id, label]) => <button key={id} className={`discord-channel ${activeChannel === id ? 'is-active' : ''}`} onClick={() => setActiveChannel(id)}><Hash size={18}/><span>{label}</span>{id === 'general' && <span className="discord-channel-live"/>}</button>)}<div className="discord-channel-category discord-category-spaced"><span>关系空间</span><Plus size={15}/></div><button className="discord-channel"><Heart size={17}/><span>她的状态</span></button><button className="discord-channel"><Brain size={17}/><span>长期记忆</span></button></div><div className="discord-user-panel"><div className="discord-avatar avatar-user">你</div><div className="discord-user-copy"><b>当前用户</b><small>{scope.userId || 'ui:playground'}</small></div><button aria-label="麦克风"><Mic size={15}/></button><button aria-label="耳机"><Headphones size={15}/></button><button aria-label="设置"><Settings2 size={15}/></button></div></aside>
    <section className="discord-conversation"><header className="discord-channel-header"><div className="discord-channel-title"><Hash size={22}/><strong>{channels.find(([id]) => id === activeChannel)?.[1] || activeChannel}</strong><span>和她聊天、记录此刻，所有内容都会经过真实记忆管线</span></div><div className="discord-channel-actions"><span className="discord-online-pill"><i/> 记忆管线在线</span><button aria-label="置顶"><Pin size={17}/></button><button aria-label="成员"><UsersRound size={18}/></button><button aria-label="更多"><MoreHorizontal size={19}/></button><label className="discord-debug-toggle"><input type="checkbox" checked={debugEnabled} onChange={event => setDebugEnabled(event.target.checked)}/> 调试</label></div></header><div ref={logRef} className="discord-message-list scrollbar">{messages.map(renderMessage)}{busy && <div className="discord-message discord-typing"><div className="discord-avatar avatar-her">沈</div><div><div className="discord-message-meta"><b>沈清词</b><time>正在输入</time></div><div className="discord-typing-dots"><i/><i/><i/></div></div></div>}</div>{debugEnabled && debug && <details className="discord-debug-panel" open><summary>本轮调试详情</summary><pre>{JSON.stringify(debug, null, 2)}</pre></details>}<form onSubmit={send} className="discord-composer"><button type="button" aria-label="添加附件"><Plus size={20}/></button><input value={input} onChange={event => setInput(event.target.value)} placeholder={`发送消息到 #${channels.find(([id]) => id === activeChannel)?.[1] || activeChannel}`}/><button type="button" aria-label="添加表情"><Smile size={20}/></button><button className="discord-send" disabled={busy || !input.trim()}>{busy ? <LoaderCircle className="animate-spin" size={17}/> : '发送'}</button></form><div className="discord-composer-hint">按 Enter 发送 · Shift + Enter 换行 · 当前模型回复会同步写入记忆</div></section>
    <aside className="discord-member-sidebar"><div className="discord-member-title">在线成员 · 2</div><div className="discord-member-section">在线 — 2</div><div className="discord-member"><div className="discord-avatar avatar-her">沈</div><div><b>沈清词</b><small>正在自己的生活里</small></div><span className="discord-status-dot"/></div><div className="discord-member"><div className="discord-avatar avatar-bot">M</div><div><b>Memory Core</b><small>真实编排器 · 本地</small></div><span className="discord-status-dot is-bot"/></div><div className="discord-member-about"><span>当前会话</span><b>{scope.companionId || 'default'}</b><small>{scope.userId || 'ui:playground'}</small></div></aside>
  </div>;
}

function App() {
  const init = location.hash.slice(1) || 'overview';
  const [active, setActive] = useState(nav.some(item => item[0] === init) ? init : 'overview');
  const [mobile, setMobile] = useState(false);
  const [scope, setScope] = useState({ userId: '', companionId: 'default' });
  const [scopes, setScopes] = useState([]);
  const [scopesLoading, setScopesLoading] = useState(true);
  const [bot, setBot] = useState(null);
  const [dark, setDark] = useState(() => localStorage.getItem('memory-ui-theme') === 'dark' || (!localStorage.getItem('memory-ui-theme') && matchMedia('(prefers-color-scheme: dark)').matches));

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('memory-ui-theme', dark ? 'dark' : 'light');
  }, [dark]);
  useEffect(() => {
    api('/api/scopes').then(response => {
      const list = response.scopes || [];
      setScopes(list);
      if (list[0]) setScope({ userId: list[0].userId, companionId: list[0].companionId || 'default' });
    }).catch(() => {}).finally(() => setScopesLoading(false));
    const poll = () => api('/api/bot').then(setBot).catch(() => {});
    poll();
    const timer = setInterval(poll, 4000);
    return () => clearInterval(timer);
  }, []);

  const go = id => { setActive(id); location.hash = id; setMobile(false); };
  const startBot = async () => {
    await api(`/api/bot/${bot?.running ? 'stop' : 'start'}`, { method: 'POST' });
    setBot(await api('/api/bot'));
  };
  const view = useMemo(() => ({
    overview: <Overview scope={scope}/>, 'companion-v2': <CompanionV2 scope={scope}/>, state: <StateView scope={scope}/>,
    personas: <Personas scope={scope} onCompanion={companionId => setScope(value => ({ ...value, companionId }))}/>, world: <World scope={scope}/>, gallery: <Gallery scope={scope}/>,
    memories: <Memories scope={scope}/>, prospective: <Prospective scope={scope}/>, graph: <Graph scope={scope}/>,
    operations: <Operations scope={scope}/>, chat: <Chat scope={scope}/>, config: <Config/>,
  })[active], [active, scope.userId, scope.companionId]);

  return <div className="lumen-console min-h-screen">
    <div className="pointer-events-none fixed inset-0 dot-grid"/>
    <Sidebar active={active} go={go} scope={scope} bot={bot} startBot={startBot} mobile={mobile} closeMobile={() => setMobile(false)}/>
    <main className="app-main relative">
      <header className="app-header sticky top-0 z-30 flex h-20 items-center gap-3 px-4 sm:px-7">
        <button className="btn px-3 lg:hidden" onClick={() => setMobile(true)}><Menu size={18}/></button>
        <div className="app-workspace hidden text-xs font-semibold uppercase tracking-[.12em] sm:block">Workspace / Memory System</div>
        <select className="input max-w-64" value={`${scope.userId}|${scope.companionId}`} onChange={event => { const [userId, companionId] = event.target.value.split('|'); setScope({ userId, companionId }); }}>
          <option value={`|${scope.companionId}`}>选择用户与角色</option>
          {scopes.map((item, index) => <option key={`${item.userId}-${item.companionId}-${index}`} value={`${item.userId}|${item.companionId || 'default'}`}>{item.userId} · {(item.companionId || 'default') === 'default' ? '沈清词' : item.companionId}</option>)}
        </select>
        <div className="ml-auto flex items-center gap-2">
          <button className="theme-toggle btn px-3" onClick={() => setDark(value => !value)} aria-label={dark ? '切换浅色' : '切换深色'}>{dark ? <Sun size={16}/> : <Moon size={16}/>}</button>
          <span className="badge hidden sm:inline-flex"><Database size={13}/>{scope.userId ? (scope.companionId === 'default' ? '沈清词' : scope.companionId) : '未选择'}</span>
          <span className="badge badge-ok"><span className="size-1.5 bg-emerald-500"/>Local</span>
        </div>
      </header>
      <div className="app-content mx-auto max-w-7xl p-4 sm:p-7 lg:p-9"><div className="page-folio">{String(nav.findIndex(item => item[0] === active) + 1).padStart(2, '0')}</div>{scopesLoading ? <Loading/> : !scope.userId && !['config', 'personas'].includes(active) ? <Empty>先选择一个用户与角色，才能读取她此刻的状态。</Empty> : view}</div>
    </main>
    {mobile && <button className="fixed inset-0 z-30 bg-black/20 lg:hidden" onClick={() => setMobile(false)}/>}
  </div>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);
