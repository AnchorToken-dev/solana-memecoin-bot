/**
 * Solana mint (contract address) check for the single-coin pin.
 * A mint is a base58-encoded 32-byte public key. No wallet code here.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map<string, number>(
  [...ALPHABET].map((ch, i) => [ch, i]),
);

/** Decode base58. Returns null if any character is outside the alphabet. */
export function decodeBase58(input: string): Uint8Array | null {
  if (input.length === 0) return null;
  const bytes: number[] = [0];
  for (const ch of input) {
    const val = INDEX.get(ch);
    if (val === undefined) return null;
    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeros = 0;
  for (const ch of input) {
    if (ch !== "1") break;
    leadingZeros += 1;
  }
  const out = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[out.length - 1 - i] = bytes[i]!;
  }
  return out;
}

/** True when `mint` is a Solana address (base58, exactly 32 bytes). */
export function isSolanaMint(mint: string): boolean {
  if (mint.length < 32 || mint.length > 44) return false;
  const raw = decodeBase58(mint);
  return raw != null && raw.length === 32;
}

const JUNK_MESSAGE =
  "That doesn't look like a Solana coin address. Paste the contract address (mint) only — about 32–44 letters and numbers. No extra words.";

export type MintParse =
  | { ok: true; mint: string }
  | { ok: false; message: string };

/**
 * Accept a bare mint, or a pump.fun / DexScreener link whose last path
 * segment is a mint. Reject everything else with a plain error.
 */
export function parseSolanaMintInput(raw: unknown): MintParse {
  if (typeof raw !== "string") {
    return { ok: false, message: JUNK_MESSAGE };
  }
  const text = raw.trim();
  if (!text) {
    return {
      ok: false,
      message: "Paste a Solana contract address first.",
    };
  }

  let candidate = text;
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      const parts = url.pathname.split("/").filter(Boolean);
      const last = parts[parts.length - 1];
      if (!last) return { ok: false, message: JUNK_MESSAGE };
      candidate = decodeURIComponent(last);
    } catch {
      return { ok: false, message: JUNK_MESSAGE };
    }
  }

  candidate = candidate.trim();
  if (!isSolanaMint(candidate)) {
    return { ok: false, message: JUNK_MESSAGE };
  }
  return { ok: true, mint: candidate };
}
