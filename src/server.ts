import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import mime from 'mime-types';
import { v4 as uuidv4 } from 'uuid';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getBearerToken, createAdminToken, verifyAdminCredentials, verifyAdminToken, verifyApiToken } from './auth.js';
import { config } from './config.js';
import { db, type Destination, type Template } from './db.js';
import { enqueueMessage, listJobs, startSendWorker } from './queue.js';
import { extractVariables } from './template.js';
import { whatsapp } from './whatsapp.js';
import {
  getProtectedResourceMetadata,
  getAuthorizationServerMetadata,
  getJwks,
  getIssuer,
  getResource,
  registerClient,
  getClient,
  validateCIMD,
  createAuthCode,
  consumeAuthCode,
  createAccessToken,
  storeToken,
  verifyAccessToken,
} from './oauth.js';
import { handleMcpRequest } from './mcp.js';

const app = Fastify({ logger: true });
// Permitir DELETE sem body (frontend envia Content-Type: application/json vazio)
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  if (!body || (typeof body === 'string' && body.trim() === '')) {
    done(null, undefined);
    return;
  }
  try {
    done(null, JSON.parse(body as string));
  } catch (err) {
    done(err as Error, undefined);
  }
});
// Parser para x-www-form-urlencoded (OAuth token endpoint)
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
  try {
    const params = new URLSearchParams(body as string);
    const obj: Record<string, string> = {};
    for (const [k, v] of params.entries()) obj[k] = v;
    done(null, obj);
  } catch (err) {
    done(err as Error, undefined);
  }
});
const worker = startSendWorker();

const destinationInput = z.object({
  name: z.string().min(1),
  type: z.enum(['number', 'group']),
  phone: z.string().optional(),
  jid: z.string().optional(),
  enabled: z.boolean().optional()
});

const templateInput = z.object({
  name: z.string().min(1),
  body: z.string().min(1)
});

const sendInput = z.object({
  destinationId: z.coerce.number().int().positive().optional(),
  jid: z.string().min(3).optional(),
  phone: z.string().min(8).optional(),
  templateId: z.coerce.number().int().positive().optional(),
  message: z.string().min(1).optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
  media: z.object({
    type: z.enum(['image', 'video', 'document', 'audio']),
    url: z.string().url(),
    fileName: z.string().optional(),
    mimetype: z.string().optional()
  }).optional(),
  buttons: z.array(z.object({
    id: z.string().optional(),
    text: z.string().min(1)
  })).max(5).optional(),
  mentionAll: z.boolean().optional(),
  mentions: z.array(z.string()).optional(), // retrocompat – alias para mentionAll
}).refine((body) => body.destinationId || body.jid || body.phone, 'Informe destinationId, jid ou phone')
  .refine((body) => body.templateId || body.message, 'Informe templateId ou message')
  .transform((body) => ({
    ...body,
    mentionAll: body.mentionAll ?? (body.mentions && body.mentions.length > 0 ? true : undefined),
  }));

function requireAdmin(request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) {
  const auth = verifyAdminToken(getBearerToken(request));
  if (!auth) {
    void reply.code(401).send({ error: 'Nao autenticado' });
    return;
  }
  done();
}

function requireApi(request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) {
  if (!verifyApiToken(request)) {
    void reply.code(401).send({ error: 'Token invalido' });
    return;
  }
  done();
}

function isWhatsAppError(error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  return /não está conectado|desconectou|connection closed|connection lost/i.test(msg);
}

function waError(reply: FastifyReply, error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  return reply.code(503).send({ error: msg });
}

function parseId(request: FastifyRequest) {
  const id = Number((request.params as { id: string }).id);
  if (!Number.isInteger(id) || id < 1) throw new Error('ID invalido');
  return id;
}

function normalizeDestination(input: z.infer<typeof destinationInput>) {
  if (input.type === 'number') {
    const phone = (input.phone ?? input.jid ?? '').replace(/\D/g, '');
    if (!phone) throw new Error('Telefone obrigatorio');
    return { ...input, phone, jid: `${phone}@s.whatsapp.net` };
  }

  const jid = input.jid?.trim();
  if (!jid?.endsWith('@g.us')) throw new Error('JID de grupo invalido');
  return { ...input, phone: null, jid };
}

