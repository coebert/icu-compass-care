/**
 * Clinical data encryption core (server-only).
 *
 * Model (chosen by the unit):
 *  - Every clinical narrative field and every patient identifier is stored as
 *    AES-256-GCM ciphertext. The database never holds the readable value.
 *  - Identifiers additionally get a keyed hash (HMAC-SHA256) so records can be
 *    looked up and de-duplicated by exact match without storing plaintext and
 *    without the ciphertext being searchable.
 *  - The unit-wide data key lives only in the server key store
 *    (CLINICAL_ENC_KEY). A wrapped copy is escrowed under
 *    CLINICAL_RECOVERY_KEY so an administrator can recover clinical records if
 *    the primary key is ever lost — clinical records must never become
 *    permanently unreadable.
 *
 * Never import this module from browser code; it is server-only by filename.
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

const ENC_PREFIX = "enc:v1:";
const HASH_PREFIX = "h1:";

export class CryptoConfigError extends Error {}

function keyFromSecret(name: string): Buffer {
  const raw = process.env[name];
  if (!raw) {
    throw new CryptoConfigError(
      `${name} is not configured; clinical encryption cannot run without it.`,
    );
  }
  // The stored secret is a long random string; SHA-256 derives a 32-byte key.
  return createHash("sha256").update(raw, "utf8").digest();
}

function dataKey(): Buffer {
  return keyFromSecret("CLINICAL_ENC_KEY");
}
function hashKey(): Buffer {
  return keyFromSecret("CLINICAL_HASH_KEY");
}
function recoveryKey(): Buffer {
  return keyFromSecret("CLINICAL_RECOVERY_KEY");
}

function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ENC_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

function open(stored: string, key: Buffer): string {
  const buf = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

/** Encrypt one field value. null/undefined/'' stay empty so "no value" is not encrypted noise. */
export function encryptField(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  if (s === "") return null;
  if (isEncrypted(s)) return s; // already ciphertext — never double-wrap
  return seal(s, dataKey());
}

/**
 * Decrypt one field value. A value that is not ciphertext is returned as-is:
 * rows written before the migration remain readable until they are backfilled.
 * A ciphertext that fails to open throws — silently returning null would hide
 * clinical data loss.
 */
export function decryptField(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!isEncrypted(value)) return value;
  try {
    return open(value, dataKey());
  } catch {
    throw new Error("Stored clinical value could not be decrypted with the current key.");
  }
}

/** Same as decryptField but yields a placeholder instead of throwing (read-only views). */
export function decryptFieldSafe(value: string | null | undefined): string | null {
  try {
    return decryptField(value);
  } catch {
    return "[unreadable — encryption key mismatch]";
  }
}

/** Canonical form for keyed-hash lookup: case- and punctuation-insensitive. */
export function normaliseForHash(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Keyed hash (HMAC-SHA256) of an identifier — deterministic, so it supports
 * exact-match lookup and uniqueness, but not reversible and useless without
 * CLINICAL_HASH_KEY.
 */
export function hashIdentifier(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const canonical = normaliseForHash(String(value));
  if (!canonical) return null;
  return HASH_PREFIX + createHmac("sha256", hashKey()).update(canonical, "utf8").digest("hex");
}

/* ---------------------------------------------------------------------------
 * Key escrow — admin recovery copy of the data key.
 * ------------------------------------------------------------------------- */

export function wrapDataKeyForEscrow(): string {
  return seal(dataKey().toString("base64"), recoveryKey());
}

export function unwrapEscrowedDataKey(wrapped: string): Buffer {
  return Buffer.from(open(wrapped, recoveryKey()), "base64");
}

/** True when the escrowed copy still matches the live key (integrity check). */
export function escrowMatchesLiveKey(wrapped: string): boolean {
  try {
    return unwrapEscrowedDataKey(wrapped).equals(dataKey());
  } catch {
    return false;
  }
}

export function cryptoStatus(): {
  dataKey: boolean;
  hashKey: boolean;
  recoveryKey: boolean;
} {
  const has = (n: string) => Boolean(process.env[n]);
  return {
    dataKey: has("CLINICAL_ENC_KEY"),
    hashKey: has("CLINICAL_HASH_KEY"),
    recoveryKey: has("CLINICAL_RECOVERY_KEY"),
  };
}
