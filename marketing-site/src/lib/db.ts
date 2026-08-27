import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import {
  pgSchema,
  uuid,
  text,
  timestamp,
  index
} from 'drizzle-orm/pg-core';

// Everything for this landing page lives in its own `landing` schema — the
// `public` schema is intentionally left empty (LINA-34).
export const landing = pgSchema('landing');

// Waitlist signups — source of truth for the {verified}/150 count.
// email_norm is unique so dedupe is enforced at the database.
export const signups = landing.table(
  'signups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull(), // as entered
    emailNorm: text('email_norm').notNull().unique(), // dedupe key
    role: text('role'), // stable enum key (see ROLE_KEYS in WaitlistForm), not a display label
    locale: text('locale').notNull().default('pt'),
    source: text('source').notNull().default('organic'), // utm_source / referring host / 'direct'
    referrer: text('referrer'), // raw document.referrer captured on submit
    status: text('status').notNull().default('unconfirmed'), // unconfirmed | confirmed
    confirmToken: text('confirm_token'), // random, single-use
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true })
  },
  (t) => [
    index('signups_status_idx').on(t.status),
    index('signups_locale_idx').on(t.locale),
    index('signups_source_idx').on(t.source),
    index('signups_token_idx').on(t.confirmToken)
  ]
);

export type Db = ReturnType<typeof drizzle>;

// Lazy so a missing DATABASE_URL never breaks the build — only the API routes,
// which check `isDbConfigured()` first, ever touch the connection.
let _db: Db | null = null;

export function isDbConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

export function getDb(): Db {
  if (!isDbConfigured()) {
    throw new Error('DATABASE_URL is not set');
  }
  if (!_db) {
    const sql = neon(process.env.DATABASE_URL!);
    _db = drizzle(sql);
  }
  return _db;
}
