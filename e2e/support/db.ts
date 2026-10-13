import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

/**
 * The same generated Prisma client as the API (the `@prisma/client` instance with the API's TypeScript peer), so the journeys can never run against a
 * differently generated copy. Used only to arrange fixtures and to observe results; every action under test goes through the browser.
 */
export { PrismaClient, bcrypt }
