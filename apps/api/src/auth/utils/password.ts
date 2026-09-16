import * as bcrypt from 'bcryptjs';

const SALT_ROUNDS = 12;

/**
 * Isolated on purpose — see ../README.md for why bcryptjs was chosen
 * over Argon2id here. If that decision changes later, this is the
 * only file that needs to change.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, SALT_ROUNDS);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

/**
 * A valid cost-12 bcrypt hash used only for comparison on rejected
 * login paths. A match never authenticates a missing user. Used to run a real comparison even when no user was found,
 * so a nonexistent-email login takes roughly the same time as a
 * wrong-password one — otherwise response timing alone lets an
 * attacker enumerate which emails have accounts.
 */
export const DUMMY_HASH = '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxlSI9lUm.PcSvYNNFtvwsNgZsS';
