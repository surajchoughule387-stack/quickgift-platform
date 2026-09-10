// PostgreSQL connection pool.
// All queries go through this single pool — never open ad-hoc connections
// elsewhere, so pooling/limits stay centrally controlled.
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'quickgift',
  max: 20,
  idleTimeoutMillis: 30000
});

pool.on('error', (err) => {
  // A background/idle client crashed — log, don't crash the whole process.
  console.error('Unexpected error on idle PostgreSQL client', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(), // for multi-statement transactions
  pool
};
