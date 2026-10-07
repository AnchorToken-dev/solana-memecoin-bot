/**
 * Scrub anything secret-looking from strings before they hit logs, /status,
 * /alerts, the journal, or HTTP error bodies.
 */
const registeredSecrets = new Set<string>();

/** Keypair loader registers encodings of the secret so they can never be echoed. */
export function registerSecretForRedaction(secret: string): void {
  registeredSecrets.add(secret);
}

const SECRET_ENV_KEYS = ["SOLANA_RPC_URL", "SOLANA_RPC_WSS_URL", "LIVE_WALLET_KEYPAIR_PATH"];

export function redactSecrets(input: unknown, env: Record<string, string | undefined> = process.env): string {
  let s = input instanceof Error ? input.message : typeof input === "string" ? input : safeJson(input);
  for (const k of SECRET_ENV_KEYS) {
    const v = env[k]?.trim();
    if (v && v.length >= 4) s = s.split(v).join(`[${k}]`);
  }
  // JSON byte arrays that look like a 64-byte Solana secret key.
  s = s.replace(/\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/g, "[REDACTED_BYTES]");
  // Exact secret encodings registered by the keypair loader (never stored elsewhere).
  for (const secret of registeredSecrets) {
    if (secret.length >= 16) s = s.split(secret).join("[REDACTED_KEY]");
  }
  // URLs: keep the host only, drop path/query (API keys often live there).
  s = s.replace(/\b(https?|wss?):\/\/([^/\s"'?#]+)[^\s"']*/gi, (_m, p, host) => `${p}://${String(host).replace(/^[^@]*@/, "")}/[redacted]`);
  s = s.replace(/(api[-_]?key|token|secret|private[-_]?key)(["'\s:=]+)[^\s"',}]+/gi, "$1$2[REDACTED]");
  return s;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
