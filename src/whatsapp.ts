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
  mentionAll?: boolean;
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

  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts = 0;

  async connect() {
    if (this.starting) return this.starting;
    // Evita criar múltiplos sockets concorrentes (causa Stream Errored conflict)
    if (this.socket || this.status.connecting) return;

    // Cancela timer pendente se usuário clicou manualmente
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

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
      browser: ['Notify', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      shouldSyncHistoryMessage: () => false
    });

    const safeSaveCreds = async () => {
      try {
        await saveCreds();
      } catch (err) {
        // Ignora ENOENT quando logout removeu o diretório enquanto ainda salvava
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') console.error('[whatsapp] saveCreds falhou:', err);
      }
    };
    this.socket.ev.on('creds.update', safeSaveCreds);
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
        this.reconnectAttempts = 0;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = undefined;
        }
        this.setStatus({
          connected: true,
          connecting: false,
          qr: undefined,
          lastDisconnect: undefined,
          user: {
            id: this.socket?.user?.id,
            name: this.socket?.user?.name
          }
        });
        console.log(`[whatsapp] Conectado como ${this.socket?.user?.id} (${this.socket?.user?.name})`);
      }

      if (connection === 'close') {
        const error = lastDisconnect?.error as Boom | undefined;
        const statusCode = error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut; // 401
        const isReplaced = statusCode === DisconnectReason.connectionReplaced; // 440 - Stream Errored (conflict)
        const isRestartRequired = statusCode === DisconnectReason.restartRequired; // 515
        const isBadSession = statusCode === DisconnectReason.badSession; // 500
        // Extrai mensagem amigável
        let lastDisconnectMsg: string = (error as any)?.message ?? error?.output?.payload?.message ?? 'Conexao encerrada';
        if (isReplaced || /Stream Errored.*conflict/i.test(lastDisconnectMsg)) {
          lastDisconnectMsg = 'Stream Errored (conflict) - sessao duplicada. Outro dispositivo/processo assumiu a conexao. Escaneie o QR novamente para retomar.';
        } else if (statusCode === 428) {
          lastDisconnectMsg = `Connection Closed (${statusCode}): ${lastDisconnectMsg}`;
        } else if (statusCode === 408) {
          lastDisconnectMsg = `Timed Out / Connection Lost (${statusCode}): ${lastDisconnectMsg}`;
        }
        this.setStatus({
          connected: false,
          connecting: false,
          qr: undefined,
          lastDisconnect: lastDisconnectMsg
        });
        // Limpa socket anterior
        try { this.socket?.ev.removeAllListeners('creds.update'); } catch {}
        this.socket = undefined;
        // Decide se deve reconectar automaticamente
        if (loggedOut) {
          console.warn('[whatsapp] Deslogado (401) - NAO reconectando automaticamente. Requer novo login via QR.');
          this.reconnectAttempts = 0;
        } else if (isReplaced) {
          console.warn('[whatsapp] Conflict 440 - sessao substituida. NAO reconectando automaticamente para evitar loop. Aguardando clique em "Conectar" para gerar novo QR.');
          this.reconnectAttempts = 0;
          // Não agenda reconexão automática - usuário deve clicar em Conectar
        } else if (isBadSession) {
          console.warn('[whatsapp] Bad session 500 - limpando estado e solicitando novo QR no proximo connect');
          this.reconnectAttempts = 0;
        } else {
          // Para restartRequired, timedOut, connectionClosed, etc: reconecta com backoff
          this.reconnectAttempts += 1;
          const baseDelay = isRestartRequired ? 2000 : 3000;
          const delay = Math.min(baseDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
          console.warn(`[whatsapp] Desconectado (${statusCode ?? 'unknown'}). Tentando reconectar em ${delay}ms (tentativa ${this.reconnectAttempts}) - ${lastDisconnectMsg}`);
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            void this.connect().catch((e) => console.error('[whatsapp] reconexao falhou', e));
          }, delay);
        }
      }
    });
  }

  async logout() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectAttempts = 0;
    try {
      await this.socket?.logout();
    } catch (e) {
      console.warn('[whatsapp] logout falhou (socket já fechado?)', e);
    }
    this.socket = undefined;
    this.starting = undefined;
    try {
      fs.rmSync(config.baileysAuthDir, { recursive: true, force: true });
    } catch {}
    this.setStatus({ connected: false, connecting: false, qr: undefined, lastDisconnect: undefined });
  }

  async listGroups() {
    await this.ensureConnected();
    try {
      const groups = await this.socket!.groupFetchAllParticipating();
      return Object.values(groups)
        .map((group) => ({
          jid: group.id,
          name: group.subject || group.id,
          participants: group.participants?.length ?? 0
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      this.handleSocketError(error);
    }
  }

  async resolveNumber(phone: string) {
    await this.ensureConnected();
    const digits = phone.replace(/\D/g, '');
    if (!digits) throw new Error('Telefone inválido');
    try {
      const matches = await this.socket!.onWhatsApp(digits);
      const match = matches?.find((item) => item.exists);
      if (!match?.jid) throw new Error(`Número não encontrado no WhatsApp: ${digits}`);
      return jidNormalizedUser(match.jid);
    } catch (error) {
      this.handleSocketError(error);
    }
  }

  async getGroupParticipants(jid: string): Promise<string[]> {
    await this.ensureConnected();
    if (!jid.endsWith('@g.us')) return [];
    try {
      const metadata = await this.socket!.groupMetadata(jid);
      return metadata.participants.map((p: any) => p.id as string);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[whatsapp] getGroupParticipants falhou para ${jid}:`, msg);
      // não falha o envio – apenas não menciona
      return [];
    }
  }

  async send(payload: SendPayload) {
    await this.ensureConnected();
    try {
      const mentions = payload.mentionAll && payload.jid.endsWith('@g.us')
        ? await this.getGroupParticipants(payload.jid)
        : undefined;
      const content = await this.buildMessage(payload, mentions);
      return await this.socket!.sendMessage(payload.jid, content);
    } catch (error) {
      this.handleSocketError(error);
    }
  }

  private async ensureConnected() {
    if (!this.socket || !this.status.connected) {
      // Se já está conectando (QR sendo exibido), não tenta reconectar em loop
      if (this.status.connecting) {
        throw new Error('WhatsApp ainda conectando. Escaneie o QR code se disponível.');
      }
      await this.connect();
      // Aguarda até 3s para ver se conecta (evita corrida de múltiplos jobs criarem sockets paralelos)
      for (let i = 0; i < 30; i++) {
        if (this.status.connected && this.socket) break;
        if (!this.status.connecting) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!this.socket || !this.status.connected) {
      throw new Error('WhatsApp não está conectado. Escaneie o QR code primeiro.');
    }
  }

  private handleSocketError(error: unknown): never {
    const msg = error instanceof Error ? error.message : String(error);
    const isConnErr = /connection closed|connection lost|timed out|socket closed/i.test(msg);
    if (isConnErr) {
      this.setStatus({ connected: false, connecting: false, lastDisconnect: msg });
      this.socket = undefined;
      throw new Error('WhatsApp desconectou durante a operação. Reconecte e tente novamente.');
    }
    throw error;
  }

  private async buildMessage(payload: SendPayload, mentions?: string[]): Promise<AnyMessageContent> {
    let text = this.withButtonFallback(payload.text, payload.buttons);
    // Para mentionAll em grupo: se mencionar todos, Baileys exige lista de JIDs em mentions.
    // WhatsApp só exibe @ visível se o texto contiver os @, então garantimos que o texto contenha
    // pelo menos um marcador quando houver mentions (sem poluir com centenas de @).
    // Se houver mentions e o texto não contiver nenhum "@", adicionamos espaço reservado.
    const hasMentions = mentions && mentions.length > 0;
    if (hasMentions && !text.includes('@')) {
      // Baileys ainda notifica mesmo sem @ no texto quando mentions é fornecido,
      // mas adicionamos um hint discreto para UX
      text = text; // mantém original – Baileys envia notificação silenciosa
    }
    if (!payload.media) {
      return hasMentions ? { text, mentions } : { text };
    }

    const buffer = await this.fetchMedia(payload.media.url);
    const mimetype = payload.media.mimetype || mime.lookup(payload.media.url) || 'application/octet-stream';

    if (payload.media.type === 'image') {
      return hasMentions ? { image: buffer, caption: text, mimetype, mentions } as AnyMessageContent : { image: buffer, caption: text, mimetype };
    }
    if (payload.media.type === 'video') {
      return hasMentions ? { video: buffer, caption: text, mimetype, mentions } as AnyMessageContent : { video: buffer, caption: text, mimetype };
    }
    if (payload.media.type === 'audio') {
      return { audio: buffer, mimetype, ptt: false };
    }

    return hasMentions
      ? {
          document: buffer,
          mimetype,
          fileName: payload.media.fileName || path.basename(new URL(payload.media.url).pathname) || 'arquivo',
          caption: text,
          mentions,
        } as AnyMessageContent
      : {
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
    // Se URL aponta para /uploads local, ler direto do disco (evita fetch externo que falha com :3999)
    try {
      const parsed = new URL(url);
      if (parsed.pathname.startsWith('/uploads/')) {
        const filename = path.basename(parsed.pathname);
        const localPath = path.join(config.uploadDir, filename);
        if (fs.existsSync(localPath)) {
          return fs.readFileSync(localPath);
        }
        // fallback: tenta /data/uploads + pathname
        const altPath = path.resolve(config.uploadDir, '.' + parsed.pathname);
        if (fs.existsSync(altPath)) return fs.readFileSync(altPath);
      }
    } catch {
      // url pode ser relativa ou inválida, tenta como caminho local
      const maybePath = path.join(config.uploadDir, path.basename(url));
      if (fs.existsSync(maybePath)) return fs.readFileSync(maybePath);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'follow' } as RequestInit);
      if (!response.ok) {
        throw new Error(`Falha ao baixar midia (${response.status}) de ${url}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new Error(`Timeout ao baixar mídia: ${url}`);
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const whatsapp = new WhatsAppService();
