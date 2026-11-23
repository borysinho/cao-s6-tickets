import pg from 'pg';
try { process.loadEnvFile(new URL('../.env', import.meta.url)); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const target = new URL(process.env.DATABASE_URL ?? '');
if (target.pathname !== '/tickets_db' || decodeURIComponent(target.username) !== 'tickets_app') throw new Error('DATABASE_URL debe usar tickets_db y tickets_app.');
if (!process.env.PGADMIN_URL) throw new Error('Define PGADMIN_URL con una conexión administrativa local a PostgreSQL.');
const password = decodeURIComponent(target.password);
if (!password || password === 'REEMPLAZAR') throw new Error('Configura una contraseña propia en DATABASE_URL.');
const admin = new pg.Client({ connectionString: process.env.PGADMIN_URL });
await admin.connect();
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
try {
  const role = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'tickets_app'");
  if (!role.rowCount) await admin.query('CREATE ROLE tickets_app LOGIN PASSWORD ' + literal(password));
  const db = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'tickets_db'");
  if (!db.rowCount) await admin.query('CREATE DATABASE tickets_db OWNER tickets_app');
  await admin.query('REVOKE ALL ON DATABASE tickets_db FROM PUBLIC');
  await admin.query('GRANT CONNECT, TEMP ON DATABASE tickets_db TO tickets_app');
} finally { await admin.end(); }
const config = new URL(process.env.PGADMIN_URL);
config.pathname = '/tickets_db';
const database = new pg.Client({ connectionString: config.href });
await database.connect();
try {
  await database.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
  await database.query('GRANT USAGE, CREATE ON SCHEMA public TO tickets_app');
} finally { await database.end(); }
console.log('Base propia preparada. Ejecuta npm run migrate. Las credenciales existentes se conservan.');
