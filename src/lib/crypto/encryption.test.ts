import { createCipheriv, createHash, randomBytes } from "crypto";
import { describe, expect, it } from "vitest";
import {
  CIPHERTEXT_V2_PREFIX,
  decryptValue,
  encryptValue,
  hashValue,
  hashValueCandidates,
  legacyHashValue,
  needsReencryption,
  redactValue,
  tryDecryptValue,
} from "./encryption";

/** Independent re-implementation of the pre-v2 format (sha256(passphrase) key, iv:tag:data). */
function legacyEncrypt(plaintext: string): string {
  const key = createHash("sha256")
    .update(process.env.ENCRYPTION_KEY ?? "cleartrace-dev-key-change-in-production")
    .digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
}

describe("encryption", () => {
  it("round-trips encrypted values with the v2 prefix", () => {
    const original = "jane.doe@example.com";
    const encrypted = encryptValue(original);
    expect(encrypted.startsWith(CIPHERTEXT_V2_PREFIX)).toBe(true);
    expect(encrypted).not.toContain(original);
    expect(decryptValue(encrypted)).toBe(original);
    expect(needsReencryption(encrypted)).toBe(false);
  });

  it("still decrypts legacy unprefixed ciphertext", () => {
    const legacy = legacyEncrypt("Jane Q. Public");
    expect(legacy.startsWith(CIPHERTEXT_V2_PREFIX)).toBe(false);
    expect(decryptValue(legacy)).toBe("Jane Q. Public");
    expect(needsReencryption(legacy)).toBe(true);
  });

  it("v2 ciphertext is not decryptable with the legacy key (distinct derivation)", () => {
    const v2 = encryptValue("secret");
    expect(() => decryptValue(v2.slice(CIPHERTEXT_V2_PREFIX.length))).toThrow();
  });

  it("rejects tampered/malformed payloads; tryDecryptValue returns null", () => {
    const v2 = encryptValue("secret");
    const tampered = v2.slice(0, -4) + (v2.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(() => decryptValue(tampered)).toThrow();
    expect(() => decryptValue("garbage")).toThrow();
    expect(tryDecryptValue("garbage")).toBeNull();
    expect(tryDecryptValue(null)).toBeNull();
    expect(tryDecryptValue(v2)).toBe("secret");
  });

  it("produces stable, normalized keyed hashes that differ from unsalted sha256", () => {
    expect(hashValue("Test Value")).toBe(hashValue(" test value "));
    expect(hashValue("Test Value")).not.toBe(legacyHashValue("Test Value"));
    expect(legacyHashValue("test value")).toBe(
      createHash("sha256").update("test value").digest("hex"),
    );
    expect(hashValueCandidates("Test Value")).toEqual([
      hashValue("Test Value"),
      legacyHashValue("Test Value"),
    ]);
  });

  it("redacts values for display", () => {
    expect(redactValue("secret123")).toMatch(/•/);
  });
});
