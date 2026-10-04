import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const DEV_FALLBACK_KEY = "cleartrace-dev-key-change-in-production";

/** Prefix for ciphertext written with the HKDF-derived v2 key. */
export const CIPHERTEXT_V2_PREFIX = "v2:";

const HKDF_SALT = "cleartrace/kdf-salt/v1";
const V2_ENC_INFO = "cleartrace/aes-256-gcm/v2";
const HASH_INFO = "cleartrace/value-hash-hmac/v1";

function keySource(): string {
  return process.env.ENCRYPTION_KEY ?? DEV_FALLBACK_KEY;
}

const derivedCache = new Map<string, Buffer>();

function deriveKey(info: string): Buffer {
  const source = keySource();
  const cacheKey = `${info}\u0000${source}`;
  const cached = derivedCache.get(cacheKey);
  if (cached) return cached;
  const key = Buffer.from(hkdfSync("sha256", source, HKDF_SALT, info, 32));
  derivedCache.set(cacheKey, key);
  return key;
}

/** Legacy (v1) key: unsalted sha256 of the passphrase. Read-only — never used for new writes. */
function legacyEncryptionKey(): Buffer {
  return createHash("sha256").update(keySource()).digest();
}

function normalizeForHash(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Keyed lookup hash for PII (HMAC-SHA256 with a key derived from ENCRYPTION_KEY).
 * Not reversible or dictionary-attackable without the server secret.
 */
export function hashValue(value: string): string {
  return createHmac("sha256", deriveKey(HASH_INFO))
    .update(normalizeForHash(value))
    .digest("hex");
}

/** Legacy unsalted sha256 hash — only for matching rows written before HMAC hashing. */
export function legacyHashValue(value: string): string {
  return createHash("sha256").update(normalizeForHash(value)).digest("hex");
}

/**
 * All hashes a stored `value_hash` may hold for this value (current HMAC first, then legacy).
 * Use with `inArray(column, hashValueCandidates(v))` when looking rows up by hash.
 */
export function hashValueCandidates(value: string): string[] {
  return [hashValue(value), legacyHashValue(value)];
}

export function encryptValue(plaintext: string): string {
  const key = deriveKey(V2_ENC_INFO);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return (
    CIPHERTEXT_V2_PREFIX +
    [
      iv.toString("base64"),
      tag.toString("base64"),
      encrypted.toString("base64"),
    ].join(":")
  );
}

function decryptWithKey(key: Buffer, ivB64: string, tagB64: string, dataB64: string): string {
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/**
 * Decrypts v2 (`v2:iv:tag:data`, HKDF key) and legacy unprefixed (`iv:tag:data`, sha256 key)
 * ciphertext. Throws on malformed or tampered payloads.
 */
export function decryptValue(payload: string): string {
  if (payload.startsWith(CIPHERTEXT_V2_PREFIX)) {
    const [ivB64, tagB64, dataB64, extra] = payload
      .slice(CIPHERTEXT_V2_PREFIX.length)
      .split(":");
    if (!ivB64 || !tagB64 || !dataB64 || extra !== undefined) {
      throw new Error("Invalid encrypted payload");
    }
    return decryptWithKey(deriveKey(V2_ENC_INFO), ivB64, tagB64, dataB64);
  }
  const [ivB64, tagB64, dataB64, extra] = payload.split(":");
  if (!ivB64 || !tagB64 || !dataB64 || extra !== undefined) {
    throw new Error("Invalid encrypted payload");
  }
  return decryptWithKey(legacyEncryptionKey(), ivB64, tagB64, dataB64);
}

/** Like decryptValue but returns null instead of throwing (for list views: one bad row must not break the page). */
export function tryDecryptValue(payload: string | null | undefined): string | null {
  if (!payload) return null;
  try {
    return decryptValue(payload);
  } catch {
    return null;
  }
}

/** True when the payload is legacy ciphertext that should be re-encrypted with encryptValue(). */
export function needsReencryption(payload: string): boolean {
  return !payload.startsWith(CIPHERTEXT_V2_PREFIX);
}

export function redactValue(value: string): string {
  if (value.length <= 4) return "••••";
  return `${value.slice(0, 2)}${"•".repeat(Math.min(value.length - 4, 8))}${value.slice(-2)}`;
}
