import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Destination = {
  id: number;
  name: string;
  type: 'number' | 'group';
  phone: string | null;
  jid: string;
  enabled: 0 | 1;
};

type Template = {
  id: number;
  name: string;
  body: string;
  variables: string[];
};

type Job = {
  id: string;
  destination_name: string | null;
  destination_jid: string;
  message_text: string;
  status: string;
  error: string | null;
  created_at: string;
  sent_at: string | null;
};

type WaStatus = {
  connected: boolean;
  connecting: boolean;
  qr?: string;
  lastDisconnect?: string;
  user?: { id?: string; name?: string };
};

type ApiInfo = { apiToken: string; baseUrl: string };

type Section = 'conexao' | 'destinos' | 'templates' | 'envio' | 'historico' | 'api';

const tokenKey = 'notify_admin_token';

const sectionMeta: Record<Section, { label: string; title: string; desc: string }> = {
  conexao:   { label: 'Conexão',   title: 'Conexão WhatsApp',        desc: 'Gerencie a conta única conectada ao gateway.' },
  destinos:  { label: 'Destinos',  title: 'Destinos',                desc: 'Cadastre números e sincronize grupos da conta.' },
  templates: { label: 'Templates', title: 'Templates de mensagem',   desc: 'Crie modelos reutilizáveis com variáveis dinâmicas.' },
  envio:     { label: 'Envio',     title: 'Envio manual',            desc: 'Mesmo contrato da API externa, autenticado como admin.' },
  historico: { label: 'Histórico', title: 'Histórico de envios',     desc: 'Últimas mensagens enfileiradas e seus status.' },
  api:       { label: 'API',       title: 'Referência da API',       desc: 'Teste endpoints e copie exemplos prontos para integração.' },
};

function App() {
  const [token, setToken] = useState(() => localStorage.getItem(tokenKey) ?? '');
  if (!token) return <Login onLogin={(t) => { localStorage.setItem(tokenKey, t); setToken(t); }} />;
  return <Dashboard token={token} onLogout={() => { localStorage.removeItem(tokenKey); setToken(''); }} />;
}

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { setError(data.error ?? 'Falha no login'); return; }
    onLogin(data.token);
  }

  return (
    <main className="login-shell">
      <form className="login-panel" onSubmit={submit}>
        <div>
          <h1>Notify</h1>
          <p>Entre para gerenciar conexão, destinos, templates e envios.</p>
        </div>
        <label>Usuário<input value={username} onChange={(e) => setUsername(e.target.value)} /></label>
        <label>Senha<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus /></label>
        {error && <p className="error">{error}</p>}
        <button className="primary">Entrar</button>
      </form>
    </main>
  );
}

