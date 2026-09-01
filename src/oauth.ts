import crypto from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';

// Inicializa tabelas OAuth
db.exec(`
create table if not exists oauth_clients (
  client_id text primary key,
  client_secret text,
  redirect_uris text not null,
  grant_types text not null,
  token_endpoint_auth_method text not null,
  client_name text,
  created_at text not null default (datetime('now'))
);
create table if not exists oauth_codes (
  code text primary key,
  client_id text not null,
  redirect_uri text not null,
  code_challenge text,
  code_challenge_method text,
  scope text,
  resource text,
  user text not null,
  expires_at integer not null,
  created_at text not null default (datetime('now'))
);
create table if not exists oauth_tokens (
  access_token text primary key,
  refresh_token text,
  client_id text not null,
  scope text,
  resource text,
  user text not null,
  expires_at integer not null,
  created_at text not null default (datetime('now'))
);
`);

const ISSUER = process.env.OAUTH_ISSUER ?? 'https://notify.abaincendio.com.br';
const RESOURCE = process.env.OAUTH_RESOURCE ?? 'https://notify.abaincendio.com.br/mcp';
const AUTH_SECRET = config.authSecret;

// Gera JWT HS256 simples sem lib externa (usa crypto)
function base64urlEncode(buf: Buffer | string) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.toString('base64url');
}
function base64urlDecode(str: string) {
  return Buffer.from(str, 'base64url').toString('utf8');
}

export type OAuthClient = {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: string;
  client_name?: string;
};

export function getIssuer() { return ISSUER; }
export function getResource() { return RESOURCE; }

export function getProtectedResourceMetadata() {
  return {
    resource: RESOURCE,
    authorization_servers: [ISSUER],
    scopes_supported: ['notify:read', 'notify:send', 'notify:admin'],
    bearer_methods_supported: ['header'] as const,
    resource_documentation: 'https://notify.abaincendio.com.br/docs',
  };
}

export function getAuthorizationServerMetadata() {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    registration_endpoint: `${ISSUER}/oauth/register`,
    jwks_uri: `${ISSUER}/.well-known/jwks.json`,
    scopes_supported: ['notify:read', 'notify:send', 'notify:admin', 'openid', 'email', 'profile'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic', 'private_key_jwt'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    revocation_endpoint: `${ISSUER}/oauth/revoke`,
  };
}

// JWKS para HS256 não precisa RSA, mas ChatGPT espera jwks_uri acessível. Servimos uma chave oct fictícia derivada de AUTH_SECRET.
export function getJwks() {
  // Para HS256, não há JWKS real; servimos um oct para compatibilidade, mas verificação será feita via HMAC.
  // Se cliente esperar RS256, ainda passará porque validamos via HMAC internamente.
  const keyBytes = crypto.createHash('sha256').update(AUTH_SECRET).digest();
  return {
    keys: [
      {
        kty: 'oct',
        k: base64urlEncode(keyBytes),
        kid: 'notify-hs256-1',
        alg: 'HS256',
        use: 'sig',
      },
    ],
  };
}

// Helpers PKCE S256
export function verifyPKCE(verifier: string, challenge: string, method: string) {
  if (method !== 'S256') return false;
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return base64urlEncode(hash) === challenge;
}

export function createAccessToken(payload: { sub: string; aud: string; scope: string; client_id: string }) {
  const header = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'notify-hs256-1' }));
  const now = Math.floor(Date.now() / 1000);
  const body = base64urlEncode(
    JSON.stringify({
      iss: ISSUER,
      aud: payload.aud,
      sub: payload.sub,
      scope: payload.scope,
      client_id: payload.client_id,
      iat: now,
      exp: now + 3600, // 1h
      jti: crypto.randomUUID(),
    })
  );
  const data = `${header}.${body}`;
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyAccessToken(token: string): { sub: string; aud: string; scope: string; exp: number; iss: string } | null {
  try {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return null;
    const data = `${h}.${p}`;
    const expected = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return null;
    const payload = JSON.parse(base64urlDecode(p));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;
    if (payload.iss !== ISSUER) return null;
    // aud deve ser o resource exato (com tolerância a trailing slash)
    const audNorm = String(payload.aud).replace(/\/$/, '');
    const resNorm = RESOURCE.replace(/\/$/, '');
    if (audNorm !== resNorm) return null;
    return payload;
  } catch {
    return null;
  }
}

// DCR
export function registerClient(body: any): OAuthClient {
  const redirectUris: string[] = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) throw new Error('redirect_uris required');
  // Validar que são https (exceto localhost)
  for (const uri of redirectUris) {
    try {
      const u = new URL(uri);
      if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') throw new Error();
    } catch {
      throw new Error(`redirect_uri inválido: ${uri}`);
    }
  }
  const clientId = `notify_${crypto.randomUUID()}`;
  const authMethod = body.token_endpoint_auth_method ?? 'none';
  // scope opcional para compatibilidade ChatGPT que não envia scope no DCR (TREK #959)
  const client: OAuthClient = {
    client_id: clientId,
    redirect_uris: redirectUris,
    grant_types: body.grant_types ?? ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: authMethod,
    client_name: body.client_name ?? 'ChatGPT',
  };
  db.prepare(
    `insert into oauth_clients (client_id, client_secret, redirect_uris, grant_types, token_endpoint_auth_method, client_name) values (?,?,?,?,?,?)`
  ).run(clientId, null, JSON.stringify(redirectUris), JSON.stringify(client.grant_types), authMethod, client.client_name);
  return client;
}

