import { session } from 'telegraf';
import { Pool } from 'pg';
import logger from '../utils/logger.js';
import 'dotenv/config';

// Check if we're in a serverless environment
const isVercel = process.env.VERCEL === '1';
const isProduction = process.env.NODE_ENV === 'production' || isVercel;

let pool = null;

// Initialize PostgreSQL only if DATABASE_URL is available and we want persistent sessions
if (process.env.DATABASE_URL && isProduction) {
  try {
    const connectionOptions = {
      connectionString: process.env.DATABASE_URL,
      ssl: isVercel ? { rejectUnauthorized: false } : false,
      // Serverless-optimized settings
      max: 5, // Reduced connection limit for serverless
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };

    pool = new Pool(connectionOptions);

    // Test connection
    pool.query('SELECT NOW()')
      .then(result => {
        logger.info('✅ Database session store connected successfully');
      })
      .catch(err => {
        logger.error('❌ Database session store connection failed, falling back to memory', {
          error: err.message
        });
        pool = null;
      });

  } catch (error) {
    logger.error('Failed to initialize database pool', { error: error.message });
    pool = null;
  }
} else {
  logger.info('Using in-memory session store (no DATABASE_URL or not production)');
}

// Simple in-memory session store for fallback
const memoryStore = new Map();

// Session middleware with PostgreSQL store
const sessionMiddleware = session({
  store: pool
    ? {
        async get(key) {
          try {
            const client = await pool.connect();
            try {
              const { rows } = await client.query(
                'SELECT session_data FROM sessions WHERE session_key = $1',
                [key]
              );
              return rows[0]?.session_data || null;
            } finally {
              client.release();
            }
          } catch (err) {
            logger.error('Session get error', { key, error: err.message, stack: err.stack });
            return null;
          }
        },
        async set(key, data) {
          try {
            const client = await pool.connect();
            try {
              await client.query(
                `INSERT INTO sessions (session_key, session_data) 
             VALUES ($1, $2) 
             ON CONFLICT (session_key) 
             DO UPDATE SET session_data = $2, updated_at = CURRENT_TIMESTAMP`,
                [key, data]
              );
            } finally {
              client.release();
            }
          } catch (err) {
            logger.error('Session set error', { key, error: err.message, stack: err.stack });
          }
        },
        async delete(key) {
          try {
            const client = await pool.connect();
            try {
              await client.query('DELETE FROM sessions WHERE session_key = $1', [key]);
            } finally {
              client.release();
            }
          } catch (err) {
            logger.error('Session delete error', { key, error: err.message, stack: err.stack });
          }
        },
      }
    : {
        // In-memory store fallback
        async get(key) {
          return memoryStore.get(key) || null;
        },
        async set(key, data) {
          memoryStore.set(key, data);
        },
        async delete(key) {
          memoryStore.delete(key);
        },
      },

  getSessionKey: (ctx) => {
    if (ctx.from && ctx.chat) {
      return `${ctx.from.id}:${ctx.chat.id}`;
    }
    if (ctx.from) {
      return `${ctx.from.id}`;
    }
    return undefined;
  },
});

// Initialize session table if using database
if (pool) {
  (async () => {
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
          
          CREATE INDEX IF NOT EXISTS sessions_key_idx ON sessions(session_key);
          CREATE INDEX IF NOT EXISTS sessions_updated_at_idx ON sessions(updated_at);
        `);
        logger.info('Session table initialized');
      } finally {
        client.release();
      }
    } catch (err) {
      logger.error('Failed to initialize session table', { error: err.message });
      pool = null;
    }
  })();
}

export default function safeSession() {
  return async (ctx, next) => {
    try {
      await sessionMiddleware(ctx, next);
    } catch (err) {
      logger.error('Session middleware error, using memory fallback', {
        error: err.message
      });

      // Fallback to basic session
      if (!ctx.session) {
        ctx.session = {};
      }
      await next();
    }
  };
}