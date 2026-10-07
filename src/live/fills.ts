/** Turn a confirmed transaction's balance changes into a real fill. */
import type { TxMeta } from "./rpc.js";

export interface OnChainDelta {
  /** Wallet SOL change in lamports (negative = spent), INCLUDING network + priority fee. */
  solDeltaLamports: number;
  /** Network + priority fee in lamports (meta.fee). */
  feeLamports: number;
  /** Token change in UI units (positive = received). */
  tokenDelta: number;
}

function uiAmount(b: { uiTokenAmount: { amount: string; decimals: number } }): number {
  return Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals;
}

export function computeOnChainDelta(
  meta: TxMeta,
  accountKeys: string[],
  wallet: string,
  mint: string,
): OnChainDelta {
  const idx = accountKeys.indexOf(wallet);
  if (idx < 0) throw new Error("wallet not in transaction accounts");
  const pre = meta.preBalances[idx];
  const post = meta.postBalances[idx];
  if (pre == null || post == null) throw new Error("missing SOL balances");
  const sum = (arr: TxMeta["preTokenBalances"]) =>
    (arr ?? []).filter((b) => b.mint === mint && b.owner === wallet).reduce((a, b) => a + uiAmount(b), 0);
  return {
    solDeltaLamports: post - pre,
    feeLamports: meta.fee,
    tokenDelta: sum(meta.postTokenBalances) - sum(meta.preTokenBalances),
  };
}

export const LAMPORTS_PER_SOL = 1_000_000_000;
