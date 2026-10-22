import { Module } from '@nestjs/common'
import { SupplierIngestModule } from '../supplier-ingest/supplier-ingest.module'
import { SupplierPromotionDatabase } from './supplier-promotion.database'
import { SupplierPromotionService } from './supplier-promotion.service'

/**
 * Supplier promotion (ADR 0084). The service exists and is tested, but no worker, route or schedule calls it: promotion runs only when something invokes `SupplierPromotionService.promote`,
 * on its own database role, which refuses to connect unless `SUPPLIER_PROMOTION_DATABASE_URL` is configured and differs from `DATABASE_URL`.
 */
@Module({ imports: [SupplierIngestModule], providers: [SupplierPromotionDatabase, SupplierPromotionService], exports: [SupplierPromotionService] })
export class SupplierPromotionModule {}
