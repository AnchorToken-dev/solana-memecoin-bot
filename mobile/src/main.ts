import "./styles.css";
import { api, ApiError } from "./api";
import { DEFAULT_API_BASE, getApiBaseUrl, setApiBaseUrl } from "./settings";
import {
  getSessionAlertsEnabled,
  setSessionAlertsEnabled,
  pollSessionAlerts,
  onStartRequestAlerts,
  ensureAlertPermission,
} from "./alerts";
import { journalChartsHtml, mountJournalCharts } from "./journalCharts";

type Tab = "status" | "control" | "bankroll" | "checklist" | "journal" | "settings";

const app = document.querySelector("#app")!;
let tab: Tab = "status";
let message = "";
let error = "";
let busy = false;
/** Draft CA so an 8s refresh does not wipe a paste in progress. */
let pinDraft = "";

function money(n: unknown): string {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return "—";
  return `$${x.toFixed(2)}`;
}

/**
 * Display the API win percentage. Missing / null (zero decided closes) is an em dash,
 * not 0%, so an empty journal is not a fake stat. Does not recompute from counts.
 */
function formatWinPct(winPct: number | null | undefined): string {
  if (typeof winPct !== "number" || !Number.isFinite(winPct)) return "—";
  const rounded = Math.round(winPct * 10) / 10;
  const body = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${body}%`;
}

/** Format quote-asset amount (SOL etc.) with ticker label. */
function quoteAmt(n: unknown, asset = "SOL"): string {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return "—";
  const abs = Math.abs(x);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  return `${x.toFixed(digits)} ${asset}`;
}

function dualPnl(usd: number, quote: number | null | undefined, asset: string): string {
  const u = money(usd);
  if (quote == null || !Number.isFinite(quote)) return u;
  return `${u} · ${quoteAmt(quote, asset)}`;
}

function fmtTs(n: unknown): string {
  if (typeof n !== "number" || !n) return "—";
  return new Date(n).toLocaleString();
}

/** Humanize ms age (cycleAgeMs / remainingMs). */
function fmtDuration(ms: unknown): string {
  const n = typeof ms === "number" ? ms : Number(ms);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return `${Math.round(n)}ms`;
  const s = n / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

async function withBusy(fn: () => Promise<void>) {
  busy = true;
  error = "";
  message = "";
  render();
  try {
    await fn();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    busy = false;
    render();
  }
}

async function render() {
  const base = await getApiBaseUrl();
  app.innerHTML = `
    <header>
      <h1>Memecoin Paper Bot</h1>
      <p>Phone = control UI · engine stays on your laptop</p>
      <span class="badge">PAPER ONLY · no wallet keys in app</span>
    </header>
    <main id="main"></main>
    <nav class="tabs">
      ${(["status","control","bankroll","checklist","journal","settings"] as Tab[]).map((t) =>
        `<button data-tab="${t}" class="${tab===t?"active":""}">${label(t)}</button>`
      ).join("")}
    </nav>
  `;
  app.querySelectorAll("button[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      tab = (btn as HTMLButtonElement).dataset.tab as Tab;
      void render();
    });
  });

  const main = app.querySelector("#main")!;
  if (error) main.insertAdjacentHTML("beforeend", `<div class="err">${escapeHtml(error)}</div>`);
  if (message) main.insertAdjacentHTML("beforeend", `<div class="ok">${escapeHtml(message)}</div>`);

  if (tab === "settings") {
    main.insertAdjacentHTML("beforeend", `<div class="card"><p class="muted">Loading settings…</p></div>`);
    try {
      await paintSettings(main, base);
    } catch (e) {
      error = e instanceof ApiError || e instanceof Error ? e.message : String(e);
      main.innerHTML = `
        <div class="err">${escapeHtml(error)}</div>
        <div class="card">
          <h2>API base URL</h2>
          <label for="apiUrl">Set the control API so bot settings can load</label>
          <input id="apiUrl" type="url" value="${escapeAttr(base)}" placeholder="${DEFAULT_API_BASE}" />
          <div class="actions">
            <button class="primary" id="saveUrl">Save URL</button>
            <button class="secondary" id="retry">Retry</button>
          </div>
          <p class="muted" style="margin-top:12px">
            USB / emulator: <code>adb reverse tcp:8787 tcp:8787</code> →
            <code>http://127.0.0.1:8787</code>. Laptop: <code>npm run api</code>.
          </p>
        </div>`;
      main.querySelector("#saveUrl")?.addEventListener("click", () => {
        const v = (main.querySelector("#apiUrl") as HTMLInputElement).value;
        void withBusy(async () => {
          await setApiBaseUrl(v);
          message = "Saved API URL";
        });
      });
      main.querySelector("#retry")?.addEventListener("click", () => void render());
    }
    return;
  }

  // Live data tabs
  main.insertAdjacentHTML("beforeend", `<div class="card"><p class="muted">Loading…</p></div>`);
  try {
    if (tab === "status") await paintStatus(main);
    else if (tab === "control") await paintControl(main);
    else if (tab === "bankroll") await paintBankroll(main);
    else if (tab === "checklist") await paintChecklist(main);
    else if (tab === "journal") await paintJournal(main);
  } catch (e) {
    error = e instanceof ApiError || e instanceof Error ? e.message : String(e);
    main.innerHTML = `<div class="err">${escapeHtml(error)}</div>
      <div class="card"><p class="muted">API: ${escapeHtml(base)}</p>
      <div class="actions"><button class="secondary" id="retry">Retry</button>
      <button class="secondary" id="toSettings">Settings</button></div></div>`;
    main.querySelector("#retry")?.addEventListener("click", () => void render());
    main.querySelector("#toSettings")?.addEventListener("click", () => {
      tab = "settings";
      void render();
    });
  }
}

function label(t: Tab): string {
  return ({ status: "Status", control: "Run", bankroll: "PnL", checklist: "Check", journal: "Journal", settings: "Settings" })[t];
}

async function paintStatus(main: Element) {
  const [health, status, cfgWrap] = await Promise.all([
    api.health(),
    api.status(),
    api.config(),
  ]);
  const cfg = cfgWrap.config ?? {};
  const tp =
    typeof cfg.takeProfitPct === "number" ? cfg.takeProfitPct : null;
  const trail = cfg.trailingTakeProfit as
    | { activatePct?: number; distancePct?: number }
    | undefined;
  const lock = readChaseLockout(status);
  const cycleAgeMs =
    typeof status.cycleAgeMs === "number" && Number.isFinite(status.cycleAgeMs)
      ? status.cycleAgeMs
      : null;
  const runningNow = status.state === "running";
  // Poll + market timeout budget; far beyond that ⇒ tick likely wedged.
  const stall = runningNow && cycleAgeMs != null && cycleAgeMs > 45_000;
  main.innerHTML = `
    ${chaseLockoutBanner(lock)}
    <div class="card">
      <h2>Engine status</h2>
      <div class="row"><span class="k">Health</span><span class="v">${health.ok ? "ok" : "bad"}</span></div>
      <div class="row"><span class="k">Paper mode</span><span class="v">${String(health.paperMode)}</span></div>
      <div class="row"><span class="k">State</span><span class="v">${escapeHtml(String(status.state))}</span></div>
      <div class="row"><span class="k">Cycle</span><span class="v">${escapeHtml(String(status.cycle ?? 0))}</span></div>
      <div class="row"><span class="k">Source</span><span class="v">${escapeHtml(String(status.marketDataSource ?? "—"))}</span></div>
      <div class="row"><span class="k">Solana RPC</span><span class="v">${status.solanaRpcConfigured === true ? "configured (read-only)" : "not configured"}</span></div>
      <div class="row"><span class="k">Rug filter</span><span class="v">${cfg.rugFilterEnabled === true ? "on" : "off"}</span></div>
      ${pinStatusBlock(status)}
      <div class="row"><span class="k">Take-profit</span><span class="v">${tp == null ? "—" : tp <= 0 ? "off" : `+${tp}%`}</span></div>
      <div class="row"><span class="k">Trail</span><span class="v">${
        trail?.activatePct != null && trail?.distancePct != null
          ? `+${trail.activatePct}% / ${trail.distancePct}%`
          : "—"
      }</span></div>
      <div class="row"><span class="k">Started</span><span class="v">${fmtTs(status.startedAt)}</span></div>
      <div class="row"><span class="k">Last cycle</span><span class="v">${fmtTs(status.lastCycleAt)}</span></div>
      <div class="row"><span class="k">Cycle age</span><span class="v ${stall ? "warn-text" : ""}">${
        cycleAgeMs == null ? "—" : fmtDuration(cycleAgeMs)
      }</span></div>
      <div class="row"><span class="k">Last error</span><span class="v">${escapeHtml(String(status.lastError ?? "—"))}</span></div>
      ${
        stall
          ? `<p class="stall-warn">Tick looks stalled (cycle age ${fmtDuration(cycleAgeMs)}). Prefer Stop then Start if exits are not firing — hung market HTTP should self-recover within ~8s after recent fixes.</p>`
          : ""
      }
      <div class="actions">
        <button class="secondary" id="refresh" ${busy?"disabled":""}>Refresh</button>
      </div>
    </div>`;
  main.querySelector("#refresh")?.addEventListener("click", () => void render());
}

async function paintControl(main: Element) {
  const [status, portfolioWrap, cfgWrap] = await Promise.all([
    api.status(),
    api.portfolio(),
    api.config(),
  ]);
  const running = status.state === "running" || status.state === "starting";
  const stopReason =
    typeof status.stopReason === "string" && status.stopReason
      ? status.stopReason
      : null;
  const openCount = portfolioWrap.portfolio.openPositions?.length ?? 0;
  const cfg = cfgWrap.config ?? {};
  const tp =
    typeof cfg.takeProfitPct === "number" ? cfg.takeProfitPct : null;
  const lock = readChaseLockout(status);
  const locked = !!(lock && lock.active);
  main.innerHTML = `
    ${chaseLockoutBanner(lock)}
    <div class="card">
      <h2>Paper runner</h2>
      <p class="muted">Start/stop only works while the server has PAPER_MODE=true. Live trading is stubbed — this app never holds keys.</p>
      <div class="row"><span class="k">State</span><span class="v">${escapeHtml(String(status.state))}</span></div>
      <div class="row"><span class="k">Open positions</span><span class="v">${openCount}</span></div>
      <div class="row"><span class="k">Take-profit</span><span class="v">${tp == null ? "—" : tp <= 0 ? "off (env TAKE_PROFIT_PCT)" : `+${tp}% (env TAKE_PROFIT_PCT)`}</span></div>
      ${
        stopReason
          ? `<div class="row"><span class="k">Stop reason</span><span class="v warn-text">${escapeHtml(stopReason)}</span></div>
             <p class="muted">Daily-loss lock clears with <strong>Reset</strong> on the PnL tab. <strong>Chase lockout</strong> (full original deposit lost) does <em>not</em> — timer only on the laptop/API.</p>`
          : ""
      }
      <div class="actions">
        <button class="primary" id="start" ${busy||running||locked?"disabled":""}>Start paper bot</button>
        <button class="danger" id="stop" ${busy||!running?"disabled":""}>Stop</button>
        <button class="secondary" id="refresh">Refresh</button>
      </div>
      <p class="muted" style="margin-top:10px"><strong>Exit now</strong> / <strong>Reset</strong> live on the <strong>PnL</strong> tab (near equity / open position). Change take-profit via server env <code>TAKE_PROFIT_PCT</code> (default 25; 0 = off).</p>
    </div>
    ${pinCard(status)}`;
  main.querySelector("#start")?.addEventListener("click", () => {
    void withBusy(async () => {
      await onStartRequestAlerts();
      const r = await api.start();
      message = r.message;
    });
  });
  main.querySelector("#stop")?.addEventListener("click", () => {
    void withBusy(async () => {
      const r = await api.stop();
      message = r.message;
    });
  });
  main.querySelector("#refresh")?.addEventListener("click", () => void render());
  const pinInput = main.querySelector("#pinMint") as HTMLInputElement | null;
  pinInput?.addEventListener("input", () => {
    pinDraft = pinInput.value;
  });
  main.querySelector("#pinWatch")?.addEventListener("click", () => {
    const mint = (main.querySelector("#pinMint") as HTMLInputElement).value;
    pinDraft = mint;
    void withBusy(async () => {
      const r = await api.setTarget(mint);
      message = r.message;
      if (r.ok) pinDraft = "";
    });
  });
  main.querySelector("#pinClear")?.addEventListener("click", () => {
    void withBusy(async () => {
      const r = await api.clearTarget();
      message = r.message;
      pinDraft = "";
    });
  });
}

function pinnedMintOf(status: Record<string, unknown>): string {
  return typeof status.pinnedMint === "string" ? status.pinnedMint.trim() : "";
}

function pinStatusBlock(status: Record<string, unknown>): string {
  const mint = pinnedMintOf(status);
  const symbol = typeof status.pinnedSymbol === "string" ? status.pinnedSymbol.trim() : "";
  if (!mint) {
    return `<div class="pin-status">
      <div class="pinned-label">Hunting the board</div>
      <p class="pin-lead">No coin pinned.</p>
    </div>`;
  }
  return `<div class="pin-status">
    <div class="pinned-label">Watching this coin</div>
    ${symbol ? `<div class="pinned-symbol">${escapeHtml(symbol)}</div>` : ""}
    <div class="pinned-mint">${escapeHtml(mint)}</div>
  </div>`;
}

function pinCard(status: Record<string, unknown>): string {
  const mint = pinnedMintOf(status);
  const symbol = typeof status.pinnedSymbol === "string" ? status.pinnedSymbol.trim() : "";
  const banner = error
    ? `<p class="pin-error">${escapeHtml(error)}</p>`
    : message
      ? `<p class="pin-ok">${escapeHtml(message)}</p>`
      : "";
  return `<div class="card pin-card">
    <h2>Watch one coin</h2>
    <p class="pin-lead">Paste a Solana contract address. The bot works that coin only. Clear the box to hunt the board again.</p>
    ${banner}
    <div class="pinned-label">${mint ? "Watching this coin" : "Hunting the board"}</div>
    ${symbol ? `<div class="pinned-symbol">${escapeHtml(symbol)}</div>` : ""}
    ${
      mint
        ? `<div class="pinned-mint">${escapeHtml(mint)}</div>`
        : `<p class="pin-lead">No coin pinned. The bot keeps its normal hunt.</p>`
    }
    <label class="pin-label" for="pinMint">Contract address</label>
    <input id="pinMint" class="pin-input" type="text" inputmode="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste the mint / CA" value="${escapeAttr(pinDraft)}" />
    <div class="actions">
      <button class="primary pin-action" id="pinWatch" ${busy ? "disabled" : ""}>Watch this coin</button>
      <button class="secondary pin-action" id="pinClear" ${busy || !mint ? "disabled" : ""}>Clear and hunt</button>
    </div>
    <p class="pin-lead">Risk limits still apply: bankroll, max position, daily loss, vault, chase lockout, and exits. If another coin is already open, that trade finishes on its own — it is not closed just because you pin a new address. A buy still waits for the momentum rules.</p>
  </div>`;
}

async function paintBankroll(main: Element) {
  const [data, status] = await Promise.all([api.portfolio(), api.status()]);
  const p = data.portfolio;
  const positions = p.openPositions ?? [];
  const hasOpen = positions.length > 0;
  const vaultUsd = typeof p.vaultUsd === "number" ? p.vaultUsd : (data.vaultUsd ?? 0);
  const tradable = typeof p.tradableCashUsd === "number" ? p.tradableCashUsd : p.cashUsd;
  const totalEq = typeof p.totalEquityUsd === "number" ? p.totalEquityUsd : p.equityUsd + vaultUsd;
  const stopReason =
    typeof status.stopReason === "string" && status.stopReason
      ? status.stopReason
      : null;
  const lock = readChaseLockout(status) ?? readChaseLockout(data as unknown as Record<string, unknown>);
  main.innerHTML = `
    ${chaseLockoutBanner(lock)}
    <div class="card">
      <h2>Bankroll / PnL</h2>
      <div class="row"><span class="k">Configured bankroll</span><span class="v" data-k="bankroll">${money(data.bankrollUsd)}</span></div>
      <div class="row"><span class="k">Tradable cash</span><span class="v" data-k="cash">${money(tradable)}</span></div>
      <div class="row"><span class="k">Vault (skimmed)</span><span class="v" data-k="vault">${money(vaultUsd)}</span></div>
      <div class="row"><span class="k">Trading equity</span><span class="v" data-k="equity">${money(p.equityUsd)}</span></div>
      <div class="row"><span class="k">Total (equity+vault)</span><span class="v" data-k="totalEq">${money(totalEq)}</span></div>
      <div class="row"><span class="k">Realized PnL</span><span class="v" data-k="realized">${money(p.realizedPnlUsd)}</span></div>
      <div class="row"><span class="k">Unrealized PnL</span><span class="v" data-k="unrealized">${money(p.unrealizedPnlUsd)}</span></div>
      <div class="row"><span class="k">Trades</span><span class="v" data-k="trades">${escapeHtml(String(p.tradeCount))}</span></div>
      ${
        stopReason
          ? `<div class="row"><span class="k">Stop reason</span><span class="v warn-text" data-k="stopReason">${escapeHtml(stopReason)}</span></div>
             <p class="muted">Use <strong>Reset</strong> to clear the ledger / daily-loss lock. Chase lockout (full deposit wipe) stays until unlock-at — Reset will not clear it.</p>`
          : `<div class="row hidden" id="stopReasonRow"><span class="k">Stop reason</span><span class="v" data-k="stopReason">—</span></div>`
      }
      <div class="actions">
        <button class="danger" id="exitNow" ${busy||!hasOpen?"disabled":""}>Exit now</button>
        <button class="secondary" id="reset" ${busy?"disabled":""}>Reset</button>
        <button class="secondary" id="refresh">Refresh</button>
      </div>
      <p class="muted" style="margin-top:10px">Exit now flattens the open paper position at the current mark (<code>manual_exit</code>). Reset restores <code>BANKROLL_USD</code> cash and clears daily-loss <code>stopReason</code> — <strong>vault</strong> and <strong>chase lockout</strong> survive Reset. Start/Stop stay on the Run tab. Sizing uses <strong>tradable cash only</strong> (never vault). Loss vs <strong>original deposit</strong> (configured bankroll), not growing equity.</p>
    </div>
    <div class="card">
      <h2>Vault / skim</h2>
      <p class="muted">Lock paper profit away so the bot cannot all-in vaulted funds. <strong>Skim %</strong> takes % of cash above the configured bankroll floor.</p>
      <div class="field-grid">
        <label>Skim $ USD<input id="skimAmt" type="number" step="0.01" min="0.01" value="25" /></label>
        <label>Skim % of profit<input id="skimPct" type="number" step="1" min="1" max="100" value="50" /></label>
        <label>Return $ from vault<input id="returnAmt" type="number" step="0.01" min="0.01" value="${escapeAttr(String(vaultUsd > 0 ? Math.min(vaultUsd, 25) : 10))}" /></label>
      </div>
      <div class="actions">
        <button class="primary" id="skimUsdBtn" ${busy?"disabled":""}>Skim $</button>
        <button class="secondary" id="skimPctBtn" ${busy?"disabled":""}>Skim %</button>
        <button class="secondary" id="returnVaultBtn" ${busy||vaultUsd<=0?"disabled":""}>Return</button>
      </div>
    </div>
    <div class="card">
      <h2>Open positions (${positions.length})</h2>
      ${
        positions.length === 0
          ? `<p class="muted">Flat — no open paper positions.</p>`
          : positions.map((pos) => renderOpenPosition(pos)).join("")
      }
    </div>`;
  main.querySelector("#refresh")?.addEventListener("click", () => void render());
  main.querySelector("#reset")?.addEventListener("click", () => {
    const ok = window.confirm(
      "Reset paper session?\n\nThis stops the runner (if running), clears trades, and restores cash to BANKROLL_USD. The daily-loss lock is cleared.\n\nVault (skimmed) is KEPT.\nChase lockout (if active after full deposit loss) is NOT cleared — wait for unlock-at.",
    );
    if (!ok) return;
    void withBusy(async () => {
      const r = await api.reset();
      message = r.message;
    });
  });
  main.querySelector("#exitNow")?.addEventListener("click", () => {
    const ok = window.confirm(
      "Exit now?\n\nFlatten the open paper position at the current mark (manual_exit). The runner keeps running if it was started.",
    );
    if (!ok) return;
    void withBusy(async () => {
      const r = await api.exitNow();
      message = r.message;
    });
  });
  main.querySelector("#skimUsdBtn")?.addEventListener("click", () => {
    const amountUsd = Number((main.querySelector("#skimAmt") as HTMLInputElement).value);
    void withBusy(async () => {
      const r = await api.vaultSkim({ amountUsd });
      message = r.message;
    });
  });
  main.querySelector("#skimPctBtn")?.addEventListener("click", () => {
    const percentOfProfit = Number((main.querySelector("#skimPct") as HTMLInputElement).value);
    void withBusy(async () => {
      const r = await api.vaultSkim({ percentOfProfit });
      message = r.message;
    });
  });
  main.querySelector("#returnVaultBtn")?.addEventListener("click", () => {
    const amountUsd = Number((main.querySelector("#returnAmt") as HTMLInputElement).value);
    void withBusy(async () => {
      const r = await api.vaultReturn(amountUsd);
      message = r.message;
    });
  });
}

/**
 * Live chart for an open mint.
 * Pump.fun sets X-Frame-Options: SAMEORIGIN / CSP frame-ancestors 'self', so it
 * cannot be iframed in the Capacitor WebView — use DexScreener embed + external Pump.fun link.
 * See docs/pnl-chart.md.
 */
function renderOpenPosition(pos: {
  mint: string;
  symbol: string;
  qty: number;
  entryPrice: number;
  trailArmed?: boolean;
}): string {
  const mint = String(pos.mint ?? "");
  const symbol = String(pos.symbol ?? "?");
  const qty =
    typeof pos.qty === "number" && Number.isFinite(pos.qty)
      ? pos.qty.toFixed(4)
      : String(pos.qty);
  const pumpUrl = `https://pump.fun/coin/${encodeURIComponent(mint)}`;
  // Official DexScreener embed (no X-Frame-Options block observed; works in WebView).
  const dexEmbed = `https://dexscreener.com/solana/${encodeURIComponent(mint)}?embed=1&theme=dark&trades=0&info=0`;
  return `
    <div class="position-block">
      <div class="trade">
        <strong>${escapeHtml(symbol)}</strong>
        · qty ${escapeHtml(qty)}
        · entry ${escapeHtml(String(pos.entryPrice))}
        · trail ${pos.trailArmed ? "armed" : "off"}
      </div>
      <div class="row"><span class="k">Mint</span><span class="v mint">${escapeHtml(mint)}</span></div>
      <div class="chart-wrap">
        <iframe
          class="chart-frame"
          data-mint="${escapeAttr(mint)}"
          src="${escapeAttr(dexEmbed)}"
          title="DexScreener chart ${escapeAttr(symbol)}"
          loading="lazy"
          referrerpolicy="no-referrer-when-downgrade"
          allow="clipboard-write; fullscreen"
        ></iframe>
      </div>
      <p class="muted chart-note">
        Embedded: <strong>DexScreener</strong> (Pump.fun blocks iframes).
        <a href="${escapeAttr(pumpUrl)}" target="_blank" rel="noopener noreferrer">Open on Pump.fun</a>
        ·
        <a href="${escapeAttr(`https://dexscreener.com/solana/${encodeURIComponent(mint)}`)}" target="_blank" rel="noopener noreferrer">Open DexScreener</a>
      </p>
    </div>`;
}


type CheckStatusUI = "pass" | "fail" | "skip" | "unset";

function localVerdict(
  items: Array<{ required: boolean; status: CheckStatusUI }>,
  thesis: string,
  invalidation: string,
): "GO" | "NO-GO" | "INCOMPLETE" {
  if (!thesis.trim() || !invalidation.trim()) return "INCOMPLETE";
  let fail = false;
  let incomplete = false;
  for (const it of items) {
    if (it.status === "fail") {
      fail = true;
      continue;
    }
    if (it.required) {
      if (it.status !== "pass") incomplete = true;
    } else if (it.status === "unset") {
      incomplete = true;
    }
  }
  if (fail) return "NO-GO";
  if (incomplete) return "INCOMPLETE";
  return "GO";
}

async function paintChecklist(main: Element) {
  const [tpl, recent, portfolio] = await Promise.all([
    api.checklistTemplate(),
    api.checklist(15, 0),
    api.portfolio().catch(() => null),
  ]);
  const openMint = portfolio?.portfolio?.openPositions?.[0]?.mint ?? "";
  const openSym = portfolio?.portfolio?.openPositions?.[0]?.symbol ?? "";
  const items = tpl.items.map((i) => ({ ...i, status: i.status as CheckStatusUI }));

  const renderForm = () => {
    const verdict = localVerdict(
      items,
      (main.querySelector("#clThesis") as HTMLTextAreaElement | null)?.value ?? "",
      (main.querySelector("#clInv") as HTMLTextAreaElement | null)?.value ?? "",
    );
    const verdictClass =
      verdict === "GO" ? "verdict-go" : verdict === "NO-GO" ? "verdict-nogo" : "verdict-incomplete";
    const mintVal = (main.querySelector("#clMint") as HTMLInputElement | null)?.value ?? openMint;
    const symVal = (main.querySelector("#clSymbol") as HTMLInputElement | null)?.value ?? openSym;
    const linkVal = (main.querySelector("#clLink") as HTMLInputElement | null)?.value ?? "";
    const thesisVal = (main.querySelector("#clThesis") as HTMLTextAreaElement | null)?.value ?? "";
    const invVal = (main.querySelector("#clInv") as HTMLTextAreaElement | null)?.value ?? "";

    const itemRows = items
      .map((it, idx) => {
        const opt = it.required ? "" : ` <span class="muted">(optional)</span>`;
        return `<div class="check-row" data-idx="${idx}">
          <div class="check-label">${escapeHtml(it.label)}${opt}</div>
          <div class="check-btns" role="group">
            ${(["pass", "fail", "skip"] as const)
              .map(
                (s) =>
                  `<button type="button" class="check-btn ${it.status === s ? "active-" + s : ""}" data-idx="${idx}" data-status="${s}">${
                    s === "pass" ? "Pass" : s === "fail" ? "Fail" : "Skip"
                  }</button>`,
              )
              .join("")}
          </div>
        </div>`;
      })
      .join("");

    const recentHtml =
      (recent.entries ?? []).length === 0
        ? `<p class="muted">No saved checklists yet.</p>`
        : recent.entries
            .map((e) => {
              const vc =
                e.verdict === "GO"
                  ? "pnl-pos"
                  : e.verdict === "NO-GO"
                    ? "pnl-neg"
                    : "muted";
              return `<div class="journal-row" style="cursor:default">
                <div class="journal-top">
                  <strong>${escapeHtml(e.symbol || e.mint.slice(0, 8))}</strong>
                  <span class="${vc}">${escapeHtml(e.verdict)}</span>
                </div>
                <div class="muted">${fmtTs(e.timestamp)} · ${escapeHtml(e.mint.slice(0, 12))}…</div>
                ${e.thesis ? `<div class="journal-note">${escapeHtml(e.thesis.slice(0, 100))}</div>` : ""}
              </div>`;
            })
            .join("");

    main.innerHTML = `
      <div class="card">
        <h2>Research checklist</h2>
        <p class="muted">Human go/no-go before sizing. Bot still filters age/liq/volume. <strong>Advisory</strong> unless Settings → require GO is on.</p>
        <div class="verdict-banner ${verdictClass}" id="clVerdict">${escapeHtml(verdict)}</div>
        <label for="clMint">Mint</label>
        <input id="clMint" type="text" value="${escapeAttr(mintVal)}" placeholder="Token mint address" />
        <label for="clSymbol" style="margin-top:8px">Symbol (optional)</label>
        <input id="clSymbol" type="text" value="${escapeAttr(symVal)}" placeholder="TICKER" />
        <label for="clLink" style="margin-top:8px">DexScreener / Pump.fun link (optional)</label>
        <input id="clLink" type="url" value="${escapeAttr(linkVal)}" placeholder="https://…" />
        <div style="margin-top:12px">${itemRows}</div>
        <label for="clThesis" style="margin-top:12px">Thesis (one line)</label>
        <textarea id="clThesis" rows="2" placeholder="Why this trade?">${escapeHtml(thesisVal)}</textarea>
        <label for="clInv" style="margin-top:8px">Invalidation (when to skip / exit)</label>
        <textarea id="clInv" rows="2" placeholder="When would you pass or cut?">${escapeHtml(invVal)}</textarea>
        <div class="actions">
          <button class="primary" id="clSave" ${busy ? "disabled" : ""}>Save checklist</button>
          <button class="secondary" id="clPrefill" ${busy || !openMint ? "disabled" : ""}>Prefill open mint</button>
          <button class="secondary" id="clRefresh">Refresh</button>
        </div>
      </div>
      <div class="card">
        <h2>Recent (${escapeHtml(String(recent.total))})</h2>
        ${recentHtml}
      </div>`;

    const bump = () => {
      // Re-read texts, recompute banner without full wipe of focus when possible
      const v = localVerdict(
        items,
        (main.querySelector("#clThesis") as HTMLTextAreaElement).value,
        (main.querySelector("#clInv") as HTMLTextAreaElement).value,
      );
      const el = main.querySelector("#clVerdict");
      if (el) {
        el.textContent = v;
        el.className = `verdict-banner ${
          v === "GO" ? "verdict-go" : v === "NO-GO" ? "verdict-nogo" : "verdict-incomplete"
        }`;
      }
    };

    main.querySelectorAll("button.check-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number((btn as HTMLButtonElement).dataset.idx);
        const st = (btn as HTMLButtonElement).dataset.status as CheckStatusUI;
        if (!Number.isFinite(idx) || !items[idx]) return;
        items[idx]!.status = st;
        // Re-paint buttons for this row
        const row = main.querySelector(`.check-row[data-idx="${idx}"]`);
        row?.querySelectorAll("button.check-btn").forEach((b) => {
          const bb = b as HTMLButtonElement;
          const s = bb.dataset.status!;
          bb.className = `check-btn ${items[idx]!.status === s ? "active-" + s : ""}`;
        });
        bump();
      });
    });
    main.querySelector("#clThesis")?.addEventListener("input", () => bump());
    main.querySelector("#clInv")?.addEventListener("input", () => bump());
    main.querySelector("#clRefresh")?.addEventListener("click", () => void render());
    main.querySelector("#clPrefill")?.addEventListener("click", () => {
      const m = main.querySelector("#clMint") as HTMLInputElement;
      const s = main.querySelector("#clSymbol") as HTMLInputElement;
      if (openMint) m.value = openMint;
      if (openSym) s.value = openSym;
      if (openMint && !(main.querySelector("#clLink") as HTMLInputElement).value) {
        (main.querySelector("#clLink") as HTMLInputElement).value =
          `https://dexscreener.com/solana/${encodeURIComponent(openMint)}`;
      }
    });
    main.querySelector("#clSave")?.addEventListener("click", () => {
      void withBusy(async () => {
        const body = {
          mint: (main.querySelector("#clMint") as HTMLInputElement).value.trim(),
          symbol: (main.querySelector("#clSymbol") as HTMLInputElement).value.trim(),
          link: (main.querySelector("#clLink") as HTMLInputElement).value.trim(),
          thesis: (main.querySelector("#clThesis") as HTMLTextAreaElement).value,
          invalidation: (main.querySelector("#clInv") as HTMLTextAreaElement).value,
          items: items.map((i) => ({ id: i.id, status: i.status })),
        };
        const r = await api.createChecklist(body);
        message = r.ok
          ? `Saved ${r.entry.verdict} checklist for ${r.entry.symbol || r.entry.mint.slice(0, 8)}`
          : (r.message ?? "Save failed");
      });
    });
  };

  renderForm();
}

