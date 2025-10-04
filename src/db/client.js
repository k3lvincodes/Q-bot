import { PrismaClient } from '@prisma/client';

let prismaInstance = null;

export const getPrisma = () => {
  if (!prismaInstance) {
    prismaInstance = new PrismaClient();
  }
  return prismaInstance;
};