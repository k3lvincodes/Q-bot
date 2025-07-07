import { session } from 'telegraf';

export default function safeSession() {
  return async (ctx, next) => {
    if (!ctx || !ctx.update) return next();
    return session()(ctx, next);
  };
}

// export default function safeSession() {
//   const sessionMiddleware = session();
//   return async (ctx, next) => {
//     if (ctx.update && ctx.update.update_id) {
//       return sessionMiddleware(ctx, next);
//     }
//     return next();
//   };
// }