/**
 * Journal tendency charts. Canvas only — no chart library.
 * Numbers beside the drawings are real text so they stay large and sharp.
 * Hours with no decided trades are omitted (not drawn as 0%).
 */

export interface JournalChartsPayload {
  timezone: string;
  equityBasis: "cumulative_realized_pnl_usd";
  equity: Array<{ timestamp: number; cumulativePnlUsd: number }>;
  winRateByHour: Array<{
    hour: number;
    label: string;
    decidedCount: number;
    winCount: number;
    lossCount: number;
    winPct: number;
  }>;
  skippedHours: number[];
  winLoss: {
    winCount: number;
    lossCount: number;
    breakevenCount: number;
    averageWinUsd: number | null;
    averageLossUsd: number | null;
    payoffRatio: number | null;
  };
}

const FONT = "ui-sans-serif, system-ui, sans-serif";
const INK = "#f8fafc";
const GRID = "#94a3b8";
const WIN = "#6ee7b7";
const LOSS = "#fb7185";
const BG = "#020617";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function moneySigned(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : n > 0 ? "+" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function pctText(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  const body = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${body}%`;
}

function fmtWhen(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return "";
  }
}

export function journalChartsHtml(charts: JournalChartsPayload | undefined): string {
  if (!charts) {
    return `<div class="card journal-charts">
      <h2>Tendencies</h2>
      <p class="chart-read">Charts show up after this API is updated. Pull the new code and restart the API yourself — this screen does not restart the bot.</p>
    </div>`;
  }
  const tz = charts.timezone || "America/New_York";
  const last = charts.equity.length
    ? charts.equity[charts.equity.length - 1]!
    : null;
  const endCls =
    last == null ? "" : last.cumulativePnlUsd >= 0 ? "pnl-pos" : "pnl-neg";
  const wl = charts.winLoss;
  const ratioShown =
    wl.payoffRatio != null && Number.isFinite(wl.payoffRatio)
      ? (Math.round(wl.payoffRatio * 10) / 10).toFixed(1).replace(/\.0$/, "")
      : null;
  const ratioLine =
    ratioShown != null
      ? `Average win is ${ratioShown}× the size of the average loss.`
      : wl.averageWinUsd != null
        ? "No losing closes yet — average loss is not shown as $0."
        : wl.averageLossUsd != null
          ? "No winning closes yet — average win is not shown as $0."
          : "No decided closes yet.";
  const hourNote =
    charts.winRateByHour.length === 0
      ? "No decided closes yet. Empty hours are not shown as 0%."
      : charts.skippedHours.length > 0
        ? "Hours with no decided trades are left off, not shown as 0%. Breakeven closes are not in the rate."
        : "Every hour has at least one decided close. Breakeven closes are not in the rate.";

  const equityBlock =
    charts.equity.length === 0
      ? `<p class="chart-read">No closed trades yet.</p>`
      : `<div class="chart-stat">
          <div class="chart-stat-label">Cumulative realized P&amp;L</div>
          <div class="chart-stat-value ${endCls}">${esc(moneySigned(last?.cumulativePnlUsd ?? null))}</div>
        </div>
        <canvas class="journal-canvas" data-chart="equity" role="img" aria-label="Cumulative realized profit and loss over time"></canvas>
        <p class="chart-axis">Close time, ${esc(tz)}. Up is profit.</p>`;

  const hourRows = charts.winRateByHour
    .map((h) => {
      const cls = h.winPct >= 50 ? "win" : "loss";
      return `<div class="hour-row">
        <span class="hour-label">${esc(h.label)}</span>
        <span class="hour-track" aria-hidden="true"><span class="hour-fill ${cls}" style="width:${Math.max(0, Math.min(100, h.winPct))}%"></span></span>
        <span class="hour-pct ${cls}">${esc(pctText(h.winPct))}</span>
      </div>
      <div class="hour-sub">${h.winCount}W / ${h.lossCount}L · ${h.decidedCount} decided</div>`;
    })
    .join("");

  return `<div class="card journal-charts" data-journal-charts="1">
    <h2>Tendencies</h2>
    <p class="chart-read">From every closed journal row, not just the list below. No new data is collected.</p>
    <h3>Equity over time</h3>
    <p class="chart-read">Cumulative realized P&amp;L. The journal does not store account equity.</p>
    ${equityBlock}
    <h3>Win rate by hour</h3>
    <p class="chart-read">By close time in ${esc(tz)}. ${esc(hourNote)}</p>
    ${
      charts.winRateByHour.length === 0
        ? ""
        : `<div class="hour-list">${hourRows}</div>`
    }
    <h3>Average win vs average loss</h3>
    <div class="compare-grid">
      <div>
        <div class="chart-stat-label">Average win</div>
        <div class="chart-stat-value pnl-pos">${esc(moneySigned(wl.averageWinUsd))}</div>
        <div class="chart-read">${wl.winCount} winning close${wl.winCount === 1 ? "" : "s"}</div>
      </div>
      <div>
        <div class="chart-stat-label">Average loss</div>
        <div class="chart-stat-value pnl-neg">${esc(moneySigned(wl.averageLossUsd))}</div>
        <div class="chart-read">${wl.lossCount} losing close${wl.lossCount === 1 ? "" : "s"}</div>
      </div>
    </div>
    <p class="chart-read chart-compare-line">${esc(ratioLine)}</p>
    ${
      wl.averageWinUsd != null || wl.averageLossUsd != null
        ? `<canvas class="journal-canvas" data-chart="compare" role="img" aria-label="Average win compared with average loss"></canvas>`
        : ""
    }
    ${wl.breakevenCount > 0 ? `<p class="chart-read">${wl.breakevenCount} breakeven close${wl.breakevenCount === 1 ? "" : "s"} not in these averages.</p>` : ""}
  </div>`;
}


function prepare(
  canvas: HTMLCanvasElement,
  cssH: number,
): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const w = Math.max(
    280,
    Math.floor(canvas.clientWidth || canvas.parentElement?.clientWidth || 320),
  );
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, cssH);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  return { ctx, w, h: cssH };
}

function text(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  px: number,
  align: CanvasTextAlign = "left",
  color = INK,
) {
  ctx.font = `800 ${px}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillText(value, x, y);
}

function drawEquity(
  canvas: HTMLCanvasElement,
  charts: JournalChartsPayload,
) {
  const points = charts.equity;
  if (points.length === 0) return;
  const view = prepare(canvas, 300);
  if (!view) return;
  const { ctx, w, h } = view;
  const padL = 128;
  const padR = 16;
  const padT = 36;
  const padB = 56;
  let minY = 0;
  let maxY = 0;
  for (const p of points) {
    minY = Math.min(minY, p.cumulativePnlUsd);
    maxY = Math.max(maxY, p.cumulativePnlUsd);
  }
  if (minY === maxY) {
    minY -= 1;
    maxY += 1;
  }
  const plotW = Math.max(10, w - padL - padR);
  const plotH = Math.max(10, h - padT - padB);
  const xOf = (ts: number) => {
    const t0 = points[0]!.timestamp;
    const t1 = points[points.length - 1]!.timestamp;
    if (t1 === t0) return padL + plotW / 2;
    return padL + ((ts - t0) / (t1 - t0)) * plotW;
  };
  const yOf = (v: number) => padT + ((maxY - v) / (maxY - minY)) * plotH;

  ctx.strokeStyle = GRID;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();

  const ticks = [maxY, 0, minY].filter(
    (v, i, arr) => arr.findIndex((x) => Math.abs(x - v) < 1e-9) === i,
  );
  for (const v of ticks) {
    const y = yOf(v);
    ctx.strokeStyle = v === 0 ? "#cbd5e1" : "#334155";
    ctx.lineWidth = v === 0 ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    text(ctx, moneySigned(v), padL - 10, y, 20, "right");
  }
  text(ctx, "USD", 12, 20, 20, "left");

  const end = points[points.length - 1]!.cumulativePnlUsd;
  ctx.strokeStyle = end >= 0 ? WIN : LOSS;
  ctx.lineWidth = 5;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xOf(p.timestamp);
    const y = yOf(p.cumulativePnlUsd);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  const last = points[points.length - 1]!;
  ctx.fillStyle = end >= 0 ? WIN : LOSS;
  ctx.beginPath();
  ctx.arc(xOf(last.timestamp), yOf(last.cumulativePnlUsd), 7, 0, Math.PI * 2);
  ctx.fill();

  text(ctx, fmtWhen(points[0]!.timestamp, charts.timezone), padL, h - 28, 18, "left");
  if (points.length > 1) {
    text(
      ctx,
      fmtWhen(last.timestamp, charts.timezone),
      padL + plotW,
      h - 28,
      18,
      "right",
    );
  }
}

function drawCompare(canvas: HTMLCanvasElement, charts: JournalChartsPayload) {
  const win = charts.winLoss.averageWinUsd;
  const loss = charts.winLoss.averageLossUsd;
  if (win == null && loss == null) return;
  const view = prepare(canvas, 168);
  if (!view) return;
  const { ctx, w } = view;
  const maxAbs = Math.max(
    win != null ? Math.abs(win) : 0,
    loss != null ? Math.abs(loss) : 0,
    0.01,
  );
  const labelW = 118;
  const valueW = 120;
  const trackL = labelW;
  const trackR = w - valueW - 12;
  const trackW = Math.max(20, trackR - trackL);
  const rows: Array<{ label: string; value: number | null; color: string; y: number }> = [
    { label: "Avg win", value: win, color: WIN, y: 48 },
    { label: "Avg loss", value: loss, color: LOSS, y: 116 },
  ];
  for (const row of rows) {
    text(ctx, row.label, 12, row.y, 22, "left");
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(trackL, row.y - 16, trackW, 32);
    if (row.value != null) {
      const frac = Math.abs(row.value) / maxAbs;
      ctx.fillStyle = row.color;
      ctx.fillRect(trackL, row.y - 16, Math.max(8, trackW * frac), 32);
    }
    text(ctx, moneySigned(row.value), w - 12, row.y, 22, "right", row.color);
  }
}

export function mountJournalCharts(
  root: ParentNode,
  charts: JournalChartsPayload | undefined,
) {
  if (!charts) return;
  const equity = root.querySelector(
    'canvas[data-chart="equity"]',
  ) as HTMLCanvasElement | null;
  const compare = root.querySelector(
    'canvas[data-chart="compare"]',
  ) as HTMLCanvasElement | null;
  if (equity) drawEquity(equity, charts);
  if (compare) drawCompare(compare, charts);
}
