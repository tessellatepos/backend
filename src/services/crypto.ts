import {
    createCipheriv,
    createDecipheriv,
    randomBytes,
    timingSafeEqual,
} from "node:crypto";
import { configDotenv } from "dotenv";

configDotenv();

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const HEX_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * Reads TOKEN_ENCRYPTION_KEY, accepting either hex or base64 so operators
 * can paste whatever `openssl rand` gave them.
 * @returns the 32-byte AES key
 */
function getKey(): Buffer {
    const raw = process.env.TOKEN_ENCRYPTION_KEY;
    if (!raw) {
        throw new Error(
            "TOKEN_ENCRYPTION_KEY is not set — cannot encrypt or decrypt provider tokens",
        );
    }

    const key = HEX_KEY_PATTERN.test(raw)
        ? Buffer.from(raw, "hex")
        : Buffer.from(raw, "base64");

    if (key.length !== KEY_BYTES) {
        throw new Error(
            `TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`,
        );
    }

    return key;
}

/**
 * Encrypts a secret for storage at rest.
 * @param plaintext the secret to encrypt
 * @returns a `iv.authTag.ciphertext` string of base64 parts
 */
export function encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, getKey(), iv);
    const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
    ]);

    return [iv, cipher.getAuthTag(), ciphertext]
        .map((part) => part.toString("base64"))
        .join(".");
}

/**
 * Decrypts a value produced by {@link encrypt}.
 * @param ciphertext the stored `iv.authTag.ciphertext` string
 * @returns the original secret
 */
export function decrypt(ciphertext: string): string {
    const parts = ciphertext.split(".");
    if (parts.length !== 3) {
        throw new Error("Malformed ciphertext: expected iv.authTag.ciphertext");
    }

    const [iv, authTag, payload] = parts.map((part) =>
        Buffer.from(part, "base64"),
    );

    if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
        throw new Error("Malformed ciphertext: bad iv or auth tag length");
    }

    const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(payload), decipher.final()]).toString(
        "utf8",
    );
}

/**
 * Constant-time string comparison, for CSRF state and similar short secrets.
 * @param a first value
 * @param b second value
 * @returns true if the values are identical
 */
export function safeEqual(a: string, b: string): boolean {
    const bufferA = Buffer.from(a);
    const bufferB = Buffer.from(b);
    if (bufferA.length !== bufferB.length) {
        return false;
    }
    return timingSafeEqual(bufferA, bufferB);
}

/**
 * Generates a random URL-safe token, used for the OAuth CSRF state value.
 * @returns a random hex string
 */
export function randomToken(): string {
    return randomBytes(32).toString("hex");
}
