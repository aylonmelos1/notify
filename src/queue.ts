import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';
import { db, type Destination, type MessageJob, type Template } from './db.js';
import { renderTemplate } from './template.js';
import { whatsapp, type SendMedia } from './whatsapp.js';

export type EnqueuePayload = {
  destinationId?: number;
  jid?: string;
  phone?: string;
  templateId?: number;
  message?: string;
  variables?: Record<string, unknown>;
  media?: SendMedia;
  buttons?: Array<{ id?: string; text: string }>;
  mentionAll?: boolean;
};

type JobData = {
  id: string;
  jid: string;
  text: string;
  media?: SendMedia;
  buttons?: Array<{ id?: string; text: string }>;
  mentionAll?: boolean;
};

function createRedis() {
  return new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
}
const queueConnection = createRedis();
const workerConnection = createRedis();
queueConnection.on('error', (e) => console.error('[redis queue] error', e.message));
workerConnection.on('error', (e) => console.error('[redis worker] error', e.message));
export const sendQueue = new Queue<JobData>('notify-send', { connection: queueConnection });

const getDestination = db.prepare<number, Destination>('select * from destinations where id = ? and enabled = 1');
const getTemplate = db.prepare<number, Template>('select * from templates where id = ?');
const insertJob = db.prepare(`
  insert into message_jobs
    (id, destination_id, destination_jid, destination_name, template_id, message_text, payload_json, status)
  values
    (@id, @destination_id, @destination_jid, @destination_name, @template_id, @message_text, @payload_json, 'pending')
`);
const markSent = db.prepare('update message_jobs set status = ?, baileys_message_id = ?, attempts = ?, error = null, sent_at = datetime(\'now\'), updated_at = datetime(\'now\') where id = ?');
const markAccepted = db.prepare('update message_jobs set baileys_message_id = ?, attempts = ?, error = null, updated_at = datetime(\'now\') where id = ?');
const markFailed = db.prepare('update message_jobs set status = ?, error = ?, attempts = ?, updated_at = datetime(\'now\') where id = ?');
const markReceipt = db.prepare('update message_jobs set status = ?, sent_at = coalesce(sent_at, datetime(\'now\')), updated_at = datetime(\'now\') where baileys_message_id = ?');
const updateResolvedJid = db.prepare('update message_jobs set destination_jid = ?, updated_at = datetime(\'now\') where id = ?');
const updateDestinationResolvedJid = db.prepare('update destinations set jid = ?, updated_at = datetime(\'now\') where id = ?');

export async function enqueueMessage(payload: EnqueuePayload) {
  const id = uuidv4();
  const destination = resolveDestination(payload);
  const rendered = resolveMessage(payload);

  insertJob.run({
    id,
    destination_id: destination.id,
    destination_jid: destination.jid,
    destination_name: destination.name,
    template_id: payload.templateId ?? null,
    message_text: rendered,
    payload_json: JSON.stringify(payload)
  });

  await sendQueue.add('send', {
    id,
    jid: destination.jid,
    text: rendered,
    media: payload.media,
    buttons: payload.buttons,
    mentionAll: payload.mentionAll,
  }, {
    jobId: id,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 60 * 60 * 24 },
    removeOnFail: { age: 60 * 60 * 24 * 7 }
  });

  return { id, status: 'pending' as const };
}

function resolveDestination(payload: EnqueuePayload) {
  if (payload.destinationId) {
    const destination = getDestination.get(payload.destinationId);
    if (!destination) throw new Error('Destino nao encontrado ou desativado');
    return {
      id: destination.id,
      jid: destination.jid,
      name: destination.name
    };
  }

  if (payload.jid) {
    return { id: null, jid: payload.jid, name: null };
  }

  if (payload.phone) {
    const digits = payload.phone.replace(/\D/g, '');
    if (!digits) throw new Error('Telefone invalido');
    return { id: null, jid: `${digits}@s.whatsapp.net`, name: null };
  }

  throw new Error('Informe destinationId, jid ou phone');
}

function resolveMessage(payload: EnqueuePayload) {
  if (payload.templateId) {
    const template = getTemplate.get(payload.templateId);
    if (!template) throw new Error('Template nao encontrado');
    return renderTemplate(template.body, payload.variables ?? {});
  }

  if (payload.message?.trim()) {
    return payload.message.trim();
  }

  throw new Error('Informe templateId ou message');
}

export function startSendWorker() {
  return new Worker<JobData>('notify-send', handleJob, { connection: workerConnection, concurrency: 2 });
}

async function handleJob(job: Job<JobData>) {
  try {
    // Não sobrescrever @lid com onWhatsApp que falharia; resolver apenas números puros.
    // Se jid já contém @lid ou @g.us, manter como está.
    let jid = job.data.jid;
    if (jid.endsWith('@s.whatsapp.net')) {
      try {
        const resolved = await whatsapp.resolveNumber(jid);
        // resolved pode ser @lid (novo padrão) ou @s.whatsapp.net normalizado
        jid = resolved;
      } catch (err) {
        // Se falhar onWhatsApp (ex: número válido mas temporário), tenta enviar com jid original
        console.warn(`[queue] resolveNumber falhou para ${jid}:`, (err as Error).message);
      }
    }
    // Atualiza job com jid resolvido (mesmo que @lid, útil para histórico)
    updateResolvedJid.run(jid, job.data.id);
    const savedJob = db.prepare<string, MessageJob>('select * from message_jobs where id = ?').get(job.data.id);
    // Não sobrescrever destinos @s.whatsapp.net com @lid automaticamente (preserva número original)
    // Apenas atualiza se o jid resolvido for diferente e contiver o número original, ou se for conversão lid->pn conhecida.
    // Por segurança, manter destinos número como @s.whatsapp.net para permitir re-resolução futura.
    const result = await whatsapp.send({
      jid,
      text: job.data.text,
      media: job.data.media,
      buttons: job.data.buttons,
      mentionAll: job.data.mentionAll,
    });
    // Enviar marca como sent imediatamente (não apenas pending); receipt posterior atualiza para delivered/read
    const baileysId = result?.key?.id ?? null;
    if (baileysId) {
      markSent.run('sent', baileysId, job.attemptsMade + 1, job.data.id);
    } else {
      markAccepted.run(null, job.attemptsMade + 1, job.data.id);
      // fallback: também marca sent se não temos id mas não houve erro
      db.prepare("update message_jobs set status='sent', sent_at=datetime('now'), updated_at=datetime('now') where id=? and status='pending'").run(job.data.id);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Não contar como tentativa falha se erro é de conexão temporária e BullMQ vai retentar
    markFailed.run('failed', message, job.attemptsMade + 1, job.data.id);
    throw error;
  }
}

whatsapp.onMessageStatus(({ messageId, status }) => {
  try {
    markReceipt.run(status, messageId);
  } catch (e) {
    console.error('[queue] markReceipt failed', e);
  }
});

export function listJobs(limit = 100) {
  return db.prepare<number, MessageJob>('select * from message_jobs order by created_at desc limit ?').all(limit);
}
