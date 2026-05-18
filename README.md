# Notify — WhatsApp Gateway

**Gateway de WhatsApp auto-hospedado com fila de mensagens, templates, rastreamento de entrega e painel de administração.**

Conecta uma conta WhatsApp via QR code e expõe uma REST API que qualquer sistema pode usar para enviar mensagens — com suporte a templates com variáveis, mídia (imagem, vídeo, áudio, documento), botões e retentativas automáticas.

---

## Funcionalidades

- **Conexão via QR code** — vincula uma única conta WhatsApp usando o protocolo Web (Baileys)
- **Fila persistente** — BullMQ + Redis com 3 tentativas, backoff exponencial e histórico de 7 dias para falhas
- **Templates com variáveis** — padrão `{{variavel}}`, pré-processamento e extração automática de variáveis
- **Destinos nomeados** — cadastre números e grupos; sincronize grupos da conta com um clique
- **Mídia** — imagem, vídeo, áudio e documento enviados como buffer (o servidor baixa a URL e repassa ao WhatsApp)
- **Botões** — até 5 botões por mensagem, com fallback automático em texto numerado
- **Rastreamento de entrega** — status `pending → sent → delivered → read` via receipts do WhatsApp
- **Upload de arquivos** — endpoint multipart que salva localmente e devolve a URL pronta para usar no envio
- **Painel admin** — React com glassmorphism, tester de API interativo, snippets cURL/JS/Python gerados automaticamente
- **WebSocket** — status da conexão em tempo real para o painel

---

## Arquitetura

```
┌──────────────────────┐          HTTP/REST          ┌─────────────────────────────────────┐
│   Sistema externo    │  ──────────────────────────▶ │  Notify  (Fastify + TypeScript)     │
│  (CRM, ERP, script) │     X-Notify-Token            │                                     │
└──────────────────────┘                              │  ┌────────────┐  ┌───────────────┐  │
                                                      │  │ Admin API  │  │  Public API   │  │
┌──────────────────────┐          WebSocket           │  │ (JWT)      │  │  /api/send    │  │
│   Painel Admin       │  ◀────────────────────────── │  └────────────┘  └───────────────┘  │
│   (React + Vite)     │     status em tempo real      │          │                          │
└──────────────────────┘                              │          ▼                          │
                                                      │  ┌────────────────────────────────┐ │
                                                      │  │  BullMQ Worker  (concurrency=2)│ │
                                                      │  │  3 retries · backoff 5s exp.   │ │
                                                      │  └──────────────┬─────────────────┘ │
                                                      │                 │                   │
                                                      │  ┌──────────────▼──────────────┐   │
                                                      │  │  SQLite  (WAL)              │   │
                                                      │  │  destinations · templates   │   │
                                                      │  │  message_jobs               │   │
                                                      │  └─────────────────────────────┘   │
                                                      └─────────────────┬───────────────────┘
                                                                        │ Baileys
                                                                        ▼
                                                      ┌─────────────────────────────────────┐
                                                      │         WhatsApp Web                │
                                                      └─────────────────────────────────────┘
```

### Fluxo de envio

```
POST /api/send
      │
      ├─ valida schema (Zod)
      ├─ resolve destino (destinationId / jid / phone)
      ├─ renderiza template (substitui {{variáveis}})
      ├─ persiste em SQLite como "pending"
      └─ enfileira no BullMQ
             │
             ▼ worker (até 3 tentativas)
      resolveNumber() → Baileys.sendMessage()
             │
             ├─ sucesso → status "sent" + rastreia receipts (delivered / read)
             └─ falha   → backoff exponencial → status "failed" após 3 tentativas
```

---

## Requisitos

| Dependência | Versão mínima |
|-------------|---------------|
| Node.js     | 20+           |
| Redis       | 6+            |
| npm         | 10+           |

---

## Instalação e setup

```bash
# 1. Clone e instale as dependências
git clone <repo-url> notify
cd notify
npm install

# 2. Configure o ambiente
cp .env.example .env
# edite .env com suas configurações (veja seção Configuração)

# 3. Build
npm run build

# 4. Inicie
npm start
```

O servidor sobe na porta `4000` (configurável). Acesse o painel em `http://localhost:4000`.

### Desenvolvimento

```bash
# Terminal 1 — backend com hot-reload
npm run dev

# Terminal 2 — frontend com hot-reload (Vite)
npm run dev:web
```

