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
 * A syntactically valid bcrypt hash that no real password will ever
 * match. Used to run a real comparison even when no user was found,
 * so a nonexistent-email login takes roughly the same time as a
 * wrong-password one — otherwise response timing alone lets an
 * attacker enumerate which emails have accounts.
 */
export const DUMMY_HASH = '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinval';
