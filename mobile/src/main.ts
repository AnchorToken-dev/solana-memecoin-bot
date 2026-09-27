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
  const [health, status] = await Promise.all([api.health(), api.status()]);
  main.innerHTML = `
    <div class="card">
      <h2>Engine status</h2>
      <div class="row"><span class="k">Health</span><span class="v">${health.ok ? "ok" : "bad"}</span></div>
      <div class="row"><span class="k">Paper mode</span><span class="v">${String(health.paperMode)}</span></div>
      <div class="row"><span class="k">State</span><span class="v">${escapeHtml(String(status.state))}</span></div>
      <div class="row"><span class="k">Cycle</span><span class="v">${escapeHtml(String(status.cycle ?? 0))}</span></div>
      <div class="row"><span class="k">Source</span><span class="v">${escapeHtml(String(status.marketDataSource ?? "—"))}</span></div>
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
  const status = await api.status();
  const running = status.state === "running" || status.state === "starting";
  main.innerHTML = `
    <div class="card">
      <h2>Paper runner</h2>
      <p class="muted">Start/stop only works while the server has PAPER_MODE=true. Live trading is stubbed — this app never holds keys.</p>
      <div class="row"><span class="k">State</span><span class="v">${escapeHtml(String(status.state))}</span></div>
      <div class="actions">
        <button class="primary" id="start" ${busy||running?"disabled":""}>Start paper bot</button>
        <button class="danger" id="stop" ${busy||!running?"disabled":""}>Stop</button>
        <button class="secondary" id="refresh">Refresh</button>
      </div>
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
  const data = await api.portfolio();
  const p = data.portfolio;
  const positions = p.openPositions ?? [];
  main.innerHTML = `
    <div class="card">
      <h2>Bankroll / PnL</h2>
      <div class="row"><span class="k">Configured bankroll</span><span class="v">${money(data.bankrollUsd)}</span></div>
      <div class="row"><span class="k">Cash</span><span class="v">${money(p.cashUsd)}</span></div>
      <div class="row"><span class="k">Equity</span><span class="v">${money(p.equityUsd)}</span></div>
      <div class="row"><span class="k">Realized PnL</span><span class="v">${money(p.realizedPnlUsd)}</span></div>
      <div class="row"><span class="k">Unrealized PnL</span><span class="v">${money(p.unrealizedPnlUsd)}</span></div>
      <div class="row"><span class="k">Trades</span><span class="v">${escapeHtml(String(p.tradeCount))}</span></div>
      <div class="actions"><button class="secondary" id="refresh">Refresh</button></div>
    </div>
    <div class="card">
      <h2>Open positions (${positions.length})</h2>
      ${
        positions.length === 0
          ? `<p class="muted">Flat — no open paper positions.</p>`
          : positions.map((pos) => `
            <div class="trade">
              <strong>${escapeHtml(String(pos.symbol))}</strong>
              · qty ${escapeHtml(String(Number(pos.qty).toFixed?.(4) ?? pos.qty))}
              · entry ${escapeHtml(String(pos.entryPrice))}
              · trail ${pos.trailArmed ? "armed" : "off"}
            </div>`).join("")
      }
    </div>`;
  main.querySelector("#refresh")?.addEventListener("click", () => void render());
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]!));
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

void render();
setInterval(() => {
  if (tab !== "settings" && !busy && !document.hidden) void render();
}, 8000);