O Vite sobe na porta `5173` e faz proxy automático para `/api`, `/uploads` e `/ws` no backend.

---

## Configuração

Crie um `.env` na raiz do projeto (use `.env.example` como base):

| Variável          | Padrão                       | Descrição                                            |
|-------------------|------------------------------|------------------------------------------------------|
| `PORT`            | `4000`                       | Porta HTTP do servidor                               |
| `HOST`            | `0.0.0.0`                    | Endereço de bind                                     |
| `DATABASE_PATH`   | `./data/notify.sqlite`       | Caminho do banco SQLite                              |
| `BAILEYS_AUTH_DIR`| `./data/baileys-auth`        | Credenciais da sessão WhatsApp                       |
| `UPLOAD_DIR`      | `./data/uploads`             | Diretório para uploads de mídia                      |
| `REDIS_URL`       | `redis://127.0.0.1:6379`     | URL de conexão com o Redis                           |
| `API_TOKEN`       | `change-me-api-token`        | Token para autenticar requisições externas           |
| `ADMIN_USER`      | `admin`                      | Usuário do painel admin                              |
| `ADMIN_PASSWORD`  | `admin123`                   | Senha do painel admin                                |
| `AUTH_SECRET`     | `change-me-long-secret`      | Segredo HMAC para assinar os tokens de sessão admin  |

> **Em produção**, troque `API_TOKEN`, `ADMIN_PASSWORD` e `AUTH_SECRET` por valores fortes e aleatórios.

---

## API Reference

### Autenticação

A API pública usa token fixo enviado como header:

```
X-Notify-Token: seu-api-token
```

Ou equivalentemente:

```
Authorization: Bearer seu-api-token
```

O painel admin usa JWT de sessão (obtido via `/api/auth/login`, válido por 12 horas).

---

### `POST /api/send`

Endpoint principal para integração externa. Enfileira uma mensagem e retorna o `jobId`.

**Headers**
```
X-Notify-Token: seu-api-token
Content-Type: application/json
```

**Body**

| Campo           | Tipo          | Obrig.       | Descrição                                                    |
|-----------------|---------------|--------------|--------------------------------------------------------------|
| `destinationId` | `number`      | condicional  | ID de um destino cadastrado no painel                        |
| `jid`           | `string`      | condicional  | JID direto ex: `5511999888777@s.whatsapp.net`                |
| `phone`         | `string`      | condicional  | Número com DDI sem formatação: `5511999888777`               |
| `message`       | `string`      | condicional  | Texto livre da mensagem                                      |
| `templateId`    | `number`      | condicional  | ID de um template salvo no painel                            |
| `variables`     | `object`      | opcional     | Variáveis para substituição no template: `{"nome":"João"}`   |
| `media.type`    | `string`      | opcional     | `image` \| `video` \| `document` \| `audio`                  |
| `media.url`     | `string (URL)`| opcional     | URL pública acessível pelo servidor                          |
| `media.fileName`| `string`      | opcional     | Nome do arquivo (recomendado para documentos)                |
| `media.mimetype`| `string`      | opcional     | MIME type (detectado automaticamente se omitido)             |
| `buttons`       | `array`       | opcional     | `[{"text":"Confirmar"},{"text":"Cancelar"}]` — máx. 5       |

> Regra: pelo menos um campo de destino (`destinationId`, `jid` ou `phone`) e pelo menos um de conteúdo (`message` ou `templateId`).

**Exemplo — texto simples por número**

```bash
curl -X POST http://localhost:4000/api/send \
  -H "X-Notify-Token: seu-api-token" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "5511999888777",
    "message": "Olá! Sua solicitação foi recebida."
  }'
```

**Exemplo — template com variáveis**

```bash
curl -X POST http://localhost:4000/api/send \
  -H "X-Notify-Token: seu-api-token" \
  -H "Content-Type: application/json" \
  -d '{
    "destinationId": 3,
    "templateId": 1,
    "variables": {
      "nome": "João Silva",
      "codigo": "OS-2024-0042",
      "data": "20/05/2024"
    }
  }'
```

**Exemplo — imagem com legenda (JavaScript)**

