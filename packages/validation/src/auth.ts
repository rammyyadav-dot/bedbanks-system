import { z } from 'zod'
import type { LoginRequest, PasswordResetConfirm, PasswordResetRequest } from '@bedbanks/types'

const email = z.string().trim().email().max(254)
const password = z.string().min(1).max(1024)
const resetToken = z.string().regex(/^[a-f0-9]{64}$/, 'Expected a 64-character hex reset token')

export const loginRequestSchema = z.object({
  email,
  password,
  rememberMe: z.boolean().optional(),
}).strict()

export const passwordResetRequestSchema = z.object({
  email,
}).strict()

export const passwordResetConfirmSchema = z.object({
  token: resetToken,
  newPassword: password,
}).strict()

type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
const loginParity: Exact<z.infer<typeof loginRequestSchema>, LoginRequest> = true
const resetRequestParity: Exact<z.infer<typeof passwordResetRequestSchema>, PasswordResetRequest> = true
const resetConfirmParity: Exact<z.infer<typeof passwordResetConfirmSchema>, PasswordResetConfirm> = true
void loginParity
void resetRequestParity
void resetConfirmParity
