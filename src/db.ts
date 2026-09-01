import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
create table if not exists destinations (
  id integer primary key autoincrement,
  name text not null,
  type text not null check (type in ('number', 'group')),
  phone text,
  jid text not null unique,
  enabled integer not null default 1,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);

create table if not exists templates (
  id integer primary key autoincrement,
  name text not null unique,
  body text not null,
  variables_json text not null default '[]',
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);

create table if not exists message_jobs (
  id text primary key,
  destination_id integer,
  destination_jid text not null,
  destination_name text,
  template_id integer,
  message_text text not null,
  payload_json text not null,
  status text not null check (status in ('pending', 'sent', 'failed', 'delivered', 'read')),
  error text,
  baileys_message_id text,
  attempts integer not null default 0,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now')),
  sent_at text,
  foreign key (destination_id) references destinations(id) on delete set null,
  foreign key (template_id) references templates(id) on delete set null
);

create index if not exists idx_message_jobs_created_at on message_jobs(created_at desc);
create index if not exists idx_message_jobs_status on message_jobs(status);
create index if not exists idx_message_jobs_baileys on message_jobs(baileys_message_id);
create index if not exists idx_destinations_type on destinations(type);
`);

export type Destination = {
  id: number;
  name: string;
  type: 'number' | 'group';
  phone: string | null;
  jid: string;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
};

export type Template = {
  id: number;
  name: string;
  body: string;
  variables_json: string;
  created_at: string;
  updated_at: string;
};

export type MessageJob = {
  id: string;
  destination_id: number | null;
  destination_jid: string;
  destination_name: string | null;
  template_id: number | null;
  message_text: string;
  payload_json: string;
  status: 'pending' | 'sent' | 'failed' | 'delivered' | 'read';
  error: string | null;
  baileys_message_id: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
};

