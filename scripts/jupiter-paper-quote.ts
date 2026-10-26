/**
 * Compare a Jupiter paper fill with the old pump.fun curve model.
 *
 *   npx tsx scripts/jupiter-paper-quote.ts
 *   SAMPLE_MINT=<mint> npx tsx scripts/jupiter-paper-quote.ts
 *
 * Never signs or sends. If Jupiter is unreachable, prints the offline fallback
 * and exits 0.
 */
import { PAPER_FEE_DEFAULTS, computeBuyCosts } from "../src/broker/paperFees.js";
import { loadPaperExecutionSettings, priceJupiterBuy } from "../src/broker/jupiterFill.js";
import { fetchJupiterSwapQuote, SOL_MINT } from "../src/broker/jupiterQuote.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NOTIONAL = 15;
const MARK = 0.0001;
const SOL = Number(process.env.SOL_USD_RATE ?? process.env.PAPER_SOL_USD_FALLBACK ?? 150);

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

async function main(): Promise<void> {
  const exec = loadPaperExecutionSettings(process.env);
  const curve = computeBuyCosts(PAPER_FEE_DEFAULTS, {
    notionalUsd: NOTIONAL,
    markPrice: MARK,
    solUsd: SOL,
    venue: "bonding_curve",
    flatSlippageBps: 50,
  });
  const offline = priceJupiterBuy(PAPER_FEE_DEFAULTS, {
    notionalUsd: NOTIONAL,
    markPrice: MARK,
    solUsd: SOL,
    flatSlippageBps: 50,
    fallbackFeeBps: exec.jupiter.fallbackFeeBps,
    fallbackReason: "offline comparison (no quote yet)",
  });
  console.log(`SOL/USD ${SOL}  notional ${usd(NOTIONAL)}  mark ${MARK}`);
  console.log(
    `curve buy:    source=curve venueFee=${curve.breakdown.venueFeeBps}bps ` +
      `pumpPortal=${usd(curve.breakdown.pumpPortalFeeUsd)} fees=${usd(curve.breakdown.totalFeesUsd)} ` +
      `slippage=${curve.breakdown.slippageBps}bps`,
  );
  console.log(
    `jupiter offline: source=${offline.breakdown.fillSource} route=${offline.breakdown.route} ` +
      `jupiterFee=${offline.breakdown.jupiterFeeBps}bps ammFee=${offline.breakdown.venueFeeBps}bps ` +
      `pumpPortal=${usd(offline.breakdown.pumpPortalFeeUsd)} fees=${usd(offline.breakdown.totalFeesUsd)} ` +
      `slippage=${offline.breakdown.slippageBps}bps`,
  );
  if (!(offline.breakdown.totalFeesUsd < curve.breakdown.totalFeesUsd)) {
    console.error("offline Jupiter fees were not below the curve model");
    process.exitCode = 1;
    return;
  }

  const mint = (process.env.SAMPLE_MINT ?? USDC).trim();
  // Fixed 0.1 SOL in. For USDC, the quote itself implies SOL/USD (USDC ≈ $1),
  // so the fee comparison does not depend on PAPER_SOL_USD_FALLBACK.
  const probeLamports = process.env.SAMPLE_LAMPORTS?.trim() || "100000000";
  console.log(`quoting ${mint} via Jupiter /build (${probeLamports} base units, timeout ${exec.jupiter.timeoutMs}ms)…`);
  const live = await fetchJupiterSwapQuote({
    inputMint: SOL_MINT,
    outputMint: mint,
    amountRaw: probeLamports,
    slippageBps: exec.jupiter.slippageBps,
    timeoutMs: exec.jupiter.timeoutMs,
    ...(exec.jupiter.taker ? { taker: exec.jupiter.taker } : {}),
  });
  if (live.kind !== "ok") {
    console.log(`Jupiter ${live.kind}: ${live.reason}`);
    console.log("paper would keep trading on the offline fallback above");
    return;
  }
  const solIn = Number(live.quote.inAmountRaw) / 1e9;
  const outRaw = Number(live.quote.outAmountRaw);
  const usdcOut = mint === USDC ? outRaw / 1e6 : null;
  const solUsd = usdcOut != null && solIn > 0 ? usdcOut / solIn : SOL;
  const mark = mint === USDC ? 1 : MARK;
  const notional = solIn > 0 ? solIn * solUsd : NOTIONAL;
  const priced = priceJupiterBuy(PAPER_FEE_DEFAULTS, {
    notionalUsd: notional,
    markPrice: mark,
    solUsd,
    flatSlippageBps: 50,
    fallbackFeeBps: exec.jupiter.fallbackFeeBps,
    quote: live.quote,
    tokenDecimals: mint === USDC ? 6 : exec.jupiter.tokenDecimals,
  });
  const curveAtQuote = computeBuyCosts(PAPER_FEE_DEFAULTS, {
    notionalUsd: notional,
    markPrice: mark,
    solUsd,
    venue: "bonding_curve",
    flatSlippageBps: 50,
  });
  console.log(
    `jupiter quote: source=${priced.breakdown.fillSource} route=${priced.breakdown.route} ` +
      `jupiterFee=${priced.breakdown.jupiterFeeBps}bps ammFee=${priced.breakdown.venueFeeBps}bps ` +
      `slippage=${priced.breakdown.slippageBps}bps fees=${usd(priced.breakdown.totalFeesUsd)} ` +
      `qty=${priced.qty} solUsd=${solUsd.toFixed(2)}`,
  );
  console.log(
    `same size on the curve model: fees=${usd(curveAtQuote.breakdown.totalFeesUsd)} ` +
      `venueFee=${curveAtQuote.breakdown.venueFeeBps}bps pumpPortal=${usd(curveAtQuote.breakdown.pumpPortalFeeUsd)}`,
  );
  const delta = priced.breakdown.totalFeesUsd - curveAtQuote.breakdown.totalFeesUsd;
  console.log(
    `fee delta vs curve model: ${usd(delta)} ` +
      `(negative means this Jupiter quote is cheaper than pump 1.25% + PumpPortal 0.5%)`,
  );
  if (!(priced.breakdown.jupiterFeeBps === 0) || !(priced.breakdown.totalFeesUsd < curveAtQuote.breakdown.totalFeesUsd)) {
    console.error("expected a zero Jupiter fee and a cheaper fill than the curve model");
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`jupiter-paper-quote failed: ${msg}`);
  process.exitCode = 1;
});
