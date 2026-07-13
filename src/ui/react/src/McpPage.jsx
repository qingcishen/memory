import React, { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, Link2, Plug, RefreshCw, Unplug } from 'lucide-react';

const CLIENTS = [
  { id: 'grok', label: 'Grok' },
  { id: 'claude', label: 'Claude' },
  { id: 'cursor', label: 'Cursor' },
];

export default function McpPage({ api, json, Header, Loading, ErrorBox, Empty }) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState('');
  const [client, setClient] = useState('grok');
  const [snippetId, setSnippetId] = useState(null);
  const [snippet, setSnippet] = useState('');

  const load = async () => {
    setState((s) => ({ ...s, loading: true, error: '' }));
    try {
      const data = await api('/api/mcp');
      setState({ loading: false, data, error: '' });
    } catch (e) {
      setState({ loading: false, data: null, error: e.message });
    }
  };

  useEffect(() => { load(); }, []);

  const flash = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2600);
  };

  const install = async (id) => {
    if (!confirm(`将 ${id} 写入 ${client} 的 MCP 配置？\n\nHTTP 类服务首次使用时会打开浏览器做 OAuth 授权。`)) return;
    setBusy(`${id}:install`);
    try {
      const r = await api('/api/mcp/install', json('POST', { id, client, confirm: true }));
      if (!r.ok) throw new Error(r.message || '安装失败');
      flash(r.message || '已安装');
      await load();
    } catch (e) {
      flash(e.message);
    } finally {
      setBusy('');
    }
  };

  const uninstall = async (id) => {
    if (!confirm(`从 ${client} 配置中移除 ${id}？`)) return;
    setBusy(`${id}:uninstall`);
    try {
      const r = await api('/api/mcp/uninstall', json('POST', { id, client, confirm: true }));
      if (!r.ok) throw new Error(r.message || '移除失败');
      flash(r.message || '已移除');
      await load();
    } catch (e) {
      flash(e.message);
    } finally {
      setBusy('');
    }
  };

  const copySnippet = async (item) => {
    const text = item.snippets?.[client] || '';
    try {
      await navigator.clipboard.writeText(text);
      setSnippetId(item.id);
      setSnippet(text);
      flash(`已复制 ${item.name} 的 ${client} 配置`);
      setTimeout(() => setSnippetId(null), 1500);
    } catch {
      setSnippet(text);
      flash('复制失败，请手动选中下方配置');
    }
  };

  if (state.loading && !state.data) return <Loading />;
  if (state.error) return <ErrorBox error={state.error} />;

  const items = state.data?.items || [];
  const paths = state.data?.paths || {};

  return (
    <div className="mcp-page">
      <Header
        title="MCP 快捷连接"
        text="一键把 Cloudflare、Supabase 等官方 MCP 接到 Grok / Claude / Cursor。HTTP 服务走 OAuth，不把密钥写进仓库。"
        action={<button className="btn" onClick={load}><RefreshCw size={15}/>刷新</button>}
      />

      <section className="panel mcp-hero">
        <div>
          <span className="page-header-kicker">MODEL CONTEXT PROTOCOL</span>
          <h3>让 AI 直接管 R2、数据库、仓库</h3>
          <p>
            本页写入的是<strong>客户端 MCP 配置</strong>（给 Grok/Claude/Cursor 用）。
            本应用运行时凭证仍在「设置与模型」里的 .env（Supabase URL/Key、R2 桶等）。
          </p>
        </div>
        <div className="mcp-client-switch">
          <span>写入目标</span>
          <div className="mcp-client-tabs">
            {CLIENTS.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`outfit-tab ${client === c.id ? 'is-active' : ''}`}
                onClick={() => setClient(c.id)}
              >
                <strong>{c.label}</strong>
              </button>
            ))}
          </div>
          <small className="mcp-path-hint">{paths[client] || '—'}</small>
        </div>
      </section>

      <div className="mcp-grid">
        {items.map((item) => {
          const inst = item.installed?.[client];
          const installed = Boolean(inst?.installed);
          const busyKey = busy.startsWith(`${item.id}:`);
          return (
            <article className="panel mcp-card" key={item.id} style={{ '--mcp-accent': item.color || 'var(--sw-accent)' }}>
              <div className="mcp-card-top">
                <div className="mcp-brand" style={{ background: item.color || 'var(--sw-text)' }}>{item.brand || item.name.slice(0, 2)}</div>
                <div className="mcp-card-title">
                  <h3>{item.name}</h3>
                  <p>{item.description}</p>
                  <div className="mcp-tags">
                    <span className="badge">{item.transport}</span>
                    <span className="badge">{item.auth}</span>
                    {(item.tags || []).map((t) => <span className="badge" key={t}>{t}</span>)}
                  </div>
                </div>
                <span className={`badge ${installed ? 'badge-ok' : 'badge-warn'}`}>
                  {installed ? `${client} 已接入` : `${client} 未接入`}
                </span>
              </div>

              {item.url && (
                <div className="mcp-url-row">
                  <Link2 size={14} />
                  <code>{item.url}</code>
                </div>
              )}

              {(item.relatedEnv || []).length > 0 && (
                <div className="mcp-env-row">
                  <span>本应用相关 .env</span>
                  <div className="mcp-env-chips">
                    {item.relatedEnv.map((k) => (
                      <span key={k} className={`mcp-env-chip ${item.envStatus?.[k] ? 'is-on' : ''}`}>{k}{item.envStatus?.[k] ? ' ✓' : ''}</span>
                    ))}
                  </div>
                </div>
              )}

              {item.projectRoot && (
                <div className="mcp-url-row">
                  <span className="text-xs">放行目录</span>
                  <code>{item.projectRoot}</code>
                </div>
              )}
              {item.readyHint && (
                <p className={`mcp-ready-hint ${item.ready === false ? 'is-warn' : ''}`}>{item.readyHint}</p>
              )}

              <div className="mcp-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busyKey || installed || item.ready === false}
                  onClick={() => install(item.id)}
                  title={item.ready === false ? (item.readyHint || '未就绪') : ''}
                >
                  <Plug size={14} />
                  {installed ? '已连接' : item.ready === false ? '先配置凭证' : `接入 ${client}`}
                </button>
                {installed && (
                  <button type="button" className="btn" disabled={busyKey} onClick={() => uninstall(item.id)}>
                    <Unplug size={14} />
                    断开
                  </button>
                )}
                <button type="button" className="btn" onClick={() => copySnippet(item)}>
                  {snippetId === item.id ? <Check size={14} /> : <Copy size={14} />}
                  复制配置
                </button>
                {item.docs && (
                  <a className="btn" href={item.docs} target="_blank" rel="noreferrer">
                    <ExternalLink size={14} />
                    文档
                  </a>
                )}
                {item.dashboard && (
                  <a className="btn" href={item.dashboard} target="_blank" rel="noreferrer">
                    <ExternalLink size={14} />
                    控制台
                  </a>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {!items.length && <Empty>暂无 MCP 目录</Empty>}

      {snippet && (
        <section className="panel mcp-snippet">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-bold">配置预览 · {client}</h3>
            <button type="button" className="btn" onClick={() => navigator.clipboard.writeText(snippet)}><Copy size={14}/>再复制</button>
          </div>
          <pre className="mcp-pre">{snippet}</pre>
        </section>
      )}

      <section className="panel mcp-howto">
        <h3 className="font-bold">怎么用</h3>
        <ol>
          <li>选好写入目标（Grok / Claude / Cursor）</li>
          <li>点 <b>接入</b>：写入本机 MCP 配置文件</li>
          <li>HTTP 类（Cloudflare / Supabase）首次在客户端里会弹出 OAuth 登录授权</li>
          <li>stdio 类（GitHub）需要 Token：在「设置与模型」或对应平台生成后写入配置</li>
          <li>本应用的 R2 上传 / Supabase 读写仍用 .env 凭证；MCP 是给 AI 助手运维用的快捷通道</li>
        </ol>
      </section>

      {toast && <div className="outfit-toast" role="status">{toast}</div>}
    </div>
  );
}
