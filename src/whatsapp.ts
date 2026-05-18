import fs from 'node:fs';
import path from 'node:path';
import { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  proto,
  useMultiFileAuthState,
  type AnyMessageContent,
  type WASocket
} from '@whiskeysockets/baileys';
import mime from 'mime-types';
import pino from 'pino';
import QRCode from 'qrcode';
import { config } from './config.js';

export type WhatsAppStatus = {
  connected: boolean;
  connecting: boolean;
  qr?: string;
  lastDisconnect?: string;
  user?: { id?: string; name?: string };
};

export type SendMedia = {
  type: 'image' | 'video' | 'document' | 'audio';
  url: string;
  fileName?: string;
  mimetype?: string;
};

export type SendPayload = {
  jid: string;
  text: string;
  media?: SendMedia;
  buttons?: Array<{ id?: string; text: string }>;
};

type StatusListener = (status: WhatsAppStatus) => void;
type MessageStatusListener = (update: { messageId: string; jid?: string; status: 'sent' | 'delivered' | 'read' | 'failed' }) => void;

class WhatsAppService {
  private socket?: WASocket;
  private status: WhatsAppStatus = { connected: false, connecting: false };
  private listeners = new Set<StatusListener>();
  private messageStatusListeners = new Set<MessageStatusListener>();
  private starting?: Promise<void>;

  getStatus() {
    return this.status;
  }

  onStatus(listener: StatusListener) {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  onMessageStatus(listener: MessageStatusListener) {
    this.messageStatusListeners.add(listener);
    return () => this.messageStatusListeners.delete(listener);
  }

  private setStatus(next: WhatsAppStatus) {
    this.status = next;
    for (const listener of this.listeners) listener(this.status);
  }

  async connect() {
    if (this.starting) return this.starting;
    if (this.socket && this.status.connected) return;

    this.starting = this.startSocket();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async startSocket() {
    fs.mkdirSync(config.baileysAuthDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(config.baileysAuthDir);
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'silent' });

    this.setStatus({ ...this.status, connecting: true, lastDisconnect: undefined });
    this.socket = makeWASocket({
      auth: state,
      version,
      logger,
      printQRInTerminal: false,
      browser: ['Notify', 'Chrome', '1.0.0']
    });

    this.socket.ev.on('creds.update', saveCreds);
    this.socket.ev.on('messages.update', (updates) => {
      for (const update of updates) {
        const messageId = update.key.id;
        if (!messageId) continue;
        const status = this.mapMessageStatus(update.update.status);
        if (!status) continue;
        for (const listener of this.messageStatusListeners) {
          listener({ messageId, jid: update.key.remoteJid ?? undefined, status });
        }
      }
    });
    this.socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrDataUrl = await QRCode.toDataURL(qr);
        this.setStatus({ connected: false, connecting: true, qr: qrDataUrl });
      }

      if (connection === 'open') {
        this.setStatus({
          connected: true,
          connecting: false,
          qr: undefined,
          user: {
            id: this.socket?.user?.id,
            name: this.socket?.user?.name
          }
        });
      }

      if (connection === 'close') {
        const error = lastDisconnect?.error as Boom | undefined;
        const statusCode = error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        this.setStatus({
          connected: false,
          connecting: false,
          qr: undefined,
          lastDisconnect: error?.message ?? 'Conexao encerrada'
        });
        this.socket = undefined;
        if (!loggedOut) {
          setTimeout(() => void this.connect().catch(() => undefined), 2000);
        }
      }
    });
  }

  async logout() {
    await this.socket?.logout();
    this.socket = undefined;
    fs.rmSync(config.baileysAuthDir, { recursive: true, force: true });
    this.setStatus({ connected: false, connecting: false });
  }

  async listGroups() {
    await this.ensureConnected();
    const groups = await this.socket!.groupFetchAllParticipating();
    return Object.values(groups)
      .map((group) => ({
        jid: group.id,
        name: group.subject || group.id,
        participants: group.participants?.length ?? 0
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolveNumber(phone: string) {
    await this.ensureConnected();
    const digits = phone.replace(/\D/g, '');
    if (!digits) throw new Error('Telefone invalido');
    const matches = await this.socket!.onWhatsApp(digits);
    const match = matches?.find((item) => item.exists);
    if (!match?.jid) {
      throw new Error(`Numero nao encontrado no WhatsApp: ${digits}`);
    }
    return jidNormalizedUser(match.jid);
  }

  async send(payload: SendPayload) {
    await this.ensureConnected();
    const content = await this.buildMessage(payload);
    return this.socket!.sendMessage(payload.jid, content);
  }

  private async ensureConnected() {
    if (!this.socket || !this.status.connected) {
      await this.connect();
    }
    if (!this.socket || !this.status.connected) {
      throw new Error('WhatsApp ainda nao esta conectado');
    }
  }

  private async buildMessage(payload: SendPayload): Promise<AnyMessageContent> {
    const text = this.withButtonFallback(payload.text, payload.buttons);
    if (!payload.media) return { text };

    const buffer = await this.fetchMedia(payload.media.url);
    const mimetype = payload.media.mimetype || mime.lookup(payload.media.url) || 'application/octet-stream';

    if (payload.media.type === 'image') {
      return { image: buffer, caption: text, mimetype };
    }
    if (payload.media.type === 'video') {
      return { video: buffer, caption: text, mimetype };
    }
    if (payload.media.type === 'audio') {
      return { audio: buffer, mimetype, ptt: false };
    }

    return {
      document: buffer,
      mimetype,
      fileName: payload.media.fileName || path.basename(new URL(payload.media.url).pathname) || 'arquivo',
      caption: text
    };
  }

  private mapMessageStatus(status?: proto.WebMessageInfo.Status | null) {
    if (status === proto.WebMessageInfo.Status.SERVER_ACK) return 'sent';
    if (status === proto.WebMessageInfo.Status.DELIVERY_ACK) return 'delivered';
    if (status === proto.WebMessageInfo.Status.READ || status === proto.WebMessageInfo.Status.PLAYED) return 'read';
    if (status === proto.WebMessageInfo.Status.ERROR) return 'failed';
    return null;
  }

  private withButtonFallback(text: string, buttons?: Array<{ id?: string; text: string }>) {
    if (!buttons?.length) return text;
    const options = buttons.map((button, index) => `${index + 1}. ${button.text}`).join('\n');
    return `${text}\n\n${options}`;
  }

  private async fetchMedia(url: string) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Falha ao baixar midia (${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

export const whatsapp = new WhatsAppService();
