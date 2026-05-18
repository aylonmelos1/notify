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
};

type JobData = {
  id: string;
  jid: string;
  text: string;
  media?: SendMedia;
  buttons?: Array<{ id?: string; text: string }>;
};

const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
export const sendQueue = new Queue<JobData>('notify-send', { connection });

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
    buttons: payload.buttons
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
  return new Worker<JobData>('notify-send', handleJob, { connection, concurrency: 2 });
}

async function handleJob(job: Job<JobData>) {
  try {
    const jid = job.data.jid.endsWith('@s.whatsapp.net')
      ? await whatsapp.resolveNumber(job.data.jid)
      : job.data.jid;
    updateResolvedJid.run(jid, job.data.id);
    const savedJob = db.prepare<string, MessageJob>('select * from message_jobs where id = ?').get(job.data.id);
    if (savedJob?.destination_id) {
      updateDestinationResolvedJid.run(jid, savedJob.destination_id);
    }
    const result = await whatsapp.send({
      jid,
      text: job.data.text,
      media: job.data.media,
      buttons: job.data.buttons
    });
    markAccepted.run(result?.key?.id ?? null, job.attemptsMade + 1, job.data.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markFailed.run('failed', message, job.attemptsMade + 1, job.data.id);
    throw error;
  }
}

whatsapp.onMessageStatus(({ messageId, status }) => {
  markReceipt.run(status, messageId);
});

export function listJobs(limit = 100) {
  return db.prepare<number, MessageJob>('select * from message_jobs order by created_at desc limit ?').all(limit);
}