async function paintJournal(main: Element) {

  const data = await api.journal(50, 0);
  const entries = data.entries ?? [];
  const summary = data.summary;
  const quoteAsset = summary?.quoteAsset ?? "SOL";
  const tz = summary?.timezone ?? "America/New_York";
  const estRate = summary?.estimateQuoteUsdRate;
  const periods = summary?.periods ?? [];
  const summaryCard =
    periods.length > 0
      ? `<div class="card journal-summary">
      <h2>P&amp;L summary</h2>
      <p class="muted">Calendar periods in <strong>${escapeHtml(tz)}</strong>. Amounts in USD and ${escapeHtml(quoteAsset)}. ${
        estRate != null
          ? `Estimate rate ≈ $${Number(estRate).toFixed(2)}/${escapeHtml(quoteAsset)} for rows without a fill-time rate.`
          : "Quote amounts use fill-time rate when recorded."
      }</p>
      <div class="summary-grid">
        ${periods
          .map((p) => {
            const cls = p.pnlUsd >= 0 ? "pnl-pos" : "pnl-neg";
            const q =
              p.pnlQuote != null && Number.isFinite(p.pnlQuote)
                ? quoteAmt(p.pnlQuote, p.quoteAsset || quoteAsset)
                : "—";
            const basis =
              p.quoteBasis && p.quoteBasis !== "recorded"
                ? ` <span class="muted">(${escapeHtml(p.quoteBasis)})</span>`
                : "";
            const winText = formatWinPct(p.winPct);
            const winEmpty = winText === "—";
            return `<div class="summary-cell">
              <div class="summary-label">${escapeHtml(p.label)}</div>
              <div class="summary-headline">
                <div class="${cls} summary-pnl">${money(p.pnlUsd)}</div>
                <div class="summary-winpct${winEmpty ? " is-empty" : ""}" aria-label="Win percentage">${escapeHtml(winText)}</div>
              </div>
              <div class="muted">${escapeHtml(q)}${basis}</div>
              <div class="muted">${p.tradeCount} trade${p.tradeCount === 1 ? "" : "s"} · ${p.winCount}W/${p.lossCount}L</div>
            </div>`;
          })
          .join("")}
      </div>
    </div>`
      : "";
  const chartsCard = journalChartsHtml(data.charts);
  main.innerHTML = `
    ${summaryCard}
    ${chartsCard}
    <div class="card">
      <h2>Trade journal</h2>
      <p class="muted">Closed paper trades with notes + mint/CA. Survives session <strong>Reset</strong> — clear only via button below. Same-named coins are distinguished by CA; open DexScreener from each row. When a research checklist existed for the mint at close, a GO / NO-GO badge links the trade to that research. PnL shown in USD + ${escapeHtml(quoteAsset)}.</p>
      <div class="row"><span class="k">Entries</span><span class="v">${escapeHtml(String(data.total))}</span></div>
      ${
        entries.length === 0
          ? `<p class="muted">No closed trades yet. Exits (stop / TP / trail / manual / time) appear here.</p>`
          : entries.map((e) => {
              const pnlClass = e.pnlUsd >= 0 ? "pnl-pos" : "pnl-neg";
              const asset = (e.quoteAsset || quoteAsset || "SOL").toUpperCase();
              const chain = (e.chainId || "solana").toLowerCase();
              const notePreview = e.note?.trim()
                ? escapeHtml(e.note.trim().slice(0, 80))
                : `<span class="muted">Tap note to add</span>`;
              const mint = typeof e.mint === "string" ? e.mint.trim() : "";
              const mintShort = truncateMint(mint);
              const dexUrl = mint
                ? `https://dexscreener.com/${encodeURIComponent(chain)}/${encodeURIComponent(mint)}`
                : "";
              const mintBlock = mint
                ? `<div class="journal-mint">
                    <span class="k">CA</span>
                    <code class="mint-short" title="${escapeAttr(mint)}">${escapeHtml(mintShort)}</code>
                    <button type="button" class="linkish copy-mint" data-mint="${escapeAttr(mint)}" title="Copy full mint">Copy</button>
                    <a class="linkish" href="${escapeAttr(dexUrl)}" target="_blank" rel="noopener noreferrer">DexScreener</a>
                  </div>`
                : `<div class="journal-mint muted">CA unavailable (old row; will backfill from fills when possible)</div>`;
              const sizeDual =
                e.sizeQuote != null && Number.isFinite(e.sizeQuote)
                  ? `${money(e.sizeUsd)} · ${quoteAmt(e.sizeQuote, asset)}`
                  : money(e.sizeUsd);
              const basisHint =
                e.quoteBasis && e.quoteBasis !== "recorded"
                  ? ` · <span class="muted">${escapeHtml(e.quoteBasis)}</span>`
                  : "";
              const clVerdict = e.checklistVerdict;
              const clBadgeClass =
                clVerdict === "GO"
                  ? "go"
                  : clVerdict === "NO-GO"
                    ? "nogo"
                    : clVerdict === "INCOMPLETE"
                      ? "incomplete"
                      : "";
              const checklistBlock =
                clVerdict && e.checklistId
                  ? `<div class="journal-checklist">
                      <span class="cl-badge ${clBadgeClass}">${escapeHtml(clVerdict)}</span>
                      ${
                        e.checklistThesis
                          ? `<span class="muted">${escapeHtml(e.checklistThesis.slice(0, 80))}</span>`
                          : `<span class="muted">checklist linked</span>`
                      }
                    </div>`
                  : `<div class="journal-checklist muted">No checklist at close</div>`;
              return `<div class="journal-row" data-jid="${escapeAttr(e.id)}">
                <div class="journal-top">
                  <strong>${escapeHtml(e.symbol || mintShort || "—")}</strong>
                  <span class="${pnlClass}">${dualPnl(e.pnlUsd, e.pnlQuote, asset)} (${e.pnlPct >= 0 ? "+" : ""}${e.pnlPct.toFixed(1)}%)</span>
                </div>
                <div class="muted">${fmtTs(e.timestamp)} · ${escapeHtml(e.exitReason)}
                · size ${sizeDual}${basisHint}
                · ${escapeHtml(String(e.entryPrice))} → ${escapeHtml(String(e.exitPrice))}</div>
                ${mintBlock}
                ${checklistBlock}
                <button type="button" class="journal-note-btn" data-jid="${escapeAttr(e.id)}" data-note="${escapeAttr(e.note ?? "")}">${notePreview}</button>
              </div>`;
            }).join("")
      }
      <div class="actions">
        <button class="secondary" id="refresh">Refresh</button>
        <button class="danger" id="clearJournal" ${busy || entries.length===0 ? "disabled" : ""}>Clear journal</button>
      </div>
    </div>`;
  mountJournalCharts(main, data.charts);
  main.querySelector("#refresh")?.addEventListener("click", () => void render());
  main.querySelector("#clearJournal")?.addEventListener("click", () => {
    const ok = window.confirm(
      "Clear the entire trade journal?\n\nThis only clears learning notes / closed-trade history. Session Reset does NOT clear the journal.",
    );
    if (!ok) return;
    void withBusy(async () => {
      const r = await api.clearJournal();
      message = r.message;
    });
  });
  main.querySelectorAll("button.copy-mint").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const mint = (btn as HTMLButtonElement).dataset.mint ?? "";
      void copyText(mint).then((ok) => {
        message = ok ? "Mint copied" : "Could not copy mint";
        error = "";
        void render();
      });
    });
  });
  main.querySelectorAll("button.journal-note-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = (btn as HTMLButtonElement).dataset.jid ?? "";
      const prev = (btn as HTMLButtonElement).dataset.note ?? "";
      const next = window.prompt("Journal note (learning):", prev);
      if (next == null) return;
      void withBusy(async () => {
        const r = await api.updateJournalNote(id, next);
        message = r.ok ? "Note saved" : (r.message ?? "Failed to save note");
      });
    });
  });
}

async function paintSettings(main: Element, base: string) {
  const [cfgWrap, status, alertsOn] = await Promise.all([
    api.config(),
    api.status(),
    getSessionAlertsEnabled(),
  ]);
  const cfg = cfgWrap.config ?? {};
  const mom = (cfg.momentum ?? {}) as Record<string, number>;
  const trail = (cfg.trailingTakeProfit ?? {}) as Record<string, number>;
  const runner = (cfg.runner ?? {}) as Record<string, number>;
  const active = String(cfg.activePreset ?? "custom");
  const running = status.state === "running" || status.state === "starting";
  const num = (v: unknown, fallback = ""): string =>
    typeof v === "number" && Number.isFinite(v) ? String(v) : fallback;
  const lock = readChaseLockout(status);

  main.innerHTML = `
    ${chaseLockoutBanner(lock)}
    <div class="card">
      <h2>Strategy preset</h2>
      <p class="muted">Paper knobs only. Applying a preset requires the runner <strong>stopped</strong>.</p>
      <p class="muted"><strong>Session risk:</strong> Bankroll USD, Daily loss USD, Max position USD, and Chase lockout hours are sticky — switching Momentum ↔ Sniper does <em>not</em> reset them. Edit those fields + Save if you want new risk sizes.</p>
      <div class="row"><span class="k">Active preset</span><span class="v" id="activePresetLabel">${escapeHtml(active)}</span></div>
      <div class="preset-toggle" role="group" aria-label="Preset">
        <button type="button" class="preset-btn ${active==="momentum"?"active":""}" id="presetMomentum" ${busy||running?"disabled":""}>Momentum</button>
        <button type="button" class="preset-btn ${active==="sniper"?"active":""}" id="presetSniper" ${busy||running?"disabled":""}>Sniper</button>
      </div>
      ${running ? `<p class="muted warn-text" style="margin-top:8px">Runner is ${escapeHtml(String(status.state))} — stop it on the Run tab before switching presets or saving.</p>` : ""}
      <p class="muted" style="margin-top:8px">
        <strong>Momentum</strong>: Pump.fun research defaults (10% stop, +25% TP, min age 3m, liq $5k).<br/>
        <strong>Sniper</strong>: newer coins OK (age 0), lower liq/vol floors, 8% stop, +15% TP, faster trail / shorter hold.
      </p>
    </div>
    <div class="card">
      <h2>Paper parameters</h2>
      <div class="field-grid">
        <label>Bankroll USD <span class="muted">(session risk)</span><input id="fBankroll" type="number" step="0.01" min="0.01" value="${escapeAttr(num(cfg.bankrollUsd))}" /></label>
        <label>Max position USD <span class="muted">(session risk)</span><input id="fMaxPos" type="number" step="0.01" min="0" value="${escapeAttr(num(cfg.maxPositionUsd, "25"))}" /></label>
        <label>Stop loss %<input id="fStop" type="number" step="0.1" min="0.1" value="${escapeAttr(num(cfg.stopLossPct))}" /></label>
        <label>Take profit %<input id="fTp" type="number" step="0.1" min="0" value="${escapeAttr(num(cfg.takeProfitPct))}" /></label>
        <label>Trail activate %<input id="fTrailAct" type="number" step="0.1" min="0.1" value="${escapeAttr(num(trail.activatePct))}" /></label>
        <label>Trail distance %<input id="fTrailDist" type="number" step="0.1" min="0.1" value="${escapeAttr(num(trail.distancePct))}" /></label>
        <label>Max hold min<input id="fHold" type="number" step="1" min="0" value="${escapeAttr(num(cfg.maxHoldMinutes))}" /></label>
        <label>Daily loss USD <span class="muted">(session risk)</span><input id="fDaily" type="number" step="0.01" min="0" value="${escapeAttr(num(cfg.dailyLossUsd))}" /></label>
        <label>Chase lockout hours <span class="muted">(session risk; 0=off)</span><input id="fChase" type="number" step="0.25" min="0" value="${escapeAttr(num(cfg.chaseLockoutHours, "12"))}" /></label>
        <label>Poll interval ms<input id="fPoll" type="number" step="100" min="100" value="${escapeAttr(num(runner.pollIntervalMs))}" /></label>
        <label>Momentum min %<input id="fMomPct" type="number" step="0.1" min="0.1" value="${escapeAttr(num(mom.minPct))}" /></label>
        <label>Min age min<input id="fAge" type="number" step="1" min="0" value="${escapeAttr(num(mom.minAgeMinutes))}" /></label>
        <label>Min liquidity USD<input id="fLiq" type="number" step="100" min="0" value="${escapeAttr(num(mom.minLiquidityUsd))}" /></label>
        <label>Min vol 24h USD<input id="fVol" type="number" step="100" min="0" value="${escapeAttr(num(mom.minVolume24hUsd))}" /></label>
      </div>
      <div class="actions">
        <button class="primary" id="saveCfg" ${busy||running?"disabled":""}>Save</button>
        <button class="secondary" id="refreshCfg">Refresh</button>
      </div>
      <p class="muted" style="margin-top:10px">Saved to server <code>data/runtime-config.json</code> (survives restart). Changing bankroll / max position / daily loss asks for confirm (sticky risk friction). Live / wallet fields are rejected by the API.</p>
    </div>
    <div class="card">
      <h2>Research checklist gate</h2>
      <p class="muted">When <strong>on</strong>, the paper bot skips entries unless a saved checklist for that mint has verdict <strong>GO</strong>. Default <strong>off</strong> (checklist is advisory only).</p>
      <div class="row">
        <span class="k">Require GO before entry</span>
        <span class="v">
          <label class="toggle">
            <input type="checkbox" id="requireGoToggle" ${cfg.requireChecklistGo === true ? "checked" : ""} ${busy||running?"disabled":""} />
            <span>${cfg.requireChecklistGo === true ? "On" : "Off"}</span>
          </label>
        </span>
      </div>
      ${running ? `<p class="muted warn-text" style="margin-top:8px">Stop the runner before changing this gate.</p>` : ""}
    </div>
    <div class="card">
      <h2>Rug filter</h2>
      <p class="muted">Paper only. Default <strong>off</strong> (same buys as today). When <strong>on</strong>, a buy is skipped if freeze authority is set, the top non-curve holder is above ${escapeHtml(String(cfg.rugFilterMaxTopHolderPct ?? 30))}%, or too many buys share the creation slot. Needs a read-only Solana RPC. If the RPC is not set, the buy is skipped. Does not send a live trade.</p>
      <div class="row">
        <span class="k">Pre-buy rug filter</span>
        <span class="v">
          <label class="toggle">
            <input type="checkbox" id="rugFilterToggle" ${cfg.rugFilterEnabled === true ? "checked" : ""} ${busy||running?"disabled":""} />
            <span>${cfg.rugFilterEnabled === true ? "On" : "Off"}</span>
          </label>
        </span>
      </div>
      <p class="muted">Dev rug history and wash volume are not checked (no data for them). The RPC address is never shown.</p>
      ${running ? `<p class="muted warn-text" style="margin-top:8px">Stop the runner before changing this filter.</p>` : ""}
    </div>
    <div class="card">
      <h2>Session alerts</h2>
      <p class="muted">Local Android notifications for paper start/stop, opens, closes (with PnL), daily loss, and exit reasons. Default <strong>on</strong>.</p>
      <div class="row">
        <span class="k">Session alerts</span>
        <span class="v">
          <label class="toggle">
            <input type="checkbox" id="alertToggle" ${alertsOn ? "checked" : ""} />
            <span>${alertsOn ? "On" : "Off"}</span>
          </label>
        </span>
      </div>
      <div class="actions">
        <button class="secondary" id="alertPerm" ${busy ? "disabled" : ""}>Request notification permission</button>
      </div>
    </div>
    <div class="card">
      <h2>API base URL</h2>
      <label for="apiUrl">No private keys — only the control HTTP API</label>
      <input id="apiUrl" type="url" value="${escapeAttr(base)}" placeholder="${DEFAULT_API_BASE}" />
      <div class="actions">
        <button class="primary" id="saveUrl">Save URL</button>
        <button class="secondary" id="resetUrl">Reset default</button>
      </div>
      <p class="muted" style="margin-top:12px">
        USB / emulator: <code>adb reverse tcp:8787 tcp:8787</code> then use
        <code>http://127.0.0.1:8787</code>.<br/>
        Same Wi‑Fi: <code>http://&lt;laptop-lan-ip&gt;:8787</code>
        (laptop: <code>npm run api</code>, firewall allow 8787).
      </p>
    </div>
  `;

  const applyPreset = (preset: "momentum" | "sniper") => {
    void withBusy(async () => {
      const r = await api.applyPreset(preset);
      message = r.message;
    });
  };
  main.querySelector("#presetMomentum")?.addEventListener("click", () => applyPreset("momentum"));
  main.querySelector("#presetSniper")?.addEventListener("click", () => applyPreset("sniper"));
  main.querySelector("#refreshCfg")?.addEventListener("click", () => void render());
  main.querySelector("#saveCfg")?.addEventListener("click", () => {
    const n = (id: string) => Number((main.querySelector(`#${id}`) as HTMLInputElement).value);
    const nextBankroll = n("fBankroll");
    const nextMaxPos = n("fMaxPos");
    const nextDaily = n("fDaily");
    const prevBankroll = Number(cfg.bankrollUsd);
    const prevMaxPos = Number(cfg.maxPositionUsd);
    const prevDaily = Number(cfg.dailyLossUsd);
    const riskChanged =
      (Number.isFinite(nextBankroll) && nextBankroll !== prevBankroll) ||
      (Number.isFinite(nextMaxPos) && nextMaxPos !== prevMaxPos) ||
      (Number.isFinite(nextDaily) && nextDaily !== prevDaily);
    if (riskChanged) {
      const ok = window.confirm(
        `Change sticky session risk?\n\n` +
          `Bankroll: $${Number.isFinite(prevBankroll) ? prevBankroll.toFixed(2) : "?"} → $${Number.isFinite(nextBankroll) ? nextBankroll.toFixed(2) : "?"}\n` +
          `Max position: $${Number.isFinite(prevMaxPos) ? prevMaxPos.toFixed(2) : "?"} → $${Number.isFinite(nextMaxPos) ? nextMaxPos.toFixed(2) : "?"}\n` +
          `Daily loss: $${Number.isFinite(prevDaily) ? prevDaily.toFixed(2) : "?"} → $${Number.isFinite(nextDaily) ? nextDaily.toFixed(2) : "?"}\n\n` +
          `Presets do not overwrite these. Cancel if this was accidental.`,
      );
      if (!ok) return;
    }
    void withBusy(async () => {
      const r = await api.patchConfig({
        bankrollUsd: nextBankroll,
        maxPositionUsd: nextMaxPos,
        stopLossPct: n("fStop"),
        takeProfitPct: n("fTp"),
        maxHoldMinutes: n("fHold"),
        dailyLossUsd: nextDaily,
        chaseLockoutHours: n("fChase"),
        trailingTakeProfit: {
          activatePct: n("fTrailAct"),
          distancePct: n("fTrailDist"),
        },
        runner: { pollIntervalMs: n("fPoll") },
        momentum: {
          minPct: n("fMomPct"),
          minAgeMinutes: n("fAge"),
          minLiquidityUsd: n("fLiq"),
          minVolume24hUsd: n("fVol"),
        },
      });
      message = r.message;
    });
  });
  main.querySelector("#saveUrl")!.addEventListener("click", () => {
    const v = (main.querySelector("#apiUrl") as HTMLInputElement).value;
    void withBusy(async () => {
      await setApiBaseUrl(v);
      message = "Saved API URL";
    });
  });
  main.querySelector("#resetUrl")!.addEventListener("click", () => {
    void withBusy(async () => {
      await setApiBaseUrl(DEFAULT_API_BASE);
      message = "Reset to default";
    });
  });

  main.querySelector("#requireGoToggle")?.addEventListener("change", (ev) => {
    const on = (ev.target as HTMLInputElement).checked;
    void withBusy(async () => {
      const r = await api.patchConfig({ requireChecklistGo: on });
      message = r.message;
    });
  });
  main.querySelector("#rugFilterToggle")?.addEventListener("change", (ev) => {
    const on = (ev.target as HTMLInputElement).checked;
    void withBusy(async () => {
      const r = await api.patchConfig({ rugFilterEnabled: on });
      message = r.message;
    });
  });
  main.querySelector("#alertToggle")?.addEventListener("change", (ev) => {
    const on = (ev.target as HTMLInputElement).checked;
    void withBusy(async () => {
      await setSessionAlertsEnabled(on);
      if (on) await ensureAlertPermission();
      message = on ? "Session alerts on" : "Session alerts off";
    });
  });
  main.querySelector("#alertPerm")?.addEventListener("click", () => {
    void withBusy(async () => {
      const ok = await ensureAlertPermission();
      message = ok ? "Notification permission granted (or already granted)" : "Notification permission denied";
    });
  });
}

