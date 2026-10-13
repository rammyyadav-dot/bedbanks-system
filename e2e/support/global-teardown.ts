import { PrismaClient } from './db'
import { teardown } from './seed'

export default async function globalTeardown(): Promise<void> {
  const prisma = new PrismaClient({ datasourceUrl: process.env.E2E_DATABASE_URL })
  try { await teardown(prisma) } finally { await prisma.$disconnect() }
}
