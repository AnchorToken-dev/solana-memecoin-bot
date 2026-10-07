/** Base58 (Bitcoin alphabet) for 32-byte Solana pubkeys. Encode only. */
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // All-zero input is only the leading-one prefix (no leftover zero digit).
  if (zeros === bytes.length) return "1".repeat(bytes.length);
  const digits: number[] = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) {
    out += ALPHABET[digits[i]!]!;
  }
  return out;
}

/** Base58 decode. Throws on invalid characters. */
export function base58Decode(s: string): Uint8Array {
  const map = new Map([..."123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"].map((c, i) => [c, i]));
  const bytes: number[] = [0];
  for (const ch of s) {
    const v = map.get(ch);
    if (v === undefined) throw new Error("invalid base58");
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const out = bytes.reverse();
  // strip the leading 0 placeholder when the number is non-zero
  while (out.length > 0 && out[0] === 0) out.shift();
  return Uint8Array.from([...new Array(zeros).fill(0), ...out]);
}