```javascript
const response = await fetch('http://localhost:4000/api/send', {
  method: 'POST',
  headers: {
    'X-Notify-Token': process.env.NOTIFY_TOKEN,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    phone: '5511999888777',
    message: 'Segue o relatório em anexo.',
    media: {
      type: 'document',
      url: 'https://meusite.com/relatorio.pdf',
      fileName: 'relatorio-maio-2024.pdf',
    },
  }),
});

const { id, status } = await response.json();
// { id: "uuid...", status: "pending" }
```

**Exemplo — Python**

```python
import requests, os

res = requests.post(
    'http://localhost:4000/api/send',
    headers={'X-Notify-Token': os.environ['NOTIFY_TOKEN']},
    json={
        'destinationId': 5,
        'templateId': 2,
        'variables': {'cliente': 'Empresa XYZ', 'vencimento': '30/05/2024'},
    },
)
print(res.json())
```

**Resposta de sucesso** `200`

```json
{
  "id": "a1b2c3d4-...",
  "status": "pending"
}
```

---

### Status dos jobs

| Status      | Descrição                                               |
|-------------|----------------------------------------------------------|
| `pending`   | Enfileirado, aguardando o worker processar              |
| `sent`      | Entregue ao servidor do WhatsApp (SERVER_ACK)           |
| `delivered` | Entregue ao dispositivo do destinatário (DELIVERY_ACK)  |
| `read`      | Lido pelo destinatário                                   |
| `failed`    | Falhou após 3 tentativas                                |

---

### Outros endpoints da API pública

| Método | Endpoint                    | Auth         | Descrição                                           |
|--------|-----------------------------|--------------|-----------------------------------------------------|
| `POST` | `/api/auth/login`           | —            | Login admin → retorna token de sessão               |
| `GET`  | `/api/admin/status`         | Admin JWT    | Status da conexão WhatsApp                          |
| `POST` | `/api/admin/whatsapp/connect`| Admin JWT   | Inicia conexão / gera QR                            |
| `POST` | `/api/admin/whatsapp/logout` | Admin JWT   | Desconecta e apaga credenciais locais               |
| `GET`  | `/api/admin/destinations`   | Admin JWT    | Lista destinos cadastrados                          |
| `POST` | `/api/admin/destinations`   | Admin JWT    | Cadastra número (`type: "number"`) ou grupo         |
| `PUT`  | `/api/admin/destinations/:id`| Admin JWT   | Atualiza destino                                    |
| `DELETE`|`/api/admin/destinations/:id`| Admin JWT  | Remove destino                                      |
| `POST` | `/api/admin/groups/sync`    | Admin JWT    | Importa grupos da conta conectada                   |
| `GET`  | `/api/admin/templates`      | Admin JWT    | Lista templates                                     |
| `POST` | `/api/admin/templates`      | Admin JWT    | Cria template                                       |
| `PUT`  | `/api/admin/templates/:id`  | Admin JWT    | Atualiza template                                   |
| `DELETE`|`/api/admin/templates/:id`  | Admin JWT   | Remove template                                     |
| `POST` | `/api/admin/upload`         | Admin JWT    | Upload de arquivo → retorna URL                     |
| `GET`  | `/api/admin/jobs`           | Admin JWT    | Histórico de jobs (padrão: 100, máx: 300)          |
| `POST` | `/api/admin/send`           | Admin JWT    | Envia mensagem (mesmo contrato do `/api/send`)      |
| `GET`  | `/api/admin/api-info`       | Admin JWT    | Retorna token de API e URL base                     |
| `GET`  | `/ws/status`                | —            | WebSocket com eventos de status do WhatsApp         |

---

## Templates

Templates armazenam o corpo da mensagem com variáveis no padrão `{{variavel}}`:

```
Olá {{nome}},

Sua ordem de serviço {{numero}} foi {{status}} em {{data}}.

Qualquer dúvida, estamos à disposição.
Equipe {{empresa}}
```

Ao criar o template, as variáveis são extraídas automaticamente. Ao enviar, passe o objeto `variables`:

```json
{
  "templateId": 1,
  "destinationId": 4,
  "variables": {
    "nome": "Carlos",
    "numero": "OS-1042",
    "status": "concluída",
    "data": "18/05/2024",
    "empresa": "Notify Corp"
  }
}
```

Se uma variável obrigatória estiver ausente no envio, a requisição retorna erro `400`.

---

## Upload de mídia

