import { PrismaClient } from '@prisma/client';

let prismaInstance = null;

export const getPrisma = () => {
  if (!prismaInstance) {
    prismaInstance = new PrismaClient({
      log: ['error'],
      datasources: {
        db: {
          url: process.env.DATABASE_URL,
        },
      },
    });

    // Add connection error handling
    prismaInstance.$connect().catch((error) => {
      console.error('Failed to connect to database:', error.message);
    });
  }
  return prismaInstance;
};

// Handle clean shutdown
process.on('beforeExit', async () => {
  if (prismaInstance) {
    await prismaInstance.$disconnect();
  }
});