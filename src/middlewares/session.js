import { session } from 'telegraf';

export default (ctx, next) => {
  if (ctx.update && ctx.update.update_id) {
    return session()(ctx, next);
  }
  return next();
};