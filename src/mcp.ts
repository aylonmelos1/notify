import { z } from 'zod';
import { whatsapp } from './whatsapp.js';
import { db } from './db.js';
import { enqueueMessage, listJobs } from './queue.js';
import { verifyAccessToken } from './oauth.js';

// MCP Tool definitions com securitySchemes para ChatGPT
export type McpTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: any;
  outputSchema?: any;
  securitySchemes?: Array<{ type: 'noauth' } | { type: 'oauth2'; scopes: string[] }>;
  handler: (args: any, context: { user?: string; token?: string }) => Promise<any>;
};

// Zod schemas para tools
const sendSchema = z.object({
  destinationId: z.number().int().positive().optional(),
  jid: z.string().optional(),
  phone: z.string().optional(),
  message: z.string().min(1).optional(),
  templateId: z.number().int().positive().optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
  media: z
    .object({
      type: z.enum(['image', 'video', 'document', 'audio']),
      url: z.string().url(),
      fileName: z.string().optional(),
      mimetype: z.string().optional(),
    })
    .optional(),
  buttons: z
    .array(z.object({ id: z.string().optional(), text: z.string().min(1) }))
    .max(5)
    .optional(),
  mentionAll: z.boolean().optional(),
});

export const tools: McpTool[] = [
  {
    name: 'whatsapp_status',
    title: 'WhatsApp Status',
    description: 'Retorna status da conexão WhatsApp (connected, connecting, qr, lastDisconnect, user). Use para verificar se precisa escanear QR.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    securitySchemes: [{ type: 'noauth' }],
    handler: async () => {
      const s = whatsapp.getStatus();
      return {
        content: [{ type: 'text', text: JSON.stringify(s, null, 2) }],
        structuredContent: s,
      };
    },
  },
  {
    name: 'whatsapp_send',
    title: 'Send WhatsApp Message',
    description:
      'Envia mensagem WhatsApp via fila. Requer destinationId (ID do destino cadastrado) OU jid (ex: 5511999999999@s.whatsapp.net, 1203...@g.us) OU phone (apenas dígitos). message é obrigatório a menos que templateId seja usado. Suporta media, buttons e mentionAll para grupos. Retorna job id com status pending.',
    inputSchema: {
      type: 'object',
      properties: {
        destinationId: { type: 'number', description: 'ID do destino cadastrado em /api/admin/destinations' },
        jid: { type: 'string', description: 'JID direto, ex: 5511999999999@s.whatsapp.net ou 120363...@g.us' },
        phone: { type: 'string', description: 'Telefone apenas dígitos, ex: 5511999999999' },
        templateId: { type: 'number', description: 'ID do template cadastrado' },
        message: { type: 'string', description: 'Texto da mensagem (ou leave empty se usar template)' },
        variables: { type: 'object', description: 'Variáveis para template', additionalProperties: true },
        media: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['image', 'video', 'document', 'audio'] },
            url: { type: 'string', format: 'uri' },
            fileName: { type: 'string' },
            mimetype: { type: 'string' },
          },
          required: ['type', 'url'],
        },
        buttons: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['text'] },
          maxItems: 5,
        },
        mentionAll: { type: 'boolean', description: 'Menciona todos em grupo @g.us' },
      },
      required: [],
      additionalProperties: false,
    },
    securitySchemes: [{ type: 'oauth2', scopes: ['notify:send'] }],
    handler: async (args, context) => {
      // Verificação de auth já feita no middleware, mas double-check para mensagem amigável
      if (!context.token) {
        return authRequiredError();
      }
      const parsed = sendSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: `Parâmetros inválidos: ${parsed.error.message}` }],
          isError: true,
        };
      }
      const p = parsed.data;
      if (!p.destinationId && !p.jid && !p.phone) {
        return { content: [{ type: 'text', text: 'Informe destinationId, jid ou phone' }], isError: true };
      }
      if (!p.templateId && !p.message) {
        return { content: [{ type: 'text', text: 'Informe templateId ou message' }], isError: true };
      }
      try {
        const result = await enqueueMessage({
          destinationId: p.destinationId,
          jid: p.jid,
          phone: p.phone,
          templateId: p.templateId,
          message: p.message,
          variables: p.variables,
          media: p.media as any,
          buttons: p.buttons,
          mentionAll: p.mentionAll,
        });
        return {
          content: [{ type: 'text', text: `Mensagem enfileirada com id ${result.id} status ${result.status}. Use list_jobs para acompanhar.` }],
          structuredContent: result,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const isWaError = /não está conectado|desconectou|connection/i.test(msg);
        if (isWaError) {
          return {
            content: [{ type: 'text', text: `WhatsApp não conectado: ${msg}. Escaneie o QR via whatsapp_status.` }],
            isError: true,
            _meta: {
              'mcp/www_authenticate':
                'Bearer resource_metadata="https://notify.abaincendio.com.br/.well-known/oauth-protected-resource", error="insufficient_scope", error_description="WhatsApp desconectado - reconecte"',
            },
          };
        }
        return { content: [{ type: 'text', text: `Erro: ${msg}` }], isError: true };
      }
    },
  },
  {
    name: 'list_destinations',
    title: 'List Destinations',
    description: 'Lista todos destinos cadastrados (números e grupos) com id, name, type, jid, phone, enabled.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    securitySchemes: [{ type: 'oauth2', scopes: ['notify:read'] }],
    handler: async (_args, context) => {
      if (!context.token) return authRequiredError();
      const rows = db.prepare('select * from destinations order by type, name').all() as any[];
      return {
        content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }],
        structuredContent: { destinations: rows },
      };
    },
  },
  {
    name: 'list_templates',
    title: 'List Templates',
    description: 'Lista templates com variáveis.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    securitySchemes: [{ type: 'oauth2', scopes: ['notify:read'] }],
    handler: async (_args, context) => {
      if (!context.token) return authRequiredError();
      const rows = db.prepare('select * from templates order by name').all() as any[];
      const mapped = rows.map((r) => ({ ...r, variables: JSON.parse(r.variables_json) }));
      return {
        content: [{ type: 'text', text: JSON.stringify(mapped, null, 2) }],
        structuredContent: { templates: mapped },
      };
    },
  },
  {
    name: 'list_jobs',
    title: 'List Jobs',
    description: 'Lista últimos jobs de envio com status (pending, sent, delivered, read, failed).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', minimum: 1, maximum: 300, default: 20 },
      },
      additionalProperties: false,
    },
    securitySchemes: [{ type: 'oauth2', scopes: ['notify:read'] }],
    handler: async (args, context) => {
      if (!context.token) return authRequiredError();
      const limit = args?.limit ?? 20;
      const jobs = listJobs(Math.min(Math.max(Number(limit) || 20, 1), 300));
      return {
        content: [{ type: 'text', text: JSON.stringify(jobs.slice(0, limit), null, 2) }],
        structuredContent: { jobs: jobs.slice(0, limit) },
      };
    },
  },
  {
    name: 'list_groups_available',
    title: 'List WhatsApp Groups Available',
    description: 'Lista grupos que o WhatsApp participa (requer conexão ativa).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    securitySchemes: [{ type: 'oauth2', scopes: ['notify:read'] }],
    handler: async (_args, context) => {
      if (!context.token) return authRequiredError();
      try {
        const groups = await whatsapp.listGroups();
        return {
          content: [{ type: 'text', text: JSON.stringify(groups, null, 2) }],
          structuredContent: { groups },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: `Erro: ${msg}` }], isError: true };
      }
    },
  },
  {
    name: 'check_number',
    title: 'Check Number on WhatsApp',
    description: 'Verifica se telefone existe no WhatsApp e retorna JID normalizado.',
    inputSchema: {
      type: 'object',
      properties: { phone: { type: 'string', description: 'Telefone com DDD, ex: 5511999999999' } },
      required: ['phone'],
      additionalProperties: false,
    },
    securitySchemes: [{ type: 'oauth2', scopes: ['notify:read'] }],
    handler: async (args, context) => {
      if (!context.token) return authRequiredError();
      if (!args?.phone) return { content: [{ type: 'text', text: 'phone required' }], isError: true };
      try {
        const jid = await whatsapp.resolveNumber(String(args.phone));
        return { content: [{ type: 'text', text: `JID: ${jid}` }], structuredContent: { phone: String(args.phone).replace(/\D/g, ''), jid } };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: `Erro: ${msg}` }], isError: true };
      }
    },
  },
];

