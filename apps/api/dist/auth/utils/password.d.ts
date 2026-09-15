export declare function hashPassword(plaintext: string): Promise<string>;
export declare function verifyPassword(plaintext: string, hash: string): Promise<boolean>;
export declare const DUMMY_HASH = "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinval";