O endpoint `/api/admin/upload` recebe um arquivo via `multipart/form-data`, salva em `UPLOAD_DIR` e retorna a URL pública pronta para usar no campo `media.url`:

```bash
curl -X POST http://localhost:4000/api/admin/upload \
  -H "Authorization: Bearer <admin-token>" \
  -F "file=@/caminho/para/imagem.jpg"
```

```json
{
  "url": "http://localhost:4000/uploads/a1b2c3.jpg",
  "filename": "a1b2c3.jpg",
  "mimetype": "image/jpeg",
  "type": "image"
}
```

Limite padrão: **50 MB** por arquivo. Arquivos são servidos estaticamente em `/uploads/*`.

---

## Painel de administração

Acesse em `http://localhost:4000` após o build (ou `http://localhost:5173` em modo dev).

| Seção      | O que faz                                                                          |
|------------|------------------------------------------------------------------------------------|
| Conexão    | Conecta/desconecta a conta; exibe o QR code para scan                             |
| Destinos   | Cadastra números, importa grupos; exclui destinos                                  |
| Templates  | Cria, edita e exclui templates com preview de variáveis                            |
| Envio      | Envia mensagens manualmente com upload de mídia integrado                           |
| Histórico  | Lista os últimos 100 jobs com status, destino, mensagem e erro                      |
| API        | Token de API (revelar/copiar), snippets cURL/JavaScript/Python, tester interativo   |

---

## Estrutura do projeto

```
notify/
├── src/
│   ├── server.ts       # Fastify — rotas, autenticação, upload, static serve
│   ├── whatsapp.ts     # WhatsAppService (Baileys) — connect, send, receipts
│   ├── queue.ts        # BullMQ — enqueue, worker, resolução de JID
│   ├── template.ts     # Extração e renderização de variáveis {{variavel}}
│   ├── db.ts           # SQLite (better-sqlite3) — schema e migrações
│   ├── auth.ts         # Admin JWT (HMAC-SHA256) e verificação de API token
│   └── config.ts       # Variáveis de ambiente com defaults
│
├── web/
│   └── src/
│       ├── main.tsx    # App React — painel completo (login, dashboard, seções)
│       └── styles.css  # Design system glassmorphism
│
├── data/               # Gerado em runtime (gitignored)
│   ├── notify.sqlite   # Banco de dados
│   ├── baileys-auth/   # Credenciais da sessão WhatsApp
│   └── uploads/        # Arquivos enviados via upload
│
├── dist/               # Build de produção (gerado por `npm run build`)
│   ├── *.js            # Backend compilado
│   └── public/         # Frontend compilado (servido pelo Fastify)
│
├── .env.example
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## Banco de dados

Três tabelas SQLite com modo WAL habilitado:

- **`destinations`** — números e grupos cadastrados (JID único)
- **`templates`** — modelos com corpo e variáveis em JSON
- **`message_jobs`** — histórico completo com status, tentativas, timestamp de envio e ID da mensagem no WhatsApp (para rastreamento de receipts)

---

## Comportamento da fila

- **Concorrência**: 2 jobs em paralelo por worker
- **Retentativas**: até 3 tentativas por job
- **Backoff**: exponencial com delay base de 5 segundos
- **Limpeza**: jobs completos removidos após 24h; jobs falhos mantidos por 7 dias
- **Resolução de número**: antes de enviar, o worker verifica o JID real via `onWhatsApp()` e atualiza o destino caso o número tenha 9º dígito ou variação

---

## Observações

- O Notify usa **uma única conta WhatsApp** por instância. Para múltiplas contas, rode instâncias separadas em portas diferentes.
- A sessão WhatsApp é persistida em `BAILEYS_AUTH_DIR`. Para reconectar após reinício, basta ligar o servidor — o Baileys restaura a sessão automaticamente. Em caso de desconexão inesperada, o serviço reconecta automaticamente após 2 segundos.
- As URLs de mídia precisam ser **acessíveis publicamente pelo servidor** (ou pelo menos pela rede onde ele roda), pois o worker faz o download do arquivo antes de enviar ao WhatsApp.
- Em produção, recomenda-se colocar um **reverse proxy** (nginx, Caddy) na frente para HTTPS, e usar `X-Forwarded-Proto` / `X-Forwarded-Host` para que as URLs de upload retornadas sejam corretas.
