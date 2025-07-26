import { session } from 'telegraf';

export default function safeSession() {
  const sessionMiddleware = session();

  return async (ctx, next) => {
    await sessionMiddleware(ctx, async () => {
      if (!ctx.session) {
        ctx.session = {};
      }
      await next();
    });
  };
}