function Dashboard({ token, onLogout }: { token: string; onLogout: () => void }) {
  const api = useMemo(() => createApi(token, onLogout), [token, onLogout]);
  const [status, setStatus]             = useState<WaStatus>({ connected: false, connecting: false });
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [templates, setTemplates]       = useState<Template[]>([]);
  const [jobs, setJobs]                 = useState<Job[]>([]);
  const [notice, setNotice]             = useState('');
  const [section, setSection]           = useState<Section>('conexao');
  const [apiInfo, setApiInfo]           = useState<ApiInfo | null>(null);

  async function refresh() {
    const [s, d, t, j] = await Promise.all([
      api.get('/api/admin/status'),
      api.get('/api/admin/destinations'),
      api.get('/api/admin/templates'),
      api.get('/api/admin/jobs'),
    ]);
    setStatus(s); setDestinations(d); setTemplates(t); setJobs(j);
  }

  useEffect(() => {
    void refresh();
    void api.get('/api/admin/api-info').then(setApiInfo);
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${wsProtocol}//${location.host}/ws/status`);
    socket.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === 'whatsapp.status') setStatus(data.status);
    };
    const interval = window.setInterval(() => void api.get('/api/admin/jobs').then(setJobs), 5000);
    return () => { socket.close(); window.clearInterval(interval); };
  }, []);

  async function run(action: () => Promise<unknown>, message: string) {
    setNotice('');
    await action();
    await refresh();
    setNotice(message);
  }

  const meta = sectionMeta[section];

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-logo">N</span>
          <div>
            <h1>Notify</h1>
            <span className="brand-tag">WhatsApp Gateway</span>
          </div>
        </div>
        <nav>
          {(Object.keys(sectionMeta) as Section[]).map((key) => (
            <button
              key={key}
              className={`nav-item${section === key ? ' active' : ''}`}
              onClick={() => { setSection(key); setNotice(''); }}
            >
              {sectionMeta[key].label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="connection-status">
            <span className={status.connected ? 'dot ok' : 'dot'} />
            <span>{status.connected ? 'Conectado' : 'Desconectado'}</span>
          </div>
          <button className="ghost" onClick={onLogout}>Sair</button>
        </div>
      </aside>

      <div className="content">
        <header className="topbar">
          <div>
            <h2>{meta.title}</h2>
            <p>{meta.desc}</p>
          </div>
          <span className={status.connected ? 'badge ok' : 'badge'}>
            <span className="badge-dot" />
            {status.connected ? 'Conectado' : 'Desconectado'}
          </span>
        </header>

        {notice && <div className="notice">{notice}</div>}

        {section === 'conexao'   && <ConnectionCard status={status} api={api} run={run} />}
        {section === 'destinos'  && <DestinationCard destinations={destinations} api={api} run={run} />}
        {section === 'templates' && <TemplateCard templates={templates} api={api} run={run} />}
        {section === 'envio'     && <SendCard destinations={destinations} templates={templates} api={api} run={run} />}
        {section === 'historico' && <JobsCard jobs={jobs} />}
        {section === 'api'       && <ApiSection apiInfo={apiInfo} />}
      </div>
    </main>
  );
}

/* ── Connection ─────────────────────────────────── */

function ConnectionCard({ status, api, run }: {
  status: WaStatus; api: Api; run: Run;
}) {
  return (
    <section className="panel" id="conexao">
      <div className="section-title">
        <div>
          <h3>Conta conectada</h3>
          <p>{status.user?.name || status.user?.id || status.lastDisconnect || 'Nenhuma conta vinculada.'}</p>
        </div>
        <div className="actions">
          <button onClick={() => run(() => api.post('/api/admin/whatsapp/connect', {}), 'Conexão iniciada')}>Conectar</button>
          <button className="danger" onClick={() => run(() => api.post('/api/admin/whatsapp/logout', {}), 'Sessão removida')}>Desconectar</button>
        </div>
      </div>
      {status.qr && <img className="qr" src={status.qr} alt="QR Code" />}
    </section>
  );
}

/* ── Destinations ───────────────────────────────── */

function DestinationCard({ destinations, api, run }: {
  destinations: Destination[]; api: Api; run: Run;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  return (
    <section className="panel" id="destinos">
      <div className="section-title">
        <div>
          <h3>Números e grupos</h3>
          <p>Cadastre destinos manuais ou importe grupos da conta.</p>
        </div>
        <button onClick={() => run(() => api.post('/api/admin/groups/sync', {}), 'Grupos sincronizados')}>
          Sincronizar grupos
        </button>
      </div>
      <form className="inline-form" onSubmit={(e) => {
        e.preventDefault();
        void run(() => api.post('/api/admin/destinations', { name, type: 'number', phone }), 'Número cadastrado')
          .then(() => { setName(''); setPhone(''); });
      }}>
        <input placeholder="Nome interno" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="WhatsApp com DDI" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <button className="primary">Adicionar</button>
      </form>
      <DataTable
        columns={['Nome', 'Tipo', 'JID / Telefone', 'Status', '']}
        rows={destinations.map((d) => [
          d.name,
          d.type === 'group' ? 'Grupo' : 'Número',
          d.phone || d.jid,
          d.enabled ? 'Ativo' : 'Inativo',
        ])}
        actions={destinations.map((d) => (
          <button
            key={d.id}
            className="danger"
            style={{ padding: '4px 10px', fontSize: '12px' }}
            onClick={() => run(() => api.delete(`/api/admin/destinations/${d.id}`), 'Destino removido')}
          >
            Excluir
          </button>
        ))}
      />
    </section>
  );
}

/* ── Templates ──────────────────────────────────── */

function TemplateCard({ templates, api, run }: {
  templates: Template[]; api: Api; run: Run;
}) {
  const [name, setName]         = useState('');
  const [body, setBody]         = useState('Olá {{nome}}, sua notificação chegou.');
  const [editingId, setEditingId] = useState<number | null>(null);

  function startEdit(t: Template) {
    setEditingId(t.id);
    setName(t.name);
    setBody(t.body);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function cancelEdit() {
    setEditingId(null);
    setName('');
    setBody('Olá {{nome}}, sua notificação chegou.');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (editingId !== null) {
      await run(() => api.put(`/api/admin/templates/${editingId}`, { name, body }), 'Template atualizado');
      setEditingId(null);
    } else {
      await run(() => api.post('/api/admin/templates', { name, body }), 'Template salvo');
    }
    setName('');
    setBody('Olá {{nome}}, sua notificação chegou.');
  }

  return (
    <section className="panel" id="templates">
      <div className="section-title">
        <div>
          <h3>{editingId !== null ? 'Editar template' : 'Modelos salvos'}</h3>
          <p>Use variáveis no padrão {'{{variavel}}'}.</p>
        </div>
        {editingId !== null && (
          <button onClick={cancelEdit}>Cancelar edição</button>
        )}
      </div>
      <form className="template-form" onSubmit={handleSubmit}>
        <input placeholder="Nome do template" value={name} onChange={(e) => setName(e.target.value)} required />
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} required />
        <button className="primary">{editingId !== null ? 'Atualizar template' : 'Salvar template'}</button>
      </form>
      {templates.length > 0 && (
        <div className="template-list">
          {templates.map((t) => (
            <article key={t.id} className={editingId === t.id ? 'editing' : ''}>
              <div className="template-card-header">
                <strong>{t.name}</strong>
                <div className="template-card-actions">
                  <button style={{ padding: '4px 10px', fontSize: '12px' }} onClick={() => startEdit(t)}>
                    Editar
                  </button>
                  <button
                    className="danger"
                    style={{ padding: '4px 10px', fontSize: '12px' }}
                    onClick={() => run(() => api.delete(`/api/admin/templates/${t.id}`), 'Template excluído')}
                  >
                    Excluir
                  </button>
                </div>
              </div>
              <p>{t.body}</p>
              <small>{t.variables.length ? `Variáveis: ${t.variables.join(', ')}` : 'Sem variáveis'}</small>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

/* ── Send ───────────────────────────────────────── */

function SendCard({ destinations, templates, api, run }: {
  destinations: Destination[]; templates: Template[]; api: Api; run: Run;
}) {
  const [destinationId, setDestinationId] = useState('');
  const [templateId, setTemplateId]       = useState('');
  const [variables, setVariables]         = useState('{"nome":"Aylon"}');
  const [message, setMessage]             = useState('');
  const [mediaType, setMediaType]         = useState('');
  const [mediaUrl, setMediaUrl]           = useState('');
  const [uploadMode, setUploadMode]       = useState(false);
  const [uploading, setUploading]         = useState(false);

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setMediaUrl('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await api.upload('/api/admin/upload', formData);
      setMediaUrl(res.url);
      setMediaType(res.type);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  return (
    <section className="panel" id="envio">
      <div className="section-title">
        <div>
          <h3>Enviar mensagem</h3>
          <p>Escolha um destino, um template ou escreva manualmente.</p>
        </div>
      </div>
      <form className="send-grid" onSubmit={(e) => {
        e.preventDefault();
        const payload: Record<string, unknown> = {
          destinationId: Number(destinationId),
          variables: variables.trim() ? JSON.parse(variables) : undefined,
          message: message.trim() || undefined,
          templateId: templateId ? Number(templateId) : undefined,
          media: mediaUrl && mediaType ? { type: mediaType, url: mediaUrl } : undefined,
        };
        void run(() => api.post('/api/admin/send', payload), 'Mensagem enfileirada');
      }}>
        <select value={destinationId} onChange={(e) => setDestinationId(e.target.value)} required>
          <option value="">Destino</option>
          {destinations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          <option value="">Mensagem manual</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <textarea placeholder="Mensagem manual" value={message} onChange={(e) => setMessage(e.target.value)} rows={4} />
        <textarea placeholder='Variáveis JSON: {"nome":"Aylon"}' value={variables} onChange={(e) => setVariables(e.target.value)} rows={3} />

        {/* Mídia */}
        <div className="media-row">
          <select value={mediaType} onChange={(e) => setMediaType(e.target.value)}>
            <option value="">Sem mídia</option>
            <option value="image">Imagem</option>
            <option value="video">Vídeo</option>
            <option value="document">Documento</option>
            <option value="audio">Áudio</option>
          </select>
          <div className="media-source-toggle">
            <button type="button" className={!uploadMode ? 'active' : ''} onClick={() => setUploadMode(false)}>URL</button>
            <button type="button" className={uploadMode ? 'active' : ''} onClick={() => setUploadMode(true)}>Upload</button>
          </div>
        </div>

        {!uploadMode ? (
          <input placeholder="URL da mídia" value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} />
        ) : (
          <div className="upload-area">
            <label className="upload-label">
              <input type="file" accept="image/*,video/*,audio/*,.pdf,.doc,.docx" onChange={handleFileUpload} />
              {uploading ? 'Enviando...' : 'Escolher arquivo'}
            </label>
            {mediaUrl && (
              <span className="upload-done">
                ✓ Arquivo enviado —{' '}
                <a href={mediaUrl} target="_blank" rel="noreferrer">ver URL</a>
                <button type="button" className="ghost" style={{ padding: '2px 6px', fontSize: '11px' }} onClick={() => setMediaUrl('')}>×</button>
              </span>
            )}
          </div>
        )}

        <button className="primary">Enviar mensagem</button>
      </form>
    </section>
  );
}

/* ── Jobs ───────────────────────────────────────── */

function JobsCard({ jobs }: { jobs: Job[] }) {
  return (
    <section className="panel" id="historico">
      <div className="section-title">
        <div>
          <h3>Fila de envios</h3>
          <p>Atualizado automaticamente a cada 5 segundos.</p>
        </div>
      </div>
      <DataTable
        columns={['Data', 'Destino', 'Mensagem', 'Status', 'Erro']}
        rows={jobs.map((j) => [
          j.created_at,
          j.destination_name || j.destination_jid,
          j.message_text,
          j.status,
          j.error || '—',
        ])}
      />
    </section>
  );
}

/* ── API Section ────────────────────────────────── */

function ApiSection({ apiInfo }: { apiInfo: ApiInfo | null }) {
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied]       = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'curl' | 'js' | 'python'>('curl');
  const [testBody, setTestBody]   = useState('{\n  "destinationId": 1,\n  "message": "Olá! Teste da API Notify."\n}');
  const [testRes, setTestRes]     = useState<{ status: number; body: string } | null>(null);
  const [testing, setTesting]     = useState(false);

  const token   = apiInfo?.apiToken ?? '••••';
  const baseUrl = apiInfo?.baseUrl ?? location.origin;
  const masked  = '••••••••••••••••••••';

  function copy(text: string, key: string) {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  const displayToken = showToken ? token : masked;

  const curlCode = `curl -X POST ${baseUrl}/api/send \\
  -H "X-Notify-Token: ${displayToken}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "destinationId": 1,
    "message": "Olá! Mensagem via Notify."
  }'`;

  const jsCode = `const res = await fetch('${baseUrl}/api/send', {
  method: 'POST',
  headers: {
    'X-Notify-Token': '${displayToken}',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    destinationId: 1,
    message: 'Olá! Mensagem via Notify.',
  }),
});
const data = await res.json();
console.log(data); // { jobId, status, queuedAt }`;

  const pythonCode = `import requests

res = requests.post(
    '${baseUrl}/api/send',
    headers={
        'X-Notify-Token': '${displayToken}',
        'Content-Type': 'application/json',
    },
    json={
        'destinationId': 1,
        'message': 'Olá! Mensagem via Notify.',
    },
)
print(res.json())  # {'jobId': ..., 'status': 'queued', ...}`;

  const activeCode = { curl: curlCode, js: jsCode, python: pythonCode }[activeTab];

  async function runTest() {
    setTesting(true);
    setTestRes(null);
    try {
      const res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'X-Notify-Token': token, 'Content-Type': 'application/json' },
        body: testBody,
      });
      const data = await res.json();
      setTestRes({ status: res.status, body: JSON.stringify(data, null, 2) });
    } catch (err) {
      setTestRes({ status: 0, body: String(err) });
    }
    setTesting(false);
  }

  const schemaFields = [
    { field: 'destinationId', type: 'number',     req: 'condicional', desc: 'ID de um destino cadastrado no painel' },
    { field: 'jid',           type: 'string',     req: 'condicional', desc: 'JID direto (ex: 5511999888777@s.whatsapp.net)' },
    { field: 'phone',         type: 'string',     req: 'condicional', desc: 'Número com DDI sem formatação (ex: 5511999888777)' },
    { field: 'message',       type: 'string',     req: 'condicional', desc: 'Texto livre da mensagem' },
    { field: 'templateId',    type: 'number',     req: 'condicional', desc: 'ID de um template salvo no painel' },
    { field: 'variables',     type: 'object',     req: 'opcional',    desc: 'Variáveis do template: {"nome":"João"}' },
    { field: 'media.type',    type: 'string',     req: 'opcional',    desc: '"image" | "video" | "document" | "audio"' },
    { field: 'media.url',     type: 'URL',        req: 'opcional',    desc: 'URL pública acessível pelo servidor' },
    { field: 'media.fileName',type: 'string',     req: 'opcional',    desc: 'Nome do arquivo (recomendado para documentos)' },
    { field: 'buttons',       type: 'array',      req: 'opcional',    desc: '[{text:"Sim"}, {text:"Não"}] — máximo 5' },
  ];

  return (
    <div className="api-page">
      {/* Token */}
      <section className="panel">
        <div className="section-title">
          <div><h3>Token de API</h3><p>Autentique requisições externas com este token.</p></div>
        </div>
        <div className="token-row">
          <code className="token-display">{displayToken}</code>
          <button onClick={() => setShowToken(!showToken)}>{showToken ? 'Ocultar' : 'Revelar'}</button>
          <button onClick={() => copy(token, 'token')}>{copied === 'token' ? 'Copiado!' : 'Copiar'}</button>
        </div>
        <p className="api-hint">
          Envie como header <code>X-Notify-Token: …</code> ou <code>Authorization: Bearer …</code>
        </p>
      </section>

      {/* Endpoint */}
      <section className="panel">
        <div className="section-title">
          <div>
            <h3><span className="method-badge post">POST</span>/api/send</h3>
            <p>Endpoint público para integração. Enfileira a mensagem e retorna o jobId.</p>
          </div>
        </div>

        {/* Code tabs */}
        <div className="code-tabs">
          {(['curl', 'js', 'python'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              className={activeTab === tab ? 'active' : ''}
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'curl' ? 'cURL' : tab === 'js' ? 'JavaScript' : 'Python'}
            </button>
          ))}
          <button
            type="button"
            className="copy-btn"
            onClick={() => copy(activeCode, 'code')}
          >
            {copied === 'code' ? 'Copiado!' : 'Copiar'}
          </button>
        </div>
        <div className="code-block">
          <pre className="code-pre">{activeCode}</pre>
        </div>

        {/* Tester */}
        <div className="api-tester">
          <p className="tester-label">Testar endpoint</p>
          <textarea
            className="code-textarea"
            value={testBody}
            onChange={(e) => setTestBody(e.target.value)}
            rows={5}
            spellCheck={false}
          />
          <button className="primary" onClick={runTest} disabled={testing} style={{ justifySelf: 'start' }}>
            {testing ? 'Enviando…' : 'Executar'}
          </button>
          {testRes && (
            <div className={`api-response ${testRes.status >= 200 && testRes.status < 300 ? 'ok' : 'err'}`}>
              <span className="response-status">{testRes.status > 0 ? `${testRes.status}` : 'Erro de rede'}</span>
              <pre>{testRes.body}</pre>
            </div>
          )}
        </div>
      </section>

      {/* Schema */}
      <section className="panel">
        <div className="section-title">
          <div><h3>Schema do body</h3><p>Campos aceitos no POST /api/send.</p></div>
        </div>
        <div className="schema-table">
          <div className="schema-header">
            <span>Campo</span><span>Tipo</span><span>Descrição</span><span>Req.</span>
          </div>
          {schemaFields.map((f) => (
            <div key={f.field} className="schema-row">
              <code>{f.field}</code>
              <span className="schema-type">{f.type}</span>
              <span className="schema-desc">{f.desc}</span>
              <span className={`schema-req ${f.req === 'opcional' ? 'optional' : 'conditional'}`}>{f.req}</span>
            </div>
          ))}
        </div>
        <p className="api-hint">
          Condicional: precisa de ao menos um campo de destino (destinationId, jid ou phone) e ao menos um de conteúdo (message ou templateId).
        </p>
      </section>
    </div>
  );
}

/* ── DataTable ──────────────────────────────────── */

function DataTable({ columns, rows, actions }: {
  columns: string[];
  rows: string[][];
  actions?: React.ReactNode[];
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={columns.length} style={{ color: 'var(--muted)', textAlign: 'center' }}>Nenhum registro.</td></tr>
          )}
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, ci) => <td key={ci}>{cell}</td>)}
              {actions && <td>{actions[i]}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── API client ─────────────────────────────────── */

type Run = (action: () => Promise<unknown>, message: string) => Promise<void>;
type Api = ReturnType<typeof createApi>;

function createApi(token: string, onUnauthorized: () => void) {
  async function request(method: string, url: string, body?: unknown) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) onUnauthorized();
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Erro na requisição');
    return data;
  }

  async function upload(url: string, formData: FormData) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    if (res.status === 401) onUnauthorized();
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Erro no upload');
    return data;
  }

  return {
    get:    (url: string)                     => request('GET', url),
    post:   (url: string, body: unknown)      => request('POST', url, body),
    put:    (url: string, body: unknown)      => request('PUT', url, body),
    delete: (url: string)                     => request('DELETE', url),
    upload: (url: string, fd: FormData)       => upload(url, fd),
  };
}

createRoot(document.getElementById('root')!).render(<App />);
