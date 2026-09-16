"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DUMMY_HASH = void 0;
exports.hashPassword = hashPassword;
exports.verifyPassword = verifyPassword;
const bcrypt = require("bcryptjs");
const SALT_ROUNDS = 12;
async function hashPassword(plaintext) {
    return bcrypt.hash(plaintext, SALT_ROUNDS);
}
async function verifyPassword(plaintext, hash) {
    return bcrypt.compare(plaintext, hash);
}
exports.DUMMY_HASH = '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinval';
//# sourceMappingURL=password.js.map