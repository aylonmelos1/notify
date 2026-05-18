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

const app = Fastify({ logger: true });
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
  destinationId: z.number().int().positive().optional(),
  jid: z.string().min(3).optional(),
  phone: z.string().min(8).optional(),
  templateId: z.number().int().positive().optional(),
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
  })).max(5).optional()
}).refine((body) => body.destinationId || body.jid || body.phone, 'Informe destinationId, jid ou phone')
  .refine((body) => body.templateId || body.message, 'Informe templateId ou message');

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

await app.register(cors, { origin: true });
await app.register(websocket);
await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

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

app.get('/api/admin/groups/available', { preHandler: requireAdmin }, async () => whatsapp.listGroups());
app.get('/api/admin/whatsapp/check-number', { preHandler: requireAdmin }, async (request) => {
  const phone = String((request.query as { phone?: string }).phone ?? '');
  return { phone: phone.replace(/\D/g, ''), jid: await whatsapp.resolveNumber(phone) };
});
app.post('/api/admin/groups/sync', { preHandler: requireAdmin }, async () => {
  const groups = await whatsapp.listGroups();
  const upsert = db.prepare(`
    insert into destinations (name, type, phone, jid, enabled, updated_at)
    values (@name, 'group', null, @jid, 1, datetime('now'))
    on conflict(jid) do update set name = excluded.name, enabled = 1, updated_at = datetime('now')
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
  const proto = (request.headers['x-forwarded-proto'] as string) || request.protocol || 'http';
  const host = (request.headers['x-forwarded-host'] as string) || request.hostname;
  const portSuffix = [80, 443].includes(config.port) ? '' : `:${config.port}`;
  const url = `${proto}://${host}${portSuffix}/uploads/${filename}`;
  return { url, filename, mimetype: data.mimetype, type: detectMediaType(data.mimetype) };
});

app.get('/api/admin/api-info', { preHandler: requireAdmin }, async (request) => {
  const proto = (request.headers['x-forwarded-proto'] as string) || request.protocol || 'http';
  const host = (request.headers['x-forwarded-host'] as string) || request.hostname;
  const portSuffix = [80, 443].includes(config.port) ? '' : `:${config.port}`;
  return { apiToken: config.apiToken, baseUrl: `${proto}://${host}${portSuffix}` };
});

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
    if (request.raw.url?.startsWith('/api') || request.raw.url?.startsWith('/ws') || request.raw.url?.startsWith('/uploads')) {
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
