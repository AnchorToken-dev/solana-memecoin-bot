import "./styles.css";
import { api, ApiError } from "./api";
import { DEFAULT_API_BASE, getApiBaseUrl, setApiBaseUrl } from "./settings";

type Tab = "status" | "control" | "bankroll" | "trades" | "settings";

const app = document.querySelector("#app")!;
let tab: Tab = "status";
let message = "";
let error = "";
let busy = false;

function money(n: unknown): string {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return "—";
  return `$${x.toFixed(2)}`;
}

function fmtTs(n: unknown): string {
  if (typeof n !== "number" || !n) return "—";
  return new Date(n).toLocaleString();
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
      ${(["status","control","bankroll","trades","settings"] as Tab[]).map((t) =>
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
    main.insertAdjacentHTML("beforeend", `
      <div class="card">
        <h2>API base URL</h2>
        <label for="apiUrl">No private keys — only the control HTTP API</label>
        <input id="apiUrl" type="url" value="${escapeAttr(base)}" placeholder="${DEFAULT_API_BASE}" />
        <div class="actions">
          <button class="primary" id="saveUrl">Save</button>
          <button class="secondary" id="resetUrl">Reset default</button>
        </div>
        <p class="muted" style="margin-top:12px">
          USB / emulator: <code>adb reverse tcp:8787 tcp:8787</code> then use
          <code>http://127.0.0.1:8787</code>.<br/>
          Same Wi‑Fi: <code>http://&lt;laptop-lan-ip&gt;:8787</code>
          (laptop: <code>npm run api</code>, firewall allow 8787).
        </p>
      </div>
    `);
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
    return;
  }

  // Live data tabs
  main.insertAdjacentHTML("beforeend", `<div class="card"><p class="muted">Loading…</p></div>`);
  try {
    if (tab === "status") await paintStatus(main);
    else if (tab === "control") await paintControl(main);
    else if (tab === "bankroll") await paintBankroll(main);
    else if (tab === "trades") await paintTrades(main);
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
  return ({ status: "Status", control: "Run", bankroll: "PnL", trades: "Trades", settings: "Settings" })[t];
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
  main.innerHTML = `
    <div class="card">
      <h2>Engine status</h2>
      <div class="row"><span class="k">Health</span><span class="v">${health.ok ? "ok" : "bad"}</span></div>
      <div class="row"><span class="k">Paper mode</span><span class="v">${String(health.paperMode)}</span></div>
      <div class="row"><span class="k">State</span><span class="v">${escapeHtml(String(status.state))}</span></div>
      <div class="row"><span class="k">Cycle</span><span class="v">${escapeHtml(String(status.cycle ?? 0))}</span></div>
      <div class="row"><span class="k">Source</span><span class="v">${escapeHtml(String(status.marketDataSource ?? "—"))}</span></div>
      <div class="row"><span class="k">Take-profit</span><span class="v">${tp == null ? "—" : tp <= 0 ? "off" : `+${tp}%`}</span></div>
      <div class="row"><span class="k">Trail</span><span class="v">${
        trail?.activatePct != null && trail?.distancePct != null
          ? `+${trail.activatePct}% / ${trail.distancePct}%`
          : "—"
      }</span></div>
      <div class="row"><span class="k">Started</span><span class="v">${fmtTs(status.startedAt)}</span></div>
      <div class="row"><span class="k">Last cycle</span><span class="v">${fmtTs(status.lastCycleAt)}</span></div>
      <div class="row"><span class="k">Last error</span><span class="v">${escapeHtml(String(status.lastError ?? "—"))}</span></div>
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
  main.innerHTML = `
    <div class="card">
      <h2>Paper runner</h2>
      <p class="muted">Start/stop only works while the server has PAPER_MODE=true. Live trading is stubbed — this app never holds keys.</p>
      <div class="row"><span class="k">State</span><span class="v">${escapeHtml(String(status.state))}</span></div>
      <div class="row"><span class="k">Open positions</span><span class="v">${openCount}</span></div>
      <div class="row"><span class="k">Take-profit</span><span class="v">${tp == null ? "—" : tp <= 0 ? "off (env TAKE_PROFIT_PCT)" : `+${tp}% (env TAKE_PROFIT_PCT)`}</span></div>
      ${
        stopReason
          ? `<div class="row"><span class="k">Stop reason</span><span class="v warn-text">${escapeHtml(stopReason)}</span></div>
             <p class="muted">Daily-loss (or other) lock stays until you <strong>Reset</strong> on the PnL tab — Start alone does not clear the ledger.</p>`
          : ""
      }
      <div class="actions">
        <button class="primary" id="start" ${busy||running?"disabled":""}>Start paper bot</button>
        <button class="danger" id="stop" ${busy||!running?"disabled":""}>Stop</button>
        <button class="secondary" id="refresh">Refresh</button>
      </div>
      <p class="muted" style="margin-top:10px"><strong>Exit now</strong> / <strong>Reset</strong> live on the <strong>PnL</strong> tab (near equity / open position). Change take-profit via server env <code>TAKE_PROFIT_PCT</code> (default 25; 0 = off).</p>
    </div>`;
  main.querySelector("#start")?.addEventListener("click", () => {
    void withBusy(async () => {
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
}

async function paintBankroll(main: Element) {
  const [data, status] = await Promise.all([api.portfolio(), api.status()]);
  const p = data.portfolio;
  const positions = p.openPositions ?? [];
  const hasOpen = positions.length > 0;
  const stopReason =
    typeof status.stopReason === "string" && status.stopReason
      ? status.stopReason
      : null;
  main.innerHTML = `
    <div class="card">
      <h2>Bankroll / PnL</h2>
      <div class="row"><span class="k">Configured bankroll</span><span class="v" data-k="bankroll">${money(data.bankrollUsd)}</span></div>
      <div class="row"><span class="k">Cash</span><span class="v" data-k="cash">${money(p.cashUsd)}</span></div>
      <div class="row"><span class="k">Equity</span><span class="v" data-k="equity">${money(p.equityUsd)}</span></div>
      <div class="row"><span class="k">Realized PnL</span><span class="v" data-k="realized">${money(p.realizedPnlUsd)}</span></div>
      <div class="row"><span class="k">Unrealized PnL</span><span class="v" data-k="unrealized">${money(p.unrealizedPnlUsd)}</span></div>
      <div class="row"><span class="k">Trades</span><span class="v" data-k="trades">${escapeHtml(String(p.tradeCount))}</span></div>
      ${
        stopReason
          ? `<div class="row"><span class="k">Stop reason</span><span class="v warn-text" data-k="stopReason">${escapeHtml(stopReason)}</span></div>
             <p class="muted">Use <strong>Reset</strong> below to clear the ledger / daily-loss lock before Start will stick.</p>`
          : `<div class="row hidden" id="stopReasonRow"><span class="k">Stop reason</span><span class="v" data-k="stopReason">—</span></div>`
      }
      <div class="actions">
        <button class="danger" id="exitNow" ${busy||!hasOpen?"disabled":""}>Exit now</button>
        <button class="secondary" id="reset" ${busy?"disabled":""}>Reset</button>
        <button class="secondary" id="refresh">Refresh</button>
      </div>
      <p class="muted" style="margin-top:10px">Exit now flattens the open paper position at the current mark (<code>manual_exit</code>). Reset restores <code>BANKROLL_USD</code> cash and clears <code>stopReason</code>. Start/Stop stay on the Run tab.</p>
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
      "Reset paper session?\n\nThis stops the runner (if running), clears trades, and restores cash to BANKROLL_USD. The daily-loss lock is cleared so Start works again.",
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

async function paintTrades(main: Element) {
  const { trades } = await api.trades(40);
  main.innerHTML = `
    <div class="card">
      <h2>Recent trades</h2>
      ${
        trades.length === 0
          ? `<p class="muted">No fills yet. Start the paper bot from the Run tab.</p>`
          : trades.map((t) => {
              const f = t.fill;
              return `<div class="trade">
                <div><strong>${escapeHtml(String(f.side).toUpperCase())} ${escapeHtml(String(f.symbol))}</strong>
                · ${money(f.notionalUsd)}</div>
                <div class="muted">${fmtTs(f.timestamp)} · ${escapeHtml(String(f.reason ?? "entry"))}
                ${t.realizedPnlUsd != null ? ` · pnl ${money(t.realizedPnlUsd)}` : ""}
                · cash ${money(t.cashAfter)}</div>
              </div>`;
            }).join("")
      }
      <div class="actions"><button class="secondary" id="refresh">Refresh</button></div>
    </div>`;
  main.querySelector("#refresh")?.addEventListener("click", () => void render());
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
    set("bankroll", money(data.bankrollUsd));
    set("cash", money(p.cashUsd));
    set("equity", money(p.equityUsd));
    set("realized", money(p.realizedPnlUsd));
    set("unrealized", money(p.unrealizedPnlUsd));
    set("trades", String(p.tradeCount));
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]!));
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

void render();
setInterval(() => {
  if (busy || document.hidden || tab === "settings") return;
  // Keep the live chart iframe mounted; only soft-update numbers on PnL.
  if (tab === "bankroll" && document.querySelector(".chart-frame")) {
    void softRefreshBankroll();
    return;
  }
  void render();
}, 8000);
