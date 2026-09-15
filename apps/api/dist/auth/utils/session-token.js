"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateSessionToken = generateSessionToken;
exports.hashSessionToken = hashSessionToken;
const crypto_1 = require("crypto");
const TOKEN_BYTES = 32;
function generateSessionToken() {
    return (0, crypto_1.randomBytes)(TOKEN_BYTES).toString('hex');
}
function hashSessionToken(rawToken) {
    return (0, crypto_1.createHash)('sha256').update(rawToken).digest('hex');
}
//# sourceMappingURL=session-token.js.map