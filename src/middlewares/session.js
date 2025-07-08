import { session } from 'telegraf';

export default function safeSession() {
  const sessionMiddleware = session();

  return async (ctx, next) => {
    // Apply Telegraf's built-in session middleware
    await sessionMiddleware(ctx, async () => {
      // Ensure ctx.session is always defined
      if (!ctx.session) {
        ctx.session = {};
      }
      await next();
    });
  };
}