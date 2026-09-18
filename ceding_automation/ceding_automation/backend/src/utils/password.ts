// backend/src/utils/password.ts
//
// Password hashing + verification + temp-password generation for phase 1
// local login. Kept in one file so any future rotation of algorithm or
// parameters happens in one place.
//
// Algorithm: bcrypt via bcryptjs (pure-JS implementation, no native
// binding — Alpine-safe with no compile step). bcryptjs was already in
// package.json as a phantom dep before phase 1 shipped; using it avoids
// adding a native-binding hashing library and adopts what the project
// already committed to.
//
// Argon2id would be materially stronger against GPU/ASIC attackers. If a
// future incident makes that hardening desirable, migrate by (a) adding
// `@node-rs/argon2` (napi-rs prebuilt, no compile), (b) verifying against
// EITHER algorithm here, (c) re-hashing on next successful login for users
// whose hash is still bcrypt. That upgrade path is one file's worth of
// change; the callers in routes/auth.ts and routes/users.ts stay unchanged.
//
// Cost factor 12 → ~250ms/hash on a modern CPU. Slow enough to make an
// offline brute force expensive; fast enough that a legitimate login
// round-trip stays interactive. Do not lower without documenting why.

import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";

const BCRYPT_COST = 12;

// Temp-password alphabet omits characters that are easily confused when a
// CA reads a password out over the phone: 0/O, 1/l/I. 16 characters at
// this alphabet size gives ~91 bits of entropy — well above what bcrypt
// needs to be safe against offline attack on the resulting hash for the
// ~24h window before the user rotates via mustChangePassword.
const TEMP_ALPHABET =
  "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const TEMP_LENGTH = 16;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(
  hash: string,
  plain: string,
): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    // A malformed hash (corruption, algorithm-string prefix we don't
    // recognise after a future migration) fails closed rather than throws.
    return false;
  }
}

export function generateTemporaryPassword(): string {
  // Rejection sampling against a power-of-two mask would be marginally
  // better; the modulo bias at 54 chars is ~1.6% and irrelevant for a
  // human-readable temp password meant to be rotated on first sign-in.
  const bytes = randomBytes(TEMP_LENGTH);
  let out = "";
  for (let i = 0; i < TEMP_LENGTH; i++) {
    out += TEMP_ALPHABET[bytes[i] % TEMP_ALPHABET.length];
  }
  return out;
}

// Basic strength check for a user-chosen new password on
// POST /auth/change-password. Deliberately minimal — 12 char minimum, no
// forced complexity classes (which push users to predictable substitutions
// per NIST SP 800-63B). A password manager output or a diceware phrase of
// three words easily clears 12 chars.
export function isPasswordAcceptable(candidate: string): {
  ok: boolean;
  reason?: string;
} {
  if (typeof candidate !== "string") {
    return { ok: false, reason: "Password must be a string" };
  }
  if (candidate.length < 12) {
    return { ok: false, reason: "Password must be at least 12 characters" };
  }
  if (candidate.length > 128) {
    // bcrypt truncates plaintext at 72 bytes silently — 128 char cap on
    // input keeps the interface honest with users who paste from a
    // password manager without realising the truncation, and rejects
    // absurdly long input before hashing.
    return { ok: false, reason: "Password must be at most 128 characters" };
  }
  return { ok: true };
}
