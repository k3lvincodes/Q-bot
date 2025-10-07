import { session } from 'telegraf';
import logger from '../utils/logger.js';

// Simple in-memory session store (no database dependencies)
const memoryStore = new Map();

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
  return sessionMiddleware;
}