function publicTemplate(template: Template) {
  return { ...template, variables: JSON.parse(template.variables_json) as string[] };
}

await app.register(cors, { origin: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Authorization', 'Content-Type', 'X-Notify-Token', 'Mcp-Session-Id', 'Last-Event-ID'] });
await app.register(websocket);
await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

// ============ OAuth + MCP (ChatGPT) ============
// Helpers
function getMcpBaseUrl(request: FastifyRequest) {
  const forwardedHost = request.headers['x-forwarded-host'] as string | undefined;
  const forwardedProto = request.headers['x-forwarded-proto'] as string | undefined;
  const proto = forwardedProto || request.protocol || 'https';
  const host = forwardedHost || request.hostname;
  // Em produção sempre https sem porta
  if (host.includes('notify.abaincendio.com.br')) return 'https://notify.abaincendio.com.br';
  const needsPort = !forwardedHost && ![80, 443].includes(config.port);
  return `${proto}://${host}${needsPort ? `:${config.port}` : ''}`;
}

// /.well-known/oauth-protected-resource
app.get('/.well-known/oauth-protected-resource', async (request, reply) => {
  const meta = getProtectedResourceMetadata();
  // Permite override via host detection mas mantém resource canônico
  void reply.header('Access-Control-Allow-Origin', '*');
  return meta;
});
app.get('/.well-known/oauth-protected-resource/mcp', async (request, reply) => {
  const meta = getProtectedResourceMetadata();
  void reply.header('Access-Control-Allow-Origin', '*');
  return meta;
});
app.get('/.well-known/oauth-authorization-server', async (request, reply) => {
  void reply.header('Access-Control-Allow-Origin', '*');
  return getAuthorizationServerMetadata();
});
app.get('/.well-known/openid-configuration', async (request, reply) => {
  void reply.header('Access-Control-Allow-Origin', '*');
  return getAuthorizationServerMetadata();
});
app.get('/.well-known/jwks.json', async (request, reply) => {
  void reply.header('Access-Control-Allow-Origin', '*');
  return getJwks();
});
app.get('/oauth/jwks.json', async (request, reply) => {
  return getJwks();
});

// DCR
app.post('/oauth/register', async (request, reply) => {
  try {
    const body = (request.body ?? {}) as any;
    // ChatGPT pode não enviar scope (TREK #959) -> torna opcional
    const client = registerClient(body);
    void reply.code(201);
    return {
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: client.grant_types,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      scope: 'notify:read notify:send notify:admin',
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(400).send({ error: 'invalid_client_metadata', error_description: msg });
  }
});

// Authorization endpoint - GET mostra login, POST processa
function renderAuthorizePage(params: Record<string, string>, error?: string) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('\n');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notify - Autorizar</title><style>body{font-family:system-ui,Arial;max-width:480px;margin:40px auto;padding:20px}input,button{width:100%;padding:12px;margin:8px 0;box-sizing:border-box}button{background:#111;color:#fff;border:0;cursor:pointer} .card{border:1px solid #ddd;padding:24px;border-radius:12px} .error{color:#b00;background:#fee;padding:8px;border-radius:8px}</style></head><body><div class="card"><h2>Conectar ChatGPT ao Notify</h2><p>O ChatGPT quer acessar seu WhatsApp Notify. Faça login para autorizar.</p>${error ? `<div class="error">${esc(error)}</div>` : ''}<form method="POST" action="/oauth/authorize">${hidden}<label>Usuário <input name="username" placeholder="admin" required></label><label>Senha <input name="password" type="password" required></label><label>Scopes <input name="scope_display" value="${esc(params.scope ?? 'notify:read notify:send')}" disabled></label><button type="submit">Autorizar</button></form><p style="font-size:12px;color:#666">Resource: ${esc(params.resource ?? '')}<br>Client: ${esc(params.client_id ?? '')}</p></div></body></html>`;
}

app.get('/oauth/authorize', async (request, reply) => {
  const q = request.query as Record<string, string>;
  const { client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, resource, response_type } = q;
  if (!client_id || !redirect_uri) return reply.code(400).send({ error: 'invalid_request', error_description: 'client_id e redirect_uri obrigatórios' });
  if (response_type && response_type !== 'code') return reply.code(400).send({ error: 'unsupported_response_type' });
  if (code_challenge_method && code_challenge_method !== 'S256') return reply.code(400).send({ error: 'invalid_request', error_description: 'code_challenge_method deve ser S256' });
  // Valida client
  const client = getClient(String(client_id));
  if (!client) return reply.code(400).send({ error: 'invalid_client' });
  // Para CIMD, valida redirect_uri via fetch
  if (String(client_id).startsWith('https://')) {
    const ok = await validateCIMD(String(client_id), String(redirect_uri));
    if (!ok) return reply.code(400).send({ error: 'invalid_client', error_description: 'redirect_uri não permitido para este client_id' });
  } else {
    if (!client.redirect_uris.includes(String(redirect_uri))) return reply.code(400).send({ error: 'invalid_client', error_description: 'redirect_uri não registrado' });
  }
  void reply.type('text/html').send(renderAuthorizePage(q));
});

app.post('/oauth/authorize', async (request, reply) => {
  const body = request.body as Record<string, string>;
  const q = body as Record<string, string>;
  const { client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, resource, username, password } = q;
  if (!client_id || !redirect_uri || !username || !password) {
    void reply.type('text/html').code(400).send(renderAuthorizePage(q, 'Parâmetros faltando'));
    return;
  }
  if (!verifyAdminCredentials(String(username), String(password))) {
    void reply.type('text/html').code(401).send(renderAuthorizePage(q, 'Usuário ou senha inválidos'));
    return;
  }
  const client = getClient(String(client_id));
  if (!client) return reply.code(400).send({ error: 'invalid_client' });
  // Cria code
  const code = createAuthCode({
    client_id: String(client_id),
    redirect_uri: String(redirect_uri),
    code_challenge: code_challenge ? String(code_challenge) : undefined,
    code_challenge_method: code_challenge_method ? String(code_challenge_method) : undefined,
    scope: scope ? String(scope) : 'notify:read notify:send',
    resource: resource ? String(resource) : getResource(),
    user: String(username),
  });
  const iss = getIssuer();
  const url = new URL(String(redirect_uri));
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  url.searchParams.set('iss', iss);
  void reply.redirect(url.toString());
});

// Token endpoint
app.post('/oauth/token', async (request, reply) => {
  const body = (request.body ?? {}) as Record<string, string>;
  const { grant_type, code, redirect_uri, client_id, code_verifier, resource, refresh_token, scope } = body;
  // CORS para ChatGPT
  void reply.header('Access-Control-Allow-Origin', '*');
  try {
    if (grant_type === 'authorization_code') {
      if (!code || !client_id || !redirect_uri) throw new Error('invalid_request');
      const row = consumeAuthCode(String(code), String(client_id), String(redirect_uri), code_verifier ? String(code_verifier) : undefined);
      const aud = (resource as string) ?? (row.resource as string) ?? getResource();
      const finalScope = (scope as string) ?? (row.scope as string) ?? 'notify:read notify:send';
      const token = createAccessToken({ sub: row.user, aud, scope: finalScope, client_id: String(client_id) });
      storeToken(token, String(client_id), finalScope, aud, row.user);
      return {
        access_token: token,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: finalScope,
      };
    } else if (grant_type === 'refresh_token') {
      // Simplificado: aceita refresh_token como re-emissão (não implementado storage real de refresh)
      if (!refresh_token || !client_id) throw new Error('invalid_request');
      // Para MVP, apenas revalida token antigo se existir
      return reply.code(400).send({ error: 'unsupported_grant_type', error_description: 'refresh_token não suportado nesta versão' });
    } else {
      throw new Error('unsupported_grant_type');
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isInvalidGrant = msg.includes('invalid_grant') || msg.includes('PKCE');
    if (isInvalidGrant) return reply.code(400).send({ error: 'invalid_grant', error_description: msg });
    return reply.code(400).send({ error: 'invalid_request', error_description: msg });
  }
});

app.post('/oauth/revoke', async (request, reply) => {
  // No-op para compatibilidade
  return { ok: true };
});

// MCP - Streamable HTTP em /mcp
function extractMcpToken(request: FastifyRequest): { token?: string; payload?: any } {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return {};
  const token = auth.slice(7).trim();
  const payload = verifyAccessToken(token);
  if (!payload) return { token: undefined };
  return { token, payload };
}

app.addHook('onRequest', async (request, reply) => {
  if (request.url.startsWith('/mcp') || request.url.startsWith('/.well-known/oauth')) {
    // Garante CORS para MCP
    void reply.header('Access-Control-Allow-Origin', '*');
    void reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id');
    void reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (request.method === 'OPTIONS') {
      void reply.code(204).send();
      return;
    }
  }
});

app.post('/mcp', async (request, reply) => {
  const { token, payload } = extractMcpToken(request);
  // Verifica se é batch ou single
  const body = request.body as any;
  // Para initialize e tools/list permitimos sem token (descoberta), mas para tools/call exigimos
  // Se token ausente e cliente enviou Authorization mas inválido -> 401
  const authHeader = request.headers.authorization;
  if (authHeader && !token) {
    void reply.header('WWW-Authenticate', `Bearer resource_metadata="${getIssuer()}/.well-known/oauth-protected-resource", error="invalid_token", error_description="Token inválido ou expirado"`);
    return reply.code(401).send({ error: 'invalid_token' });
  }

  // Se body é array (batch), processa cada
  const isBatch = Array.isArray(body);
  const requests = isBatch ? body : [body];

  const responses: any[] = [];
  for (const req of requests) {
    const ctx = { token, user: payload?.sub as string | undefined };
    const res = await handleMcpRequest(req, ctx);
    if (res !== null) responses.push(res);
  }

  if (responses.length === 0) {
    void reply.code(202).send();
    return;
  }

  // Streamable HTTP: retorna JSON, com header mcp-session-id se necessário
  void reply.header('Content-Type', 'application/json');
  if (isBatch) return reply.send(responses);
  return reply.send(responses[0]);
});

app.get('/mcp', async (request, reply) => {
  // SSE stream para Streamable HTTP - server pode enviar notificações
  // Para MVP, retorna 405 se não for SSE, mas ChatGPT espera GET para abrir stream
  const accept = String(request.headers.accept ?? '');
  if (accept.includes('text/event-stream')) {
    void reply.header('Content-Type', 'text/event-stream');
    void reply.header('Cache-Control', 'no-cache');
    void reply.header('Connection', 'keep-alive');
    // Mantém aberto e envia heartbeat
    void reply.raw.write('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
    // Não fecha, mantém stream (Fastify precisa de hijack)
    // Para simplificar, fecha após 25s
    setTimeout(() => {
      try { reply.raw.end(); } catch {}
    }, 25000);
    return reply;
  }
  // Se não for SSE, retorna info
  return { name: 'notify', version: '0.1.0', transport: 'streamable-http', endpoint: '/mcp' };
});

app.get('/ws/status', { websocket: true }, (socket) => {
  const send = (data: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(data));
  };
  const unsubscribe = whatsapp.onStatus((status) => send({ type: 'whatsapp.status', status }));
  socket.on('close', unsubscribe);
});

app.post('/api/auth/login', async (request, reply) => {
  const body = z.object({ username: z.string(), password: z.string() }).parse(request.body);
  if (!verifyAdminCredentials(body.username, body.password)) {
    return reply.code(401).send({ error: 'Usuario ou senha invalidos' });
  }
  return { token: createAdminToken(body.username), username: body.username };
});

app.get('/api/auth/me', { preHandler: requireAdmin }, async () => ({ ok: true }));

app.get('/api/admin/status', { preHandler: requireAdmin }, async () => whatsapp.getStatus());
app.post('/api/admin/whatsapp/connect', { preHandler: requireAdmin }, async () => {
  await whatsapp.connect();
  return whatsapp.getStatus();
});
app.post('/api/admin/whatsapp/logout', { preHandler: requireAdmin }, async () => {
  await whatsapp.logout();
  return whatsapp.getStatus();
});

app.get('/api/admin/groups/available', { preHandler: requireAdmin }, async (request, reply) => {
  try { return await whatsapp.listGroups(); }
  catch (error) { return waError(reply, error); }
});
app.get('/api/admin/whatsapp/check-number', { preHandler: requireAdmin }, async (request, reply) => {
  const phone = String((request.query as { phone?: string }).phone ?? '');
  try { return { phone: phone.replace(/\D/g, ''), jid: await whatsapp.resolveNumber(phone) }; }
  catch (error) { return waError(reply, error); }
});
app.post('/api/admin/groups/sync', { preHandler: requireAdmin }, async (request, reply) => {
  let groups: Awaited<ReturnType<typeof whatsapp.listGroups>>;
  try { groups = await whatsapp.listGroups(); }
  catch (error) { return waError(reply, error); }
  const upsert = db.prepare(`
    insert into destinations (name, type, phone, jid, enabled, updated_at)
    values (@name, 'group', null, @jid, 1, datetime('now'))
    on conflict(jid) do update set name = excluded.name, updated_at = datetime('now')
  `);
  const tx = db.transaction(() => {
    for (const group of groups) upsert.run({ name: group.name, jid: group.jid });
  });
  tx();
  return { imported: groups.length };
});

app.get('/api/admin/destinations', { preHandler: requireAdmin }, async () => {
  return db.prepare<[], Destination>('select * from destinations order by type, name').all();
});
app.post('/api/admin/destinations', { preHandler: requireAdmin }, async (request, reply) => {
  const body = normalizeDestination(destinationInput.parse(request.body));
  const result = db.prepare(`
    insert into destinations (name, type, phone, jid, enabled)
    values (@name, @type, @phone, @jid, @enabled)
  `).run({ ...body, enabled: body.enabled === false ? 0 : 1 });
  return reply.code(201).send({ id: result.lastInsertRowid });
});
app.put('/api/admin/destinations/:id', { preHandler: requireAdmin }, async (request) => {
  const id = parseId(request);
  const body = normalizeDestination(destinationInput.parse(request.body));
  db.prepare(`
    update destinations
    set name = @name, type = @type, phone = @phone, jid = @jid, enabled = @enabled, updated_at = datetime('now')
    where id = @id
  `).run({ ...body, enabled: body.enabled === false ? 0 : 1, id });
  return { ok: true };
});
app.patch('/api/admin/destinations/:id/enabled', { preHandler: requireAdmin }, async (request, reply) => {
  const id = parseId(request);
  const body = z.object({ enabled: z.boolean() }).parse(request.body);
  const info = db.prepare('update destinations set enabled = ?, updated_at = datetime(\'now\') where id = ?').run(body.enabled ? 1 : 0, id);
  if (info.changes === 0) return reply.code(404).send({ error: 'Destino não encontrado' });
  return { ok: true, enabled: body.enabled };
});

app.delete('/api/admin/destinations/:id', { preHandler: requireAdmin }, async (request) => {
  db.prepare('delete from destinations where id = ?').run(parseId(request));
  return { ok: true };
});

app.get('/api/admin/templates', { preHandler: requireAdmin }, async () => {
  return db.prepare<[], Template>('select * from templates order by name').all().map(publicTemplate);
});
app.post('/api/admin/templates', { preHandler: requireAdmin }, async (request, reply) => {
  const body = templateInput.parse(request.body);
  const variables = extractVariables(body.body);
  const result = db.prepare(`
    insert into templates (name, body, variables_json)
    values (@name, @body, @variables_json)
  `).run({ ...body, variables_json: JSON.stringify(variables) });
  return reply.code(201).send({ id: result.lastInsertRowid, variables });
});
app.put('/api/admin/templates/:id', { preHandler: requireAdmin }, async (request) => {
  const id = parseId(request);
  const body = templateInput.parse(request.body);
  const variables = extractVariables(body.body);
  db.prepare(`
    update templates
    set name = @name, body = @body, variables_json = @variables_json, updated_at = datetime('now')
    where id = @id
  `).run({ id, ...body, variables_json: JSON.stringify(variables) });
  return { ok: true, variables };
});
app.delete('/api/admin/templates/:id', { preHandler: requireAdmin }, async (request) => {
  db.prepare('delete from templates where id = ?').run(parseId(request));
  return { ok: true };
});

app.get('/api/admin/jobs', { preHandler: requireAdmin }, async (request) => {
  const limit = Number((request.query as { limit?: string }).limit ?? 100);
  return listJobs(Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 300) : 100);
});

app.post('/api/admin/jobs/:id/retry', { preHandler: requireAdmin }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const job = db.prepare<[string], { status: string; payload_json: string }>(
    'select status, payload_json from message_jobs where id = ?'
  ).get(id);
  if (!job) return reply.code(404).send({ error: 'Job não encontrado' });
  if (job.status !== 'failed') return reply.code(400).send({ error: 'Apenas jobs com status "failed" podem ser reenfileirados' });
  try {
    return await enqueueMessage(JSON.parse(job.payload_json) as Parameters<typeof enqueueMessage>[0]);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

function detectMediaType(mimeType: string): 'image' | 'video' | 'audio' | 'document' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

await mkdir(config.uploadDir, { recursive: true });

app.post('/api/admin/upload', { preHandler: requireAdmin }, async (request, reply) => {
  const data = await request.file();
  if (!data) return reply.code(400).send({ error: 'Nenhum arquivo enviado' });
  const ext = mime.extension(data.mimetype) || 'bin';
  const filename = `${uuidv4()}.${ext}`;
  const filepath = path.join(config.uploadDir, filename);
  await pipeline(data.file, fs.createWriteStream(filepath));
  // Quando atrás de proxy (Traefik/Nginx) x-forwarded-host já contém host correto sem porta; não adicionar :3999
  const forwardedHost = request.headers['x-forwarded-host'] as string | undefined;
  const forwardedProto = request.headers['x-forwarded-proto'] as string | undefined;
  const proto = forwardedProto || request.protocol || 'http';
  const host = forwardedHost || request.hostname;
  const needsPort = !forwardedHost && ![80, 443].includes(config.port);
  const url = `${proto}://${host}${needsPort ? `:${config.port}` : ''}/uploads/${filename}`;
  return { url, filename, mimetype: data.mimetype, type: detectMediaType(data.mimetype) };
});

app.get('/api/admin/api-info', { preHandler: requireAdmin }, async (request) => {
  const forwardedHost = request.headers['x-forwarded-host'] as string | undefined;
  const forwardedProto = request.headers['x-forwarded-proto'] as string | undefined;
  const proto = forwardedProto || request.protocol || 'http';
  const host = forwardedHost || request.hostname;
  const needsPort = !forwardedHost && ![80, 443].includes(config.port);
  return { apiToken: config.apiToken, baseUrl: `${proto}://${host}${needsPort ? `:${config.port}` : ''}` };
});

app.get('/api/health', async () => ({
  ok: true,
  whatsapp: whatsapp.getStatus(),
  uptime: process.uptime(),
}));

app.post('/api/admin/send', { preHandler: requireAdmin }, async (request, reply) => {
  try {
    return await enqueueMessage(sendInput.parse(request.body));
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/send', { preHandler: requireApi }, async (request, reply) => {
  try {
    return await enqueueMessage(sendInput.parse(request.body));
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

await app.register(fastifyStatic, { root: config.uploadDir, prefix: '/uploads/' });

const publicDir = path.resolve(process.cwd(), 'dist/public');
if (fs.existsSync(publicDir)) {
  await app.register(fastifyStatic, { root: publicDir, decorateReply: false });
  app.setNotFoundHandler((request, reply) => {
    if (
      request.raw.url?.startsWith('/api') ||
      request.raw.url?.startsWith('/ws') ||
      request.raw.url?.startsWith('/uploads') ||
      request.raw.url?.startsWith('/mcp') ||
      request.raw.url?.startsWith('/.well-known') ||
      request.raw.url?.startsWith('/oauth')
    ) {
      void reply.code(404).send({ error: 'Nao encontrado' });
      return;
    }
    void reply.sendFile('index.html');
  });
}

const close = async () => {
  await worker.close();
  await app.close();
};
process.once('SIGINT', () => void close().finally(() => process.exit(0)));
process.once('SIGTERM', () => void close().finally(() => process.exit(0)));

await app.listen({ port: config.port, host: config.host });

// Auto-conectar se já houver sessão salva (evita ficar desconectado após restart do PM2)
if (fs.existsSync(path.join(config.baileysAuthDir, 'creds.json'))) {
  whatsapp.connect().catch((err) => app.log.warn({ err }, 'auto-connect whatsapp falhou'));
}
