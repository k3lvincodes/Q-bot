import { CronJob } from 'cron';
import { getPrisma } from '../db/client.js';
import logger from './logger.js';

export function startCronJobs() {
  new CronJob('0 0 * * *', async () => {
    try {
      const now = new Date();
      const prisma = getPrisma();
      const expiredRequests = await prisma.leaveRequest.findMany({
        where: {
          status: 'pending',
          expiresAt: { lte: now },
        },
      });

      for (const req of expiredRequests) {
        try {
          const sub = await prisma.subscription.findUnique({ where: { subId: req.subId } });
          if (!sub) {
            logger.warn('Subscription not found for leave request', { subId: req.subId });
            continue;
          }
          const user = await prisma.users.findUnique({ where: { userId: req.userId } });
          if (!user) {
            logger.warn('User not found for leave request', { userId: req.userId });
            continue;
          }
          await prisma.subscription.update({
            where: { subId: req.subId },
            data: {
              crew: sub.crew.filter((email) => email !== user.email),
              subRemSlot: { increment: 1 },
            },
          });
          await prisma.leaveRequest.update({
            where: { id: req.id },
            data: { status: 'completed' },
          });
          logger.info('Processed leave request', { leaveRequestId: req.id, subId: req.subId });
        } catch (err) {
          logger.error(`Failed to process leave request ${req.id}`, { error: err.message, stack: err.stack });
        }
      }
    } catch (err) {
      logger.error('Error in cron job', { error: err.message, stack: err.stack });
    }
  }, null, true, 'UTC').start();
  logger.info('Cron job started');
}