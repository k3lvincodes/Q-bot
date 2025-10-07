import { session } from 'telegraf';
import logger from '../utils/logger.js';

// Simple in-memory session store for fallback
const memoryStore = new Map();

// Session middleware with PostgreSQL store
const sessionMiddleware = session({
  store: {
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

export default function safeSession() {
  return async (ctx, next) => {
    try {
      await sessionMiddleware(ctx, next);
    } catch (err) {
      logger.error('Session middleware error', { 
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