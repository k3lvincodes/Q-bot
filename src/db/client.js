import { PrismaClient } from '@prisma/client';

let prismaInstance = null;

export const getPrisma = () => {
  if (!prismaInstance) {
    prismaInstance = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    });

    // Handle clean shutdown
    process.on('beforeExit', async () => {
      await prismaInstance.$disconnect();
    });

    process.on('SIGINT', async () => {
      await prismaInstance.$disconnect();
      process.exit(0);
    });
  }
  return prismaInstance;
};