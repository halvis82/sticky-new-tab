// Applies schema.sql to the database in .env.local (vercel env pull writes it).
import fs from 'node:fs';
import pg from 'pg';

const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter(l => l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]),
);

const url = env.POSTGRES_URL_NON_POOLING.replace(/[?&]sslmode=[^&]*/, '');
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const { rows } = await client.query(
  "select count(*)::int as n from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'notes'");
console.log('schema applied, realtime on notes:', rows[0].n === 1);
await client.end();