/** Update PnL numbers without rebuilding the chart iframe. */
async function softRefreshBankroll() {
  try {
    const [data, status] = await Promise.all([api.portfolio(), api.status()]);
    const p = data.portfolio;
    const main = app.querySelector("#main");
    if (!main) return;
    const set = (key: string, val: string) => {
      const el = main.querySelector(`[data-k="${key}"]`);
      if (el) el.textContent = val;
    };
    const vaultUsd = typeof p.vaultUsd === "number" ? p.vaultUsd : (data.vaultUsd ?? 0);
    const tradable = typeof p.tradableCashUsd === "number" ? p.tradableCashUsd : p.cashUsd;
    const totalEq = typeof p.totalEquityUsd === "number" ? p.totalEquityUsd : p.equityUsd + vaultUsd;
    set("bankroll", money(data.bankrollUsd));
    set("cash", money(tradable));
    set("vault", money(vaultUsd));
    set("equity", money(p.equityUsd));
    set("totalEq", money(totalEq));
    set("realized", money(p.realizedPnlUsd));
    set("unrealized", money(p.unrealizedPnlUsd));
    set("trades", String(p.tradeCount));
    const lockSoft = readChaseLockout(status) ?? readChaseLockout(data as unknown as Record<string, unknown>);
    if (lockSoft?.active) {
      set("chaseUnlock", formatUnlockAt(lockSoft.unlockAt));
    }
    const stopEl = main.querySelector("[data-k=\"stopReason\"]");
    const stopReason =
      typeof status.stopReason === "string" && status.stopReason
        ? status.stopReason
        : null;
    if (stopEl) {
      stopEl.textContent = stopReason ?? "—";
      (stopEl as HTMLElement).classList.toggle("warn-text", Boolean(stopReason));
    }
    const positions = p.openPositions ?? [];
    const exitBtn = main.querySelector("#exitNow") as HTMLButtonElement | null;
    if (exitBtn) exitBtn.disabled = busy || positions.length === 0;
    // If flat or mint changed, do a full paint so chart appears/disappears correctly.
    const frame = main.querySelector(".chart-frame") as HTMLIFrameElement | null;
    const openMint = positions[0]?.mint ?? null;
    const frameMint = frame?.dataset.mint ?? null;
    if ((openMint ?? null) !== (frameMint ?? null)) {
      await paintBankroll(main);
    }
  } catch {
    // Fall back to full render on soft-refresh failure.
    void render();
  }
}


