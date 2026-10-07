/**
 * Local Solana CLI keypair loader (JSON array of 64 bytes).
 *
 * - Path comes ONLY from LIVE_WALLET_KEYPAIR_PATH.
 * - File contents are never logged, returned, or included in errors.
 * - Refuses group/world-readable files on Linux/macOS (chmod 600).
 * - The secret lives only inside a node:crypto KeyObject in this closure.
 */
import { createPrivateKey, createPublicKey, sign as edSign, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { base58Encode } from "../solana/base58.js";
import { registerSecretForRedaction } from "./redact.js";

export const LIVE_WALLET_KEYPAIR_PATH_ENV = "LIVE_WALLET_KEYPAIR_PATH";

export interface LiveSigner {
  /** Base58 public address. Safe to show. */
  readonly publicKey: string;
  readonly publicKeyBytes: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
}

export type KeypairLoadResult =
  | { ok: true; signer: LiveSigner }
  | { ok: false; error: string };

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Mode bits that make the file readable/writable by group or others. */
export function permsTooOpen(mode: number, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return false;
  return (mode & 0o077) !== 0;
}

export function loadLiveSigner(
  path: string | undefined = process.env[LIVE_WALLET_KEYPAIR_PATH_ENV],
  opts?: { platform?: NodeJS.Platform },
): KeypairLoadResult {
  const p = path?.trim();
  if (!p) return { ok: false, error: `${LIVE_WALLET_KEYPAIR_PATH_ENV} is not set` };
  let st;
  try {
    st = statSync(p);
  } catch {
    return { ok: false, error: "Wallet keypair file not found or not readable" };
  }
  if (!st.isFile()) return { ok: false, error: "Wallet keypair path is not a file" };
  if (permsTooOpen(st.mode, opts?.platform)) {
    return {
      ok: false,
      error: "Wallet keypair file is readable by other users. Run: chmod 600 <your keypair file>",
    };
  }
  let bytes: Uint8Array;
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      return { ok: false, error: "Wallet keypair file is not a Solana CLI keypair (expected 64 numbers)" };
    }
    bytes = Uint8Array.from(parsed as number[]);
  } catch {
    // Never surface parser messages: they can quote file contents.
    return { ok: false, error: "Wallet keypair file could not be parsed" };
  }
  const seed = bytes.slice(0, 32);
  const pubBytes = bytes.slice(32, 64);
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  } catch {
    return { ok: false, error: "Wallet keypair file could not be loaded" };
  }
  const derived = new Uint8Array(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32));
  if (Buffer.compare(Buffer.from(derived), Buffer.from(pubBytes)) !== 0) {
    return { ok: false, error: "Wallet keypair file is inconsistent (public key mismatch)" };
  }
  registerSecretForRedaction(base58Encode(bytes));
  registerSecretForRedaction(Buffer.from(bytes).toString("base64"));
  registerSecretForRedaction(Buffer.from(seed).toString("hex"));
  bytes.fill(0);
  seed.fill(0);
  const publicKey = base58Encode(derived);
  const signer: LiveSigner = {
    publicKey,
    publicKeyBytes: derived,
    sign(message: Uint8Array): Uint8Array {
      return new Uint8Array(edSign(null, message, key));
    },
  };
  // Make accidental JSON.stringify / console.log of the signer harmless.
  Object.defineProperty(signer, "toJSON", { value: () => ({ publicKey }), enumerable: false });
  return { ok: true, signer };
}
