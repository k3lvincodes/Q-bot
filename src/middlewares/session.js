import { session } from 'telegraf';
import { Pool } from 'pg';
import logger from '../utils/logger.js';
import 'dotenv/config';

// Validate DATABASE_URL
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  logger.warn('DATABASE_URL not set, using in-memory sessions');
}

// Initialize PostgreSQL client if DATABASE_URL is set
const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: {
        rejectUnauthorized: false, // Railway uses self-signed certs
      },
    })
  : null;

// Retry mechanism for database operations
async function withRetry(operation, maxRetries = 3, delay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (err) {
      logger.error(`Retry ${i + 1}/${maxRetries} failed`, { error: err.message, stack: err.stack });
      if (i === maxRetries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay * (i + 1)));
    }
  }
}

// Test database connection
async function testConnection() {
  if (!pool) {
    logger.warn('No database pool, skipping connection test');
    return false;
  }
  try {
    const client = await pool.connect();
    const res = await client.query('SELECT NOW()');
    client.release();
    logger.info('Successfully connected to Railway PostgreSQL database', { timestamp: res.rows[0].now });
    return true;
  } catch (err) {
    logger.error('Database connection test failed', { error: err.message, stack: err.stack });
    return false;
  }
}

// Create sessions table if it doesn’t exist
async function initSessionTable() {
  if (!pool) {
    logger.warn('No database pool, skipping session table initialization');
    return;
  }
  try {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS sessions (
          id SERIAL PRIMARY KEY,
          session_key VARCHAR(255) UNIQUE NOT NULL,
          session_data JSONB NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE OR REPLACE FUNCTION update_timestamp()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = CURRENT_TIMESTAMP;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE OR REPLACE TRIGGER update_sessions_timestamp
        BEFORE UPDATE ON sessions
        FOR EACH ROW EXECUTE FUNCTION update_timestamp();
      `);
      logger.info('Session table initialized successfully');
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error('Failed to initialize session table', { error: err.message, stack: err.stack });
    throw err;
  }
}

// Initialize connection and session table
if (pool) {
  withRetry(async () => {
    const connected = await testConnection();
    if (connected) {
      await initSessionTable();
    } else {
      throw new Error('Database connection failed');
    }
  }).catch((err) => {
    logger.error('Initial connection and table initialization failed', { error: err.message });
  });
} else {
  logger.info('Starting with in-memory sessions due to missing DATABASE_URL');
}

// Session middleware with PostgreSQL store
const sessionMiddleware = session({
  store: pool
    ? {
        async get(key) {
          try {
            const { rows } = await pool.query(
              'SELECT session_data FROM sessions WHERE session_key = $1',
              [key]
            );
            logger.debug('Session retrieved', { key, data: rows[0]?.session_data });
            return rows[0]?.session_data;
          } catch (err) {
            logger.error('Session get error', { key, error: err.message, stack: err.stack });
            return undefined;
          }
        },
        async set(key, data) {
          try {
            await pool.query(
              'INSERT INTO sessions (session_key, session_data) VALUES ($1, $2) ON CONFLICT (session_key) DO UPDATE SET session_data = $2, updated_at = CURRENT_TIMESTAMP',
              [key, data]
            );
            logger.debug('Session set', { key, data });
          } catch (err) {
            logger.error('Session set error', { key, error: err.message, stack: err.stack });
          }
        },
        async delete(key) {
          try {
            await pool.query('DELETE FROM sessions WHERE session_key = $1', [key]);
            logger.debug('Session deleted', { key });
          } catch (err) {
            logger.error('Session delete error', { key, error: err.message, stack: err.stack });
          }
        },
      }
    : null,
  getSessionKey: (ctx) => {
    if (ctx.from && ctx.chat) {
      return `${ctx.from.id}:${ctx.chat.id}`;
    }
    return undefined;
  },
});

// Fallback to in-memory session
const inMemorySession = session();

export default function safeSession() {
  return async (ctx, next) => {
    try {
      if (pool) {
        // Test database connection
        await pool.query('SELECT 1');
        // Use PostgreSQL session store
        await sessionMiddleware(ctx, async () => {
          if (!ctx.session) {
            ctx.session = {};
            logger.info('Initialized empty session (PostgreSQL)', { telegramId: ctx.from?.id });
          }
          await next();
        });
      } else {
        // Use in-memory session
        await inMemorySession(ctx, async () => {
          if (!ctx.session) {
            ctx.session = {};
            logger.info('Initialized empty session (in-memory)', { telegramId: ctx.from?.id });
          }
          await next();
        });
      }
    } catch (err) {
      logger.error('Session middleware error, falling back to in-memory', { error: err.message, stack: err.stack });
      await inMemorySession(ctx, async () => {
        if (!ctx.session) {
          ctx.session = {};
          logger.info('Initialized empty session (in-memory)', { telegramId: ctx.from?.id });
        }
        await next();
      });
    }
  };
}