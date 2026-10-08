/**
 * Solana program-derived addresses, dependency-free (sha256 + an ed25519
 * "is this on the curve" check). Same algorithm as
 * PublicKey.findProgramAddressSync in @solana/web3.js.
 */
import { createHash } from "node:crypto";
import { base58Decode, base58Encode } from "./base58.js";

const P = 2n ** 255n - 19n;

function modPow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

const D = (((-121665n % P) + P) % P) * modPow(121666n, P - 2n, P) % P;

/**
 * True when the 32 bytes decompress to an ed25519 point (curve25519-dalek
 * CompressedEdwardsY::decompress semantics, which is what Solana uses):
 * valid iff (y² − 1) / (d·y² + 1) is a square mod p.
 */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]!);
  y &= (1n << 255n) - 1n;
  y %= P;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const w = (u * modPow(v, P - 2n, P)) % P;
  if (w === 0n) return true;
  return modPow(w, (P - 1n) / 2n, P) === 1n;
}

export function toBytes32(pubkey: string): Uint8Array {
  const b = base58Decode(pubkey);
  if (b.length !== 32) throw new Error("not a 32-byte public key");
  return b;
}

/** Highest-bump off-curve address for seeds under programId. */
export function findProgramAddress(seeds: Uint8Array[], programId: string): { address: string; bump: number } {
  const prog = toBytes32(programId);
  for (const s of seeds) if (s.length > 32) throw new Error("seed longer than 32 bytes");
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump));
    h.update(prog);
    h.update(Buffer.from("ProgramDerivedAddress"));
    const out = new Uint8Array(h.digest());
    if (!isOnCurve(out)) return { address: base58Encode(out), bump };
  }
  throw new Error("no viable bump seed");
}