export function getClient(clientId: string): OAuthClient | null {
  // CIMD: client_id é URL https://
  if (clientId.startsWith('https://')) {
    // Para CIMD, não está no DB; consideramos válido se for ChatGPT
    // Vamos buscar se é conhecido ou tratar como public client
    return {
      client_id: clientId,
      redirect_uris: [], // validado via fetch externo
      grant_types: ['authorization_code'],
      token_endpoint_auth_method: 'none',
      client_name: 'CIMD',
    };
  }
  const row = db.prepare<string, any>('select * from oauth_clients where client_id=?').get(clientId) as any;
  if (!row) return null;
  return {
    client_id: row.client_id,
    client_secret: row.client_secret,
    redirect_uris: JSON.parse(row.redirect_uris),
    grant_types: JSON.parse(row.grant_types),
    token_endpoint_auth_method: row.token_endpoint_auth_method,
    client_name: row.client_name,
  };
}

export async function validateCIMD(clientId: string, redirectUri: string): Promise<boolean> {
  if (!clientId.startsWith('https://')) return false;
  try {
    const res = await fetch(clientId, { redirect: 'follow' });
    if (!res.ok) return false;
    const meta = (await res.json()) as any;
    const allowed = meta.redirect_uris as string[] | undefined;
    if (!Array.isArray(allowed)) return true; // se não lista, aceita ChatGPT
    // Verifica se redirectUri está na lista ou se é chatgpt.com
    if (allowed.includes(redirectUri)) return true;
    // Fallback: ChatGPT usa https://chatgpt.com/connector_platform_oauth_redirect ou /connector/oauth/{id}
    const url = new URL(redirectUri);
    if (url.hostname === 'chatgpt.com' && url.pathname.startsWith('/connector')) return true;
    if (url.hostname === 'chatgpt.com' && url.pathname.startsWith('/oauth')) return true;
    return false;
  } catch {
    // Se falhar fetch, ainda permite chatgpt.com para não bloquear
    try {
      const url = new URL(redirectUri);
      if (url.hostname === 'chatgpt.com') return true;
    } catch {}
    return false;
  }
}

// Authorization code
export function createAuthCode(params: {
  client_id: string;
  redirect_uri: string;
  code_challenge?: string;
  code_challenge_method?: string;
  scope?: string;
  resource?: string;
  user: string;
}) {
  const code = base64urlEncode(crypto.randomBytes(32));
  const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 min
  db.prepare(
    `insert into oauth_codes (code, client_id, redirect_uri, code_challenge, code_challenge_method, scope, resource, user, expires_at) values (?,?,?,?,?,?,?,?,?)`
  ).run(
    code,
    params.client_id,
    params.redirect_uri,
    params.code_challenge ?? null,
    params.code_challenge_method ?? null,
    params.scope ?? null,
    params.resource ?? null,
    params.user,
    expiresAt
  );
  return code;
}

export function consumeAuthCode(code: string, clientId: string, redirectUri: string, codeVerifier?: string) {
  const row = db.prepare<string, any>('select * from oauth_codes where code=?').get(code) as any;
  if (!row) throw new Error('invalid_grant');
  if (row.client_id !== clientId) throw new Error('invalid_grant');
  if (row.redirect_uri !== redirectUri) throw new Error('invalid_grant');
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at < now) throw new Error('invalid_grant');
  if (row.code_challenge) {
    if (!codeVerifier) throw new Error('invalid_grant: code_verifier required');
    if (!verifyPKCE(codeVerifier, row.code_challenge, row.code_challenge_method)) throw new Error('invalid_grant: PKCE failed');
  }
  // Consome
  db.prepare('delete from oauth_codes where code=?').run(code);
  return row;
}

// Tokens
export function storeToken(accessToken: string, clientId: string, scope: string, resource: string, user: string) {
  const payload = JSON.parse(base64urlDecode(accessToken.split('.')[1]));
  db.prepare(
    `insert into oauth_tokens (access_token, client_id, scope, resource, user, expires_at) values (?,?,?,?,?,?)`
  ).run(accessToken, clientId, scope, resource, user, payload.exp);
}

export function cleanExpired() {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('delete from oauth_codes where expires_at < ?').run(now);
  db.prepare('delete from oauth_tokens where expires_at < ?').run(now);
}
setInterval(cleanExpired, 60_000);

export function getTokenInfo(token: string) {
  const row = db.prepare<string, any>('select * from oauth_tokens where access_token=?').get(token) as any;
  if (!row) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at < now) return null;
  return row;
}
