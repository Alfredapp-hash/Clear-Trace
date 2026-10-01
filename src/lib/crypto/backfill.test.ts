import fs from "fs";
import os from "os";
import path from "path";
import { createCipheriv, createHash, randomBytes } from "crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backfillLegacyCrypto } from "./backfill";
import { CIPHERTEXT_V2_PREFIX, decryptValue, encryptValue, hashValue, legacyHashValue } from "./encryption";

/** Independent re-implementation of the pre-v2 format (sha256(passphrase) key, iv:tag:data). */
function legacyEncrypt(plaintext: string, passphrase = process.env.ENCRYPTION_KEY!): string {
  const key = createHash("sha256").update(passphrase).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
}

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cleartrace-backfill-"));
  db = new Database(path.join(dir, "t.db"));
  db.exec(`
    CREATE TABLE identity_claims (id TEXT PRIMARY KEY, encrypted_value TEXT NOT NULL, value_hash TEXT NOT NULL);
    CREATE TABLE connector_configs (id TEXT PRIMARY KEY, encrypted_credentials TEXT NOT NULL);
    CREATE TABLE enterprise_webhooks (id TEXT PRIMARY KEY, encrypted_secret TEXT NOT NULL);
  `);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const claim = (id: string) =>
  db.prepare("SELECT encrypted_value AS ct, value_hash AS h FROM identity_claims WHERE id = ?").get(id) as {
    ct: string;
    h: string;
  };
const one = (table: string, column: string, id: string) =>
  (db.prepare(`SELECT ${column} AS ct FROM ${table} WHERE id = ?`).get(id) as { ct: string }).ct;

describe("backfillLegacyCrypto", () => {
  it("re-encrypts legacy ciphertext to v2, rehashes claims, and is a no-op on a second run", () => {
    const insClaim = db.prepare("INSERT INTO identity_claims VALUES (?, ?, ?)");
    // legacy ciphertext + legacy hash
    insClaim.run("c1", legacyEncrypt("Jane Doe"), legacyHashValue("Jane Doe"));
    // v2 ciphertext but legacy hash
    insClaim.run("c2", encryptValue("jane@example.com"), legacyHashValue("jane@example.com"));
    // already current
    const currentCt = encryptValue("Portland");
    insClaim.run("c3", currentCt, hashValue("Portland"));
    // undecryptable (encrypted under a different key)
    const foreign = legacyEncrypt("Secret", "some-other-key");
    insClaim.run("c4", foreign, "deadbeef");

    const creds = JSON.stringify({ apiKey: "re_test_123" });
    db.prepare("INSERT INTO connector_configs VALUES (?, ?)").run("k1", legacyEncrypt(creds));
    db.prepare("INSERT INTO enterprise_webhooks VALUES (?, ?)").run("w1", legacyEncrypt("whsec"));
    db.prepare("INSERT INTO enterprise_webhooks VALUES (?, ?)").run("w2", "garbage");

    const first = backfillLegacyCrypto(db, { batchSize: 2 });
    expect(first.reencrypted).toBe(3); // c1, k1, w1
    expect(first.rehashed).toBe(2); // c1, c2
    expect(first.failed).toBe(2); // c4, w2

    const c1 = claim("c1");
    expect(c1.ct.startsWith(CIPHERTEXT_V2_PREFIX)).toBe(true);
    expect(decryptValue(c1.ct)).toBe("Jane Doe");
    expect(c1.h).toBe(hashValue("Jane Doe"));

    expect(claim("c2").h).toBe(hashValue("jane@example.com"));
    expect(claim("c3")).toEqual({ ct: currentCt, h: hashValue("Portland") });
    expect(claim("c4")).toEqual({ ct: foreign, h: "deadbeef" });

    const k1 = one("connector_configs", "encrypted_credentials", "k1");
    expect(k1.startsWith(CIPHERTEXT_V2_PREFIX)).toBe(true);
    expect(decryptValue(k1)).toBe(creds);
    expect(decryptValue(one("enterprise_webhooks", "encrypted_secret", "w1"))).toBe("whsec");
    expect(one("enterprise_webhooks", "encrypted_secret", "w2")).toBe("garbage");

    const snapshot = db.prepare("SELECT * FROM identity_claims ORDER BY id").all();
    const second = backfillLegacyCrypto(db, { batchSize: 2 });
    expect(second.reencrypted).toBe(0);
    expect(second.rehashed).toBe(0);
    expect(second.failed).toBe(2); // still-undecryptable rows are counted, not rewritten
    expect(db.prepare("SELECT * FROM identity_claims ORDER BY id").all()).toEqual(snapshot);
  });

  it("tolerates missing tables and empty databases", () => {
    const empty = new Database(":memory:");
    expect(backfillLegacyCrypto(empty)).toMatchObject({ reencrypted: 0, rehashed: 0, failed: 0 });
    empty.close();
    expect(backfillLegacyCrypto(db)).toMatchObject({ reencrypted: 0, rehashed: 0, failed: 0 });
  });
});
