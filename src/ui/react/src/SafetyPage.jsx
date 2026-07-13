import React, { useEffect, useState } from 'react';
import {
  Download, LoaderCircle, RefreshCw, Save, ShieldAlert, ShieldCheck, Trash2, Users,
} from 'lucide-react';

/**
 * P2 · 安全与合规 + 配额
 * 停止词、亲密级别、导出脱敏、删除作用域、多用户配额。
 */
export default function SafetyPage({ scope, api, qs, json, Header, Loading, ErrorBox, Empty }) {
  const [safety, setSafety] = useState(null);
  const [quota, setQuota] = useState(null);
  const [quotaLive, setQuotaLive] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [testText, setTestText] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [s, q, live] = await Promise.all([
        api('/api/product/safety'),
        api('/api/product/quota' + (scope.userId ? `?${qs(scope)}` : '')),
        scope.userId ? api(`/api/product/quota?${qs(scope)}`) : Promise.resolve(null),
      ]);
      setSafety(s.safety);
      setQuota(q.quota || s.quota);
      // live check uses full response
      setQuotaLive(live || q);
      if (!q.quota && live?.quota) setQuota(live.quota);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [scope.userId, scope.companionId]);

  const saveSafety = async () => {
    setSaving(true);
    setMsg('');
    try {
      const r = await api('/api/product/safety', json('PUT', { safety }));
      setSafety(r.safety);
      setMsg(r.message || '已保存');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const saveQuota = async () => {
    setSaving(true);
    setMsg('');
    try {
      const r = await api('/api/product/quota', json('PUT', { quota }));
      setQuota(r.quota);
      setMsg(r.message || '配额已保存');
      if (scope.userId) setQuotaLive(await api(`/api/product/quota?${qs(scope)}`));
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const runCheck = async () => {
    try {
      const r = await api('/api/product/safety/check', json('POST', { text: testText }));
      setTestResult(r);
    } catch (e) {
      setError(e.message);
    }
  };

  const doExport = async () => {
    if (!scope.userId) return setError('请先选择用户与角色');
    setMsg('正在导出…');
    try {
      const r = await api(`/api/export?${qs(scope)}`);
      const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `memory-export-${scope.userId}-${scope.companionId}-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      setMsg(r.redacted ? '已导出（含 PII 脱敏）' : '已导出');
    } catch (e) {
      setError(e.message);
    }
  };

  const doDelete = async () => {
    if (!scope.userId) return setError('请先选择用户与角色');
    if (deleteConfirm !== 'DELETE') return setError('请在确认框输入 DELETE');
    setSaving(true);
    try {
      const r = await api('/api/product/delete', json('POST', {
        userId: scope.userId,
        companionId: scope.companionId,
        confirm: 'DELETE',
      }));
      setMsg(r.message || '已删除');
      setDeleteConfirm('');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading || !safety || !quota) return <Loading />;
  if (error && !safety) return <ErrorBox error={error} />;

  const stopWordsText = (safety.stopWords || []).join('\n');
  const hardText = (safety.hardBlockPatterns || []).join('\n');
  const minorText = (safety.minorSignals || []).join('\n');

  return (
    <>
      <Header
        title="安全与合规"
        text="停止词、亲密级别、导出脱敏、作用域删除、多用户配额。策略保存在本机 config/product-policy.json。"
        action={<button type="button" className="btn" onClick={load}><RefreshCw size={15} />刷新</button>}
      />
      {msg && <div className="panel mb-4 border-emerald-200 bg-emerald-50 text-emerald-800 text-sm">{msg}</div>}
      {error && <div className="panel mb-4 border-rose-200 bg-rose-50 text-rose-800 text-sm">{error}</div>}

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="panel">
          <div className="mb-3 flex items-center gap-2 text-emerald-600">
            <ShieldCheck size={18} />
            <h3 className="font-bold text-zinc-900 dark:text-zinc-100">亲密与停止</h3>
          </div>
          <label className="block text-xs text-zinc-500 mb-1">亲密内容级别</label>
          <select
            className="input mb-3"
            value={safety.intimacyLevel}
            onChange={(e) => setSafety({ ...safety, intimacyLevel: e.target.value })}
          >
            <option value="open">open · 完整（仍受硬拦截）</option>
            <option value="soft">soft · 软限制高热描写</option>
            <option value="off">off · 关闭亲密推进</option>
          </select>
          <label className="flex items-center gap-2 text-sm mb-2">
            <input type="checkbox" checked={Boolean(safety.requireAdultAffirmation)} onChange={(e) => setSafety({ ...safety, requireAdultAffirmation: e.target.checked })} />
            要求成年声明后才允许高热亲密
          </label>
          <label className="flex items-center gap-2 text-sm mb-3">
            <input type="checkbox" checked={Boolean(safety.adultAffirmed)} onChange={(e) => setSafety({ ...safety, adultAffirmed: e.target.checked })} />
            已声明成年（产品层开关，非真身份核验）
          </label>
          <label className="block text-xs text-zinc-500 mb-1">停止词（每行一个）</label>
          <textarea className="input min-h-24 font-mono text-xs mb-3" value={stopWordsText} onChange={(e) => setSafety({ ...safety, stopWords: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })} />
          <label className="block text-xs text-zinc-500 mb-1">硬拦截片段</label>
          <textarea className="input min-h-20 font-mono text-xs mb-3" value={hardText} onChange={(e) => setSafety({ ...safety, hardBlockPatterns: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })} />
          <label className="block text-xs text-zinc-500 mb-1">疑似未成年信号</label>
          <textarea className="input min-h-20 font-mono text-xs mb-3" value={minorText} onChange={(e) => setSafety({ ...safety, minorSignals: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })} />
          <label className="flex items-center gap-2 text-sm mb-4">
            <input type="checkbox" checked={Boolean(safety.redactPII)} onChange={(e) => setSafety({ ...safety, redactPII: e.target.checked })} />
            导出时脱敏手机号 / 邮箱 / 证件号
          </label>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={saveSafety}>
            <Save size={15} />{saving ? '保存中…' : '保存安全策略'}
          </button>
        </section>

        <section className="panel">
          <div className="mb-3 flex items-center gap-2 text-amber-600">
            <ShieldAlert size={18} />
            <h3 className="font-bold text-zinc-900 dark:text-zinc-100">试检 · 数据权利</h3>
          </div>
          <label className="block text-xs text-zinc-500 mb-1">粘贴一条用户消息试检</label>
          <textarea className="input min-h-20 mb-2" value={testText} onChange={(e) => setTestText(e.target.value)} placeholder="例如：停止 / 我才14岁 / 普通聊天" />
          <button type="button" className="btn mb-3" onClick={runCheck}>试检</button>
          {testResult && (
            <div className={`mb-4 rounded-xl px-3 py-2 text-sm ${testResult.block ? 'bg-rose-50 text-rose-800' : 'bg-emerald-50 text-emerald-800'}`}>
              {testResult.block ? '拦截' : '放行'}
              {testResult.stopIntimate ? ' · 停止亲密' : ''}
              {testResult.intimacyAllowed === false ? ' · 亲密关闭' : ''}
              <div className="mt-1 text-xs opacity-80">{(testResult.reasons || []).join(' · ') || '无命中'}</div>
            </div>
          )}

          <div className="flex flex-wrap gap-2 mb-4">
            <button type="button" className="btn" onClick={doExport} disabled={!scope.userId}>
              <Download size={15} />导出本作用域
            </button>
          </div>

          <div className="rounded-xl border border-rose-200 bg-rose-50/50 p-3 dark:border-rose-900 dark:bg-rose-950/30">
            <div className="mb-2 flex items-center gap-2 text-rose-700 dark:text-rose-300 font-semibold text-sm">
              <Trash2 size={16} />危险：删除本作用域全部数据
            </div>
            <p className="text-xs text-zinc-600 dark:text-zinc-400 mb-2">
              将删除 {scope.userId || '（未选用户）'} · {scope.companionId || 'default'} 下记忆、状态、历史、故事线等。不可撤销。
            </p>
            <input
              className="input mb-2 font-mono text-xs"
              placeholder='输入 DELETE 确认'
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
            />
            <button type="button" className="btn border-rose-300 text-rose-700" disabled={saving || deleteConfirm !== 'DELETE'} onClick={doDelete}>
              确认删除
            </button>
          </div>
        </section>

        <section className="panel lg:col-span-2">
          <div className="mb-3 flex items-center gap-2 text-sky-600">
            <Users size={18} />
            <h3 className="font-bold text-zinc-900 dark:text-zinc-100">多用户配额</h3>
          </div>
          <p className="text-xs text-zinc-500 mb-3">
            按 userId 隔离计数。超限时试聊/Bot 写路径会被拒绝；只读页面仍可看（若开启 allowReadWhenExceeded）。
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-4">
            <NumField label="每日消息上限" value={quota.maxMessagesPerDay} onChange={(v) => setQuota({ ...quota, maxMessagesPerDay: v })} />
            <NumField label="每日出图上限" value={quota.maxPhotosPerDay} onChange={(v) => setQuota({ ...quota, maxPhotosPerDay: v })} />
            <NumField label="记忆条数上限" value={quota.maxMemoriesStored} onChange={(v) => setQuota({ ...quota, maxMemoriesStored: v })} />
            <NumField label="每用户角色数" value={quota.maxActiveCompanions} onChange={(v) => setQuota({ ...quota, maxActiveCompanions: v })} />
          </div>
          <label className="flex items-center gap-2 text-sm mb-4">
            <input type="checkbox" checked={quota.allowReadWhenExceeded !== false} onChange={(e) => setQuota({ ...quota, allowReadWhenExceeded: e.target.checked })} />
            超配额时仍允许只读
          </label>
          <button type="button" className="btn btn-primary mb-4" disabled={saving} onClick={saveQuota}>
            <Save size={15} />保存配额
          </button>
          {quotaLive && scope.userId && (
            <div className="rounded-xl bg-zinc-50 p-3 text-sm dark:bg-zinc-900/40">
              <div className="font-medium mb-1">当前作用域用量</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <span>今日消息 {quotaLive.usage?.messagesToday ?? 0}</span>
                <span>今日照片 {quotaLive.usage?.photosToday ?? 0}</span>
                <span>记忆 {quotaLive.usage?.memories ?? 0}</span>
                <span>角色数 {quotaLive.usage?.companions ?? 0}</span>
              </div>
              <div className="mt-2">
                状态：
                <span className={`badge ml-1 ${quotaLive.action === 'allow' ? 'badge-ok' : 'badge-warn'}`}>
                  {quotaLive.action}
                </span>
                {(quotaLive.reasons || []).length > 0 && (
                  <span className="ml-2 text-zinc-500">{quotaLive.reasons.join(', ')}</span>
                )}
              </div>
            </div>
          )}
          {!scope.userId && <Empty>选择用户后可看实时用量。</Empty>}
        </section>
      </div>
    </>
  );
}

function NumField({ label, value, onChange }) {
  return (
    <label className="block text-xs">
      <span className="text-zinc-500">{label}</span>
      <input
        type="number"
        className="input mt-1"
        value={value}
        min={0}
        onChange={(e) => onChange(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
      />
    </label>
  );
}