function truncateMint(mint: string): string {
  const m = mint.trim();
  if (!m) return "—";
  if (m.length <= 12) return m;
  return `${m.slice(0, 4)}…${m.slice(-4)}`;
}

async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]!));
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

type ChaseLockoutUI = {
  active?: boolean;
  unlockAt?: number | null;
  lockedAt?: number | null;
  reason?: string | null;
  originalDepositUsd?: number | null;
  remainingMs?: number;
  lockoutHours?: number | null;
};

function readChaseLockout(statusOrPort: Record<string, unknown>): ChaseLockoutUI | null {
  const raw = statusOrPort.chaseLockout;
  if (raw == null || typeof raw !== "object") return null;
  return raw as ChaseLockoutUI;
}

function formatUnlockAt(unlockAt: number | null | undefined): string {
  if (unlockAt == null || !Number.isFinite(unlockAt)) return "—";
  try {
    return new Date(unlockAt).toLocaleString();
  } catch {
    return String(unlockAt);
  }
}

function chaseLockoutBanner(lock: ChaseLockoutUI | null): string {
  if (!lock || !lock.active) return "";
  const until = formatUnlockAt(lock.unlockAt);
  const reason = lock.reason ? escapeHtml(String(lock.reason)) : "Full original deposit lost";
  return `<div class="card" style="border-color:#c45c26">
      <h2 class="warn-text">Chase lockout</h2>
      <p class="muted">Trading locked on the <strong>laptop/API</strong> after wiping the original deposit (not growing equity). Phone restart / Reset cannot bypass.</p>
      <div class="row"><span class="k">Status</span><span class="v warn-text">LOCKED</span></div>
      <div class="row"><span class="k">Unlock at</span><span class="v" data-k="chaseUnlock">${escapeHtml(until)}</span></div>
      <div class="row"><span class="k">Reason</span><span class="v">${reason}</span></div>
      <p class="muted">Timer-only unlock (paper preview). Wait until unlock-at — there is no easy unlock button.</p>
    </div>`;
}


void render();
setInterval(() => {
  void pollSessionAlerts();
  if (busy || document.hidden || tab === "settings" || tab === "checklist") return;
  const active = document.activeElement as HTMLElement | null;
  if (active && active.id === "pinMint") return;
  // Keep the live chart iframe mounted; only soft-update numbers on PnL.
  if (tab === "bankroll" && document.querySelector(".chart-frame")) {
    void softRefreshBankroll();
    return;
  }
  void render();
}, 8000);

// Warm alert cursor so first events after app open are caught.
void pollSessionAlerts();
