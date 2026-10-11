import { Global, Module } from '@nestjs/common';
import { TenantControlDatabase } from '../platform-admin/tenant-control.database';
import { PrismaService } from './prisma.service';

/**
 * @Global so PrismaService is injectable anywhere without every future
 * feature module needing to import DatabaseModule explicitly. There's
 * only one database connection for the whole app — that's a reasonable
 * thing to make globally available, unlike business logic modules.
 */
@Global()
@Module({
  providers: [PrismaService, TenantControlDatabase],
  exports: [PrismaService, TenantControlDatabase],
})
export class DatabaseModule {}
