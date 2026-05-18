import 'dotenv/config';
import path from 'node:path';

const root = process.cwd();

export const config = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '0.0.0.0',
  databasePath: path.resolve(root, process.env.DATABASE_PATH ?? './data/notify.sqlite'),
  baileysAuthDir: path.resolve(root, process.env.BAILEYS_AUTH_DIR ?? './data/baileys-auth'),
  uploadDir: path.resolve(root, process.env.UPLOAD_DIR ?? './data/uploads'),
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  apiToken: process.env.API_TOKEN ?? 'change-me-api-token',
  adminUser: process.env.ADMIN_USER ?? 'admin',
  adminPassword: process.env.ADMIN_PASSWORD ?? 'admin123',
  authSecret: process.env.AUTH_SECRET ?? 'change-me-long-secret'
};