function authRequiredError() {
  return {
    content: [{ type: 'text', text: 'Authentication required: faça login via OAuth para usar esta ferramenta.' }],
    isError: true,
    _meta: {
      'mcp/www_authenticate':
        'Bearer resource_metadata="https://notify.abaincendio.com.br/.well-known/oauth-protected-resource", error="insufficient_scope", error_description="You need to login to continue"',
    },
  };
}

// MCP JSON-RPC handlers
export async function handleMcpRequest(body: any, context: { token?: string; user?: string }) {
  const { jsonrpc, id, method, params } = body ?? {};
  if (jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }

  // initialize
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'notify', version: '0.1.0' },
      },
    };
  }

  if (method === 'notifications/initialized') {
    return null; // no response
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    // ChatGPT filtra por securitySchemes + token. Se não autenticado, ainda lista mas marca
    const list = tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
      securitySchemes: t.securitySchemes,
    }));
    return { jsonrpc: '2.0', id, result: { tools: list } };
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params ?? {};
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Tool not found: ${name}` } };
    }
    // Verifica auth se tool exige oauth2
    const requiresAuth = tool.securitySchemes?.some((s) => s.type === 'oauth2');
    if (requiresAuth && !context.token) {
      const errRes = authRequiredError();
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: errRes.content,
          isError: true,
          _meta: errRes._meta,
        },
      };
    }
    try {
      const result = await tool.handler(args ?? {}, { user: context.user, token: context.token });
      // Garante que _meta seja preservado se handler retornou
      return { jsonrpc: '2.0', id, result };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { jsonrpc: '2.0', id, error: { code: -32603, message: msg } };
    }
  }

  // Recursos e prompts vazios mas compatíveis
  if (method === 'resources/list' || method === 'prompts/list') {
    return { jsonrpc: '2.0', id, result: { resources: [], prompts: [] } };
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

export function getToolNames() {
  return tools.map((t) => t.name);
}
