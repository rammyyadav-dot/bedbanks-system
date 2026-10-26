import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { CreditNoteController } from './credit-note.controller'
import { CreditNoteService } from './credit-note.service'

/** Partial credit notes to agencies (ADR 0095 part B). */
@Module({ imports: [AuthModule], controllers: [CreditNoteController], providers: [CreditNoteService] })
export class FinanceCreditNotesModule {}
