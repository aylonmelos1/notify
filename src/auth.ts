import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { config } from './config.js';

const tokenTtlMs = 1000 * 60 * 60 * 12;

function sign(data: string) {
  return crypto.createHmac('sha256', config.authSecret).update(data).digest('base64url');
}

export function createAdminToken(username: string) {
  const payload = Buffer.from(JSON.stringify({ username, exp: Date.now() + tokenTtlMs })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyAdminToken(token?: string) {
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature || sign(payload) !== signature) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { username: string; exp: number };
    if (!parsed.username || Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getBearerToken(request: FastifyRequest) {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim();
}

export function verifyAdminCredentials(username: string, password: string) {
  return username === config.adminUser && password === config.adminPassword;
}

export function verifyApiToken(request: FastifyRequest) {
  const headerToken = request.headers['x-notify-token'];
  const authToken = getBearerToken(request);
  return headerToken === config.apiToken || authToken === config.apiToken;
}

