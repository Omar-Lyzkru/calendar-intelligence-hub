import { PrismaClient, Prisma } from "@prisma/client";
export const db = new PrismaClient();
export const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
