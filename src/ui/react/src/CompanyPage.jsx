import React, { useEffect, useState } from 'react';
import {
  Activity, Building2, BriefcaseBusiness, Clock3, MapPin, MessageCircle,
  Play, RefreshCw, ShieldCheck, Target, TriangleAlert, Users,
} from 'lucide-react';

const STAGE_LABELS = {
  planning: '规划中', setup: '启动', rising: '推进中', climax: '关键节点',
  cooldown: '收尾', closed: '已结束', done: '已完成', cancelled: '已取消',
};

export default function CompanyPage({ scope, api, qs, Header, Loading, ErrorBox, Empty, onGoChat }) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [advancing, setAdvancing] = useState(false);
  const [notice, setNotice] = useState('');

  const load = async () => {
    setState(current => ({ ...current, loading: true, error: '' }));
    try {
      const data = await api(`/api/company?${qs(scope)}`);
      setState({ loading: false, data, error: data?.ok === false ? data.message || '公司系统尚未就绪' : '' });
    } catch (error) {
      setState({ loading: false, data: null, error: error.message });
    }
  };

  useEffect(() => { load(); }, [scope.userId, scope.companionId]);

  const advance = async () => {
    if (!scope.userId || advancing) return;
    setAdvancing(true);
    setNotice('');
    try {
      const result = await api('/api/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'company-tick', ...scope }),
      });
      if (!result.ok) throw new Error(result.message || '经营进展生成失败');
      setNotice(result.result ? `已推进：${result.result.title} · ${result.result.content}` : '今天的经营线已达到推进上限');
      await load();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setAdvancing(false);
    }
  };

  if (state.loading) return <Loading/>;
  if (state.error) return <ErrorBox error={state.error}/>;
  const company = state.data?.company;
  if (!company) return <Empty>这个角色还没有公司档案。</Empty>;

  const operations = company.operations || {};
  const location = company.locations?.[0];
  return <div className="space-y-5">
    <Header
      title="公司系统"
      text="固定公司事实、组织、核心成员和持续经营项目。聊天与这里使用同一套公司世界线。"
      action={<div className="flex flex-wrap gap-2">
        <button className="btn" onClick={load}><RefreshCw size={15}/>刷新</button>
        <button className="btn" onClick={onGoChat}><MessageCircle size={15}/>聊工作</button>
        <button className="btn btn-primary" disabled={!scope.userId || advancing} onClick={advance}>
          {advancing ? <RefreshCw className="animate-spin" size={15}/> : <Play size={15}/>}推进今日经营
        </button>
      </div>}
    />

    {(state.data?.issues || []).length > 0 && <div className="panel border-amber-300 bg-amber-50 text-sm text-amber-800">
      公司档案可用，但实时项目进展暂未连接：{state.data.issues.join('；')}
    </div>}
    {notice && <div className="panel border-violet-200 bg-violet-50 text-sm text-violet-800">{notice}</div>}

    <section className="panel overflow-hidden p-0">
      <div className="bg-zinc-950 px-6 py-7 text-white sm:px-8">
        <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
          <div>
            <div className="mb-4 flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[.16em] text-zinc-400">
              <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 ${operations.open ? 'border-emerald-500/40 text-emerald-300' : 'border-zinc-700 text-zinc-400'}`}>
                <span className={`size-1.5 rounded-full ${operations.open ? 'bg-emerald-400' : 'bg-zinc-500'}`}/>{operations.label}
              </span>
              <span>{operations.localTime || '—'} · {company.officeHours?.timezone}</span>
              <span>{operations.phaseLabel} · {operations.workMode}</span>
            </div>
            <h3 className="text-3xl font-bold tracking-tight sm:text-4xl">{company.name}</h3>
            <p className="mt-2 text-sm text-zinc-400">{company.legalName}</p>
            <p className="mt-5 max-w-3xl text-sm leading-7 text-zinc-300">{company.description}</p>
          </div>
          <div className="grid min-w-64 grid-cols-2 gap-2 text-sm">
            <CompanyMeta icon={Users} label="团队规模" value={company.scale}/>
            <CompanyMeta icon={Activity} label="在途项目" value={`${operations.activeProjectCount || 0} 项`}/>
            <CompanyMeta icon={Building2} label="组织部门" value={`${company.departments?.length || 0} 个`}/>
            <CompanyMeta icon={MapPin} label="总部" value={company.headquarters}/>
          </div>
        </div>
      </div>
      <div className="grid gap-px bg-zinc-100 sm:grid-cols-3">
        <SummaryCell label="经营阶段" value={company.stage}/>
        <SummaryCell label="所有权" value={company.ownership}/>
        <SummaryCell label="使命" value={company.mission}/>
      </div>
    </section>

    <section className="panel">
      <SectionTitle icon={Target} title="今日经营重点" meta={`${operations.priorities?.length || 0} PRIORITIES`}/>
      <div className="mt-4 rounded-2xl border border-violet-100 bg-violet-50/70 p-4">
        <span className="text-[10px] font-semibold uppercase tracking-[.14em] text-violet-500">当前焦点</span>
        <p className="mt-2 text-sm font-semibold leading-6 text-zinc-800">{operations.todayFocus || '暂无待推进事项'}</p>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-3">{(operations.priorities || []).map(priority => <article className="rounded-xl border border-zinc-200 p-4" key={priority.projectId}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">P{priority.rank}</span>
          <StageBadge stage={priority.stage}/>
        </div>
        <h3 className="mt-3 text-sm font-bold">{priority.projectName}</h3>
        <p className="mt-2 text-xs leading-5 text-zinc-600">{priority.action}</p>
        <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-zinc-400">
          <span>负责人：{priority.owner || '待定'}</span>
          {priority.risk && <span className="inline-flex items-center gap-1 text-amber-600"><TriangleAlert size={12}/>有风险</span>}
        </div>
      </article>)}</div>
    </section>

    <div className="grid gap-5 xl:grid-cols-[1.05fr_1.95fr]">
      <div className="space-y-5">
        <section className="panel">
          <SectionTitle icon={ShieldCheck} title="董事长办公室" meta="LEADERSHIP"/>
          <div className="mt-5 rounded-2xl bg-zinc-950 p-5 text-white">
            <span className="text-xs font-semibold uppercase tracking-[.16em] text-violet-300">{company.leader?.title}</span>
            <h3 className="mt-2 text-2xl font-bold">{company.leader?.name}</h3>
            <p className="mt-3 text-sm leading-6 text-zinc-400">{company.leader?.managementStyle}</p>
            <div className="mt-4 flex flex-wrap gap-2">{(company.leader?.responsibilities || []).map(item => <span className="rounded-full border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300" key={item}>{item}</span>)}</div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            <InfoLine icon={Clock3} label="办公时间" value={`${company.officeHours?.start}–${company.officeHours?.end}`}/>
            <InfoLine icon={MapPin} label={location?.name || '办公地点'} value={location ? `${location.city} · ${location.address}` : company.headquarters}/>
          </div>
        </section>

        <section className="panel">
          <SectionTitle icon={BriefcaseBusiness} title="业务结构" meta={`${company.businessLines?.length || 0} LINES`}/>
          <div className="mt-3 divide-y divide-zinc-100">{(company.businessLines || []).map(line => <div className="py-4" key={line.id}>
            <div className="font-semibold">{line.name}</div>
            <p className="mt-1 text-sm leading-6 text-zinc-500">{line.description}</p>
            <small className="mt-2 block text-xs text-violet-600">{line.revenueModel}</small>
          </div>)}</div>
        </section>
      </div>

      <div className="space-y-5">
        <section className="panel">
          <SectionTitle icon={Activity} title="经营项目线" meta={state.data?.storyConnected ? 'LIVE STORY DATA' : 'CONFIG SNAPSHOT'}/>
          <div className="mt-5 grid gap-4">{(company.projects || []).map(project => <article className="rounded-2xl border border-zinc-200 p-5" key={project.id}>
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div>
                <div className="flex flex-wrap items-center gap-2"><h3 className="font-bold">{project.name}</h3><StageBadge stage={project.stage}/><FreshnessBadge freshness={project.freshness}/></div>
                <p className="mt-2 text-sm leading-6 text-zinc-500">{project.description}</p>
              </div>
              <div className="shrink-0 text-right text-xs text-zinc-400"><b className="block text-zinc-700">{project.owner}</b>{project.department}</div>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <ProjectFact label="当前进展" value={project.lastBeat || '尚未记录'}/>
              <ProjectFact label="下一节点" value={project.nextBeat || '待确定'}/>
              <ProjectFact label="主要风险" value={project.risk || '暂无明确风险'}/>
            </div>
          </article>)}</div>
        </section>

        <section className="panel">
          <SectionTitle icon={Users} title="组织与核心成员" meta={`${company.people?.length || 0} KEY PEOPLE`}/>
          <div className="mt-5 grid gap-4 md:grid-cols-2">{(company.people || []).map(person => <article className="rounded-2xl bg-zinc-50 p-4" key={person.name}>
            <div className="flex items-start justify-between gap-3"><div><h3 className="font-bold">{person.name}</h3><p className="mt-1 text-xs font-semibold text-violet-600">{person.title}</p></div><span className="rounded-full bg-white px-2.5 py-1 text-[11px] text-zinc-500">{person.department}</span></div>
            <p className="mt-3 text-sm leading-6 text-zinc-600">{person.personality}</p>
            <p className="mt-2 text-xs leading-5 text-zinc-400">与清词：{person.relationship}</p>
          </article>)}</div>
          <div className="mt-5 grid gap-3 md:grid-cols-2">{(company.departments || []).map(department => <div className="rounded-xl border border-zinc-200 p-4" key={department.id}>
            <div className="flex items-center justify-between"><b>{department.name}</b><span className="text-xs text-zinc-400">{department.headcount || '—'} 人</span></div>
            <p className="mt-1 text-xs text-zinc-500">负责人：{department.lead}</p>
            <p className="mt-3 text-xs leading-5 text-zinc-400">{department.responsibilities?.join(' · ')}</p>
          </div>)}</div>
        </section>
      </div>
    </div>
  </div>;
}

function SectionTitle({ icon: Icon, title, meta }) {
  return <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Icon size={17}/><h3 className="font-bold">{title}</h3></div><span className="text-[10px] font-semibold uppercase tracking-[.15em] text-zinc-400">{meta}</span></div>;
}

function CompanyMeta({ icon: Icon, label, value }) {
  return <div className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-3"><Icon className="text-violet-300" size={15}/><span className="mt-2 block text-[10px] uppercase tracking-wider text-zinc-500">{label}</span><b className="mt-1 block text-xs text-zinc-200">{value || '—'}</b></div>;
}

function SummaryCell({ label, value }) {
  return <div className="bg-white p-5"><span className="text-[10px] font-semibold uppercase tracking-[.14em] text-zinc-400">{label}</span><p className="mt-2 text-sm font-medium leading-6 text-zinc-700">{value || '—'}</p></div>;
}

function InfoLine({ icon: Icon, label, value }) {
  return <div className="flex items-center gap-3 rounded-xl bg-zinc-50 p-3"><Icon className="text-zinc-400" size={16}/><div><span className="block text-[10px] uppercase tracking-wider text-zinc-400">{label}</span><b className="mt-0.5 block text-xs">{value || '—'}</b></div></div>;
}

function StageBadge({ stage }) {
  const active = !['closed', 'done', 'cancelled'].includes(stage);
  return <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${active ? 'bg-emerald-50 text-emerald-700' : 'bg-zinc-100 text-zinc-500'}`}>{STAGE_LABELS[stage] || stage}</span>;
}

function FreshnessBadge({ freshness }) {
  const stale = freshness?.kind === 'stale';
  return <span className={`rounded-full px-2.5 py-1 text-[11px] ${stale ? 'bg-amber-50 text-amber-700' : 'bg-zinc-100 text-zinc-500'}`}>{freshness?.label || '配置基线'}</span>;
}

function ProjectFact({ label, value }) {
  return <div className="rounded-xl bg-zinc-50 p-3"><span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">{label}</span><p className="mt-1.5 text-xs leading-5 text-zinc-600">{value}</p></div>;
}
