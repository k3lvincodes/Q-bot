import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function test() {
  try {
    const client = await pool.connect();
    const res = await client.query('SELECT NOW()');
    console.log('Connection successful:', res.rows);
    client.release();
  } catch (err) {
    console.error('Connection failed:', err.message, err.stack);
  }
}

test();