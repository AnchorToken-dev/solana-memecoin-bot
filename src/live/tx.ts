/**
 * Minimal Solana transaction wire-format helpers (legacy + v0), dependency-free.
 * We only need: find the message bytes, check the fee payer / signer set,
 * and drop our ed25519 signature into slot 0.
 */
import { base58Encode } from "../solana/base58.js";
import type { LiveSigner } from "./keypair.js";

function readShortVec(buf: Uint8Array, offset: number): { value: number; size: number } {
  let value = 0;
  let size = 0;
  for (;;) {
    if (offset + size >= buf.length) throw new Error("tx: truncated shortvec");
    const b = buf[offset + size]!;
    value |= (b & 0x7f) << (7 * size);
    size += 1;
    if ((b & 0x80) === 0) break;
    if (size > 3) throw new Error("tx: bad shortvec");
  }
  return { value, size };
}

export interface ParsedTx {
  numSignatures: number;
  messageOffset: number;
  message: Uint8Array;
  numRequiredSignatures: number;
  feePayer: string;
}

export function parseTransaction(tx: Uint8Array): ParsedTx {
  const sigs = readShortVec(tx, 0);
  const messageOffset = sigs.size + sigs.value * 64;
  if (messageOffset >= tx.length) throw new Error("tx: truncated");
  const message = tx.subarray(messageOffset);
  let o = 0;
  if ((message[0]! & 0x80) !== 0) {
    const version = message[0]! & 0x7f;
    if (version !== 0) throw new Error(`tx: unsupported version ${version}`);
    o = 1;
  }
  const numRequiredSignatures = message[o]!;
  o += 3;
  const keys = readShortVec(message, o);
  o += keys.size;
  if (keys.value < 1 || o + 32 > message.length) throw new Error("tx: no account keys");
  const feePayer = base58Encode(message.subarray(o, o + 32));
  return { numSignatures: sigs.value, messageOffset, message, numRequiredSignatures, feePayer };
}

/**
 * Verify the tx is ours alone (fee payer == wallet, exactly one signer) and sign it.
 * Returns a new buffer; input is not mutated.
 */
export function signTransaction(tx: Uint8Array, signer: LiveSigner): Uint8Array {
  const p = parseTransaction(tx);
  if (p.feePayer !== signer.publicKey) throw new Error("tx: fee payer is not the bot wallet — refusing to sign");
  if (p.numRequiredSignatures !== 1 || p.numSignatures !== 1) {
    throw new Error("tx: unexpected extra signers — refusing to sign");
  }
  const out = new Uint8Array(tx);
  const sig = signer.sign(p.message);
  out.set(sig, readShortVec(tx, 0).size);
  return out;
}

/** First signature of a signed tx (base58) = transaction id. */
export function txSignature(tx: Uint8Array): string {
  const s = readShortVec(tx, 0);
  return base58Encode(tx.subarray(s.size, s.size + 64));
}

/**
 * Outer program id of each instruction (for decoding "InstructionError[i]").
 * Program ids are always static keys, even in v0 txs. null on malformed input.
 */
export function instructionProgramIds(tx: Uint8Array): (string | null)[] | null {
  try {
    const p = parseTransaction(tx);
    const m = p.message;
    let o = (m[0]! & 0x80) !== 0 ? 1 : 0;
    o += 3;
    const nKeys = readShortVec(m, o);
    o += nKeys.size;
    const keysStart = o;
    o += nKeys.value * 32 + 32; // keys + recent blockhash
    const nIx = readShortVec(m, o);
    o += nIx.size;
    const out: (string | null)[] = [];
    for (let i = 0; i < nIx.value; i++) {
      if (o >= m.length) return null;
      const pi = m[o]!;
      o += 1;
      const na = readShortVec(m, o);
      o += na.size + na.value;
      const nd = readShortVec(m, o);
      o += nd.size + nd.value;
      if (o > m.length) return null;
      out.push(pi < nKeys.value ? base58Encode(m.subarray(keysStart + pi * 32, keysStart + pi * 32 + 32)) : null);
    }
    return out;
  } catch {
    return null;
  }
}
