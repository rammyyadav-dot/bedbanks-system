import { PrismaClient } from './db'
import { seed } from './seed'

export default async function globalSetup(): Promise<void> {
  const prisma = new PrismaClient({ datasourceUrl: process.env.E2E_DATABASE_URL })
  try { await seed(prisma) } finally { await prisma.$disconnect() }
}
