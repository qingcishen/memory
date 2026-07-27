import React, { useState } from 'react';
import {
  BookHeart, CalendarHeart, Clock, Heart, Image, LoaderCircle, MessageCircle,
  RefreshCw, Shirt, Sparkles, WandSparkles,
} from 'lucide-react';

/**
 * P2 用户端 · 生活页：时间线 + 关系 + 今日她在做什么 + 相册快览
 * 不打开开发者控制台也能「陪她过日子」。
 */
export default function LifePage({ scope, api, qs, Header, Loading, ErrorBox, Empty, onGoChat, onGoAlbum }) {
  const key = `${scope.userId}|${scope.companionId}`;
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = React.useCallback(() => {
    if (!scope.userId) {
      setLoading(false);
      setData(null);
      return;
    }
    setLoading(true);
    setError('');
    api(`/api/product/life?${qs(scope)}`)
      .then(setData)
      .catch((e) => setError(e.message || String(e)))
      .finally(() => setLoading(false));
  }, [scope.userId, scope.companionId]);

  React.useEffect(() => { load(); }, [load, key]);

  if (!scope.userId) return <Empty>先选择用户与角色，才能看到你们的日子。</Empty>;
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data?.ok) return <ErrorBox error={data?.message || '加载失败'} />;

  const day = data.day || {};
  const rel = data.relationship || {};
  const stage = rel.stage || {};
  const feel = rel.feel || {};
  const events = data.timeline || [];
  const photos = data.photos || [];
  const milestones = rel.milestones || [];

  return (
    <>
      <Header
        title="一起过日子"
        text="时间线 · 关系阶段 · 今日生活 · 相册。不用进控制台参数页，也能陪在她身边。"
        action={(
          <div className="flex gap-2">
            <button type="button" className="btn" onClick={load}><RefreshCw size={15} />刷新</button>
            {onGoChat && <button type="button" className="btn btn-primary" onClick={onGoChat}><MessageCircle size={15} />去聊天</button>}
          </div>
        )}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="panel lg:col-span-1">
          <div className="mb-3 flex items-center gap-2 text-violet-600">
            <Sparkles size={18} />
            <h3 className="font-bold text-zinc-900 dark:text-zinc-100">今天的她</h3>
          </div>
          <DayRow icon={Clock} label="在做什么" value={day.activity || '自由时间'} />
          <DayRow icon={Heart} label="精力 / 健康" value={`${pct(day.energy)} · ${pct(day.health)}${day.sick ? ' · 身体不适' : ''}`} />
          <DayRow icon={Shirt} label="穿搭" value={day.outfit || '还没记下今天的衣服'} />
          <DayRow icon={WandSparkles} label="生活进展" value={day.storyBeat ? `${day.storyTitle || ''}：${day.storyBeat}` : '今天还没有新故事拍'} />
          {day.sick && (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              她身体不太舒服，聊天时语气会软、话会少一点。
            </p>
          )}
        </section>

        <section className="panel lg:col-span-1">
          <div className="mb-3 flex items-center gap-2 text-rose-600">
            <BookHeart size={18} />
            <h3 className="font-bold text-zinc-900 dark:text-zinc-100">你们的关系</h3>
          </div>
          <div className="mb-3">
            <span className="badge badge-ok">{stage.label || stage.id || '—'}</span>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300 whitespace-pre-line">{stage.script || '关系还在慢慢长。'}</p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <FeelChip label="亲近" value={feel.closeness} />
            <FeelChip label="信任" value={feel.trust} />
            <FeelChip label="气氛" value={feel.tension} />
            <FeelChip label="和好" value={feel.repair} />
          </div>
          {stage.behavior?.recoveryPath && (
            <p className="mt-3 text-xs text-zinc-500">可恢复：{stage.behavior.recoveryPath}</p>
          )}
        </section>

        <section className="panel lg:col-span-1">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sky-600">
              <Image size={18} />
              <h3 className="font-bold text-zinc-900 dark:text-zinc-100">相册快览</h3>
            </div>
            {onGoAlbum && <button type="button" className="btn px-2 text-xs" onClick={onGoAlbum}>全部</button>}
          </div>
          {photos.length ? (
            <div className="grid grid-cols-3 gap-2">
              {photos.slice(0, 9).map((p) => (
                <a key={p.id || p.url} href={p.url} target="_blank" rel="noreferrer" className="aspect-square overflow-hidden rounded-lg bg-zinc-100">
                  <img src={p.url} alt="" className="h-full w-full object-cover" loading="lazy" />
                </a>
              ))}
            </div>
          ) : (
            <Empty>还没有照片。自拍或相册成片会出现在这里。</Empty>
          )}
        </section>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-5">
        <section className="panel lg:col-span-3">
          <div className="mb-4 flex items-center gap-2">
            <Clock size={18} className="text-violet-600" />
            <h3 className="font-bold">生活时间线</h3>
            <span className="badge ml-auto">{events.length} 条</span>
          </div>
          <div className="space-y-3 max-h-[28rem] overflow-y-auto scrollbar pr-1">
            {events.length ? events.map((ev) => (
              <article key={ev.id} className="flex gap-3 border-b border-zinc-100 pb-3 dark:border-zinc-800">
                <KindDot kind={ev.kind} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 text-xs text-zinc-400">
                    <strong className="text-zinc-700 dark:text-zinc-200">{ev.title}</strong>
                    <span className="badge">{kindLabel(ev.kind)}</span>
                    <time className="ml-auto shrink-0">{fmt(ev.at)}</time>
                  </div>
                  <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap break-words">{ev.body}</p>
                </div>
              </article>
            )) : (
              <Empty>时间线还是空的。聊几句、出个故事拍、存张照片，日子就会写在这里。</Empty>
            )}
          </div>
        </section>

        <section className="panel lg:col-span-2">
          <div className="mb-4 flex items-center gap-2">
            <CalendarHeart size={18} className="text-rose-500" />
            <h3 className="font-bold">里程碑</h3>
          </div>
          <div className="space-y-2 max-h-[28rem] overflow-y-auto scrollbar">
            {milestones.length ? milestones.map((m, i) => (
              <div key={`${m.title}-${i}`} className="rounded-xl bg-zinc-50 px-3 py-2 dark:bg-zinc-900/50">
                <div className="text-xs text-zinc-400">{fmt(m.at)} · {m.kind}</div>
                <div className="mt-0.5 text-sm">{m.title}</div>
              </div>
            )) : (
              <Empty>纪念日与「第一次 / 和好 / 出差」等篇章会汇到这里。</Empty>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

function DayRow({ icon: Icon, label, value }) {
  return (
    <div className="mb-2 flex gap-2 rounded-xl bg-zinc-50 px-3 py-2 dark:bg-zinc-900/40">
      <Icon size={16} className="mt-0.5 shrink-0 text-zinc-400" />
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wide text-zinc-400">{label}</div>
        <div className="text-sm text-zinc-700 dark:text-zinc-200 break-words">{value}</div>
      </div>
    </div>
  );
}

function FeelChip({ label, value }) {
  return (
    <div className="rounded-xl border border-zinc-100 px-2 py-2 dark:border-zinc-800">
      <div className="text-[10px] text-zinc-400">{label}</div>
      <div className="text-xs font-medium">{value || '—'}</div>
    </div>
  );
}

function KindDot({ kind }) {
  const colors = {
    chat: 'bg-violet-400',
    episode: 'bg-amber-400',
    story: 'bg-sky-400',
    photo: 'bg-rose-400',
    milestone: 'bg-emerald-400',
  };
  return <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${colors[kind] || 'bg-zinc-300'}`} />;
}

function kindLabel(kind) {
  return { chat: '对话', episode: '篇章', story: '故事', photo: '照片', milestone: '纪念' }[kind] || kind;
}

function pct(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return `${Math.round(Number(v) * 100)}%`;
}

function fmt(value) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  } catch {
    return '—';
  }
}
