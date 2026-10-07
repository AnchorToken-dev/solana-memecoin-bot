/**
 * HTTP control API for the paper bot.
 * Phone / Capacitor UI talks here; engine stays on the laptop/server.
 *
 * Writes that start trading require PAPER_MODE=true.
 */
import { redactSecrets } from "../live/redact.js";
import { isJournalModeFilter } from "../journal/journal.js";
import express from "express";
import cors from "cors";
import type { BotEngine } from "../engine/botEngine.js";
import { log } from "../logging.js";

export interface ApiOptions {
  host?: string;
  port?: number;
}

export function createControlApp(engine: BotEngine) {
  const app = express();
  app.use(
    cors({
      // Local mobile / emulator / LAN browser UI
      origin: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  );
  app.use(express.json({ limit: "64kb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "solana-memecoin-bot-control",
      paperMode: engine.cfg.paperMode,
      tradingMode: engine.tradingMode,
      ts: Date.now(),
    });
  });

  app.get("/status", (_req, res) => {
    res.json(engine.getStatus());
  });

  /**
   * Paper chase lockout status (also embedded in GET /status + /portfolio).
   * Lives on laptop/API disk — phone restart cannot clear it.
   * No unlock POST in paper preview (timer-only).
   */
  app.get("/lockout", (_req, res) => {
    res.json({
      chaseLockout: engine.getChaseLockout(),
      chaseLockoutHours: engine.cfg.chaseLockoutHours,
      originalDepositUsd: engine.cfg.bankrollUsd,
      note: "Lockout threshold = configured bankroll (original deposit), not growing equity. Reset does not clear an active lockout.",
    });
  });

  app.get("/config", (_req, res) => {
    // Safe read — BotConfig has no private keys; do not echo process.env.
    res.json({ config: engine.getPublicConfig() });
  });

  /**
   * PATCH (or PUT) paper-safe knobs. Persists to data/runtime-config.json.
   * Rejects live-dangerous fields. Requires runner stopped.
   */
  const patchConfigHandler = (
    req: express.Request,
    res: express.Response,
  ): void => {
    if (!engine.cfg.paperMode) {
      res.status(403).json({
        ok: false,
        message:
          "PAPER_MODE only: refusing config changes while live mode is configured (live is stubbed).",
        status: engine.getStatus(),
        config: engine.getPublicConfig(),
      });
      return;
    }
    const result = engine.patchConfig(req.body);
    if (!result.ok) {
      const status =
        result.message.includes("Stop the paper runner") ? 409 : 400;
      res.status(status).json(result);
      return;
    }
    res.status(200).json(result);
  };
  app.patch("/config", patchConfigHandler);
  app.put("/config", patchConfigHandler);

  /**
   * Single-coin pin. Empty / cleared = normal hunt.
   * Does not close an open position on a different mint.
   * Paper mode only. Allowed while the runner is going.
   */
  app.get("/target", (_req, res) => {
    const status = engine.getStatus();
    res.json({
      mode: status.pinnedMint ? "pinned" : "hunt",
      mint: status.pinnedMint,
      symbol: status.pinnedSymbol,
      name: status.pinnedName,
    });
  });

  const setTarget = (req: express.Request, res: express.Response): void => {
    if (!engine.cfg.paperMode) {
      res.status(403).json({
        ok: false,
        message:
          "PAPER_MODE only: refusing to pin a coin while live mode is configured (live is stubbed).",
        status: engine.getStatus(),
      });
      return;
    }
    const result = engine.setPinnedMint(req.body);
    res.status(result.ok ? 200 : 400).json({
      ...result,
      mode: result.mint ? "pinned" : "hunt",
    });
  };
  app.post("/target", setTarget);
  app.put("/target", setTarget);

  const clearTarget = (_req: express.Request, res: express.Response): void => {
    if (!engine.cfg.paperMode) {
      res.status(403).json({
        ok: false,
        message:
          "PAPER_MODE only: refusing to clear the pin while live mode is configured (live is stubbed).",
        status: engine.getStatus(),
      });
      return;
    }
    const result = engine.clearPinnedMint();
    res.status(result.ok ? 200 : 403).json({
      ...result,
      mode: result.mint ? "pinned" : "hunt",
    });
  };
  app.delete("/target", clearTarget);
  app.post("/target/clear", clearTarget);

  /**
   * Apply named preset: { "preset": "momentum" | "sniper" }.
   * Requires runner stopped; persists overlay.
   */
  app.post("/config/preset", (req, res) => {
    if (!engine.cfg.paperMode) {
      res.status(403).json({
        ok: false,
        message:
          "PAPER_MODE only: refusing preset while live mode is configured (live is stubbed).",
        status: engine.getStatus(),
        config: engine.getPublicConfig(),
      });
      return;
    }
    const body = req.body as { preset?: unknown } | null;
    const preset = body && typeof body === "object" ? body.preset : undefined;
    const result = engine.applyPreset(preset);
    if (!result.ok) {
      const status =
        result.message.includes("Stop the paper runner") ? 409 : 400;
      res.status(status).json(result);
      return;
    }
    res.status(200).json(result);
  });

  app.get("/portfolio", async (_req, res) => {
    try {
      // portfolio.openPositions[] includes mint + symbol (Position) for chart URLs.
      // vaultUsd / tradableCashUsd: sizing uses tradable only; vault survives reset.
      const portfolio = await engine.getPortfolio();
      res.json({
        bankrollUsd: engine.cfg.bankrollUsd,
        maxPositionUsd: engine.cfg.maxPositionUsd,
        vaultUsd: portfolio.vaultUsd,
        tradableCashUsd: portfolio.tradableCashUsd,
        chaseLockout: engine.getChaseLockout(),
        chaseLockoutHours: engine.cfg.chaseLockoutHours,
        portfolio,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Skim tradable cash → vault (locked out of sizing).
   * Body: { "amountUsd": number } OR { "percentOfProfit": number }
   * percentOfProfit skims % of max(0, cash − bankrollUsd).
   * Vault survives /runner/reset.
   */
  app.post("/vault/skim", (req, res) => {
    if (!engine.cfg.paperMode) {
      res.status(403).json({
        ok: false,
        message:
          "PAPER_MODE only: refusing vault skim while live mode is configured (live is stubbed).",
        status: engine.getStatus(),
      });
      return;
    }
    const result = engine.skimToVault(req.body);
    res.status(result.ok ? 200 : 400).json(result);
  });

  /**
   * Return vault → tradable cash (paper convenience).
   * Body: { "amountUsd": number }
   */
  app.post("/vault/return", (req, res) => {
    if (!engine.cfg.paperMode) {
      res.status(403).json({
        ok: false,
        message:
          "PAPER_MODE only: refusing vault return while live mode is configured (live is stubbed).",
        status: engine.getStatus(),
      });
      return;
    }
    const result = engine.returnFromVault(req.body);
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.get("/trades", (req, res) => {
    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(1, Math.floor(limitRaw)), 500)
      : 50;
    res.json({ trades: engine.getTrades(limit) });
  });

  app.post("/runner/start", async (req, res) => {
    if (!engine.cfg.paperMode && engine.tradingMode === "paper") {
      res.status(403).json({
        ok: false,
        message:
          "PAPER_MODE only: refusing start while live mode is configured (live is stubbed).",
        status: engine.getStatus(),
      });
      return;
    }
    const q = req.query.reset;
    const bodyReset =
      typeof req.body === "object" &&
      req.body != null &&
      (req.body as { reset?: unknown }).reset === true;
    const reset =
      bodyReset ||
      q === "1" ||
      q === "true" ||
      q === "yes";
    const result = await engine.start({ reset });
    res.status(result.ok ? 200 : 403).json(result);
  });

  app.post("/runner/stop", async (_req, res) => {
    const result = await engine.stop();
    res.json(result);
  });

  /**
   * Clear paper session (ledger → BANKROLL_USD, stopReason / cycles cleared).
   * PAPER_MODE only. Unlocks start after daily_loss_cap.
   * Does NOT clear an active chase lockout (timer-only unlock).
   */
  app.post("/runner/reset", async (_req, res) => {
    if (!engine.cfg.paperMode) {
      const portfolio = await engine.getPortfolio();
      res.status(403).json({
        ok: false,
        message:
          "PAPER_MODE only: refusing reset while live mode is configured (live is stubbed).",
        status: engine.getStatus(),
        portfolio,
      });
      return;
    }
    const result = await engine.reset();
    res.status(result.ok ? 200 : 403).json(result);
  });

  /**
   * Flatten the open paper position at current mark (reason=manual_exit).
   * PAPER_MODE only. 400 when flat.
   */
  const exitHandler = async (
    _req: express.Request,
    res: express.Response,
  ): Promise<void> => {
    if (!engine.cfg.paperMode && engine.tradingMode === "paper") {
      const portfolio = await engine.getPortfolio();
      res.status(403).json({
        ok: false,
        message:
          "PAPER_MODE only: refusing manual exit while live mode is configured (live is stubbed).",
        status: engine.getStatus(),
        portfolio,
      });
      return;
    }
    const result = await engine.exitNow();
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.status(200).json(result);
  };
  app.post("/runner/exit", exitHandler);

  /**
   * Kill switch + flatten: halt new buys, then sell every open position
   * (live: real sells with the retry ladder; paper: paper fills).
   */
  app.post("/runner/sell-all", async (_req, res) => {
    const result = await engine.sellAll();
    res.status(result.ok ? 200 : 400).json(result);
  });

  /** Live problem log (failed sells / unconfirmed buys). Never contains keys. */
  app.get("/live/events", (_req, res) => {
    res.json({ events: engine.getLiveEvents() });
  });
  app.post("/position/exit", exitHandler);

  /**
   * Paper trade journal (closed fills + notes). Survives /runner/reset.
   * Newest first. Query: ?limit=&offset=
   */
  /**
   * Session alert events since `?since=` (epoch ms, exclusive).
   * Phone polls this and fires Capacitor local notifications.
   */
  app.get("/alerts", (req, res) => {
    const sinceRaw = Number(req.query.since ?? 0);
    const since = Number.isFinite(sinceRaw) ? Math.max(0, sinceRaw) : 0;
    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(1, Math.floor(limitRaw)), 100)
      : 50;
    res.json(engine.getAlerts(since, limit));
  });


  /**
   * Research go/no-go checklist (human research half). Survives /runner/reset.
   * Advisory by default — does NOT auto-block paper entries unless
   * config.requireChecklistGo=true (Settings toggle, default OFF).
   */
  app.get("/checklist/template", (_req, res) => {
    res.json(engine.getChecklistTemplate());
  });

  app.get("/checklist", (req, res) => {
    const limitRaw = Number(req.query.limit ?? 50);
    const offsetRaw = Number(req.query.offset ?? 0);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(1, Math.floor(limitRaw)), 500)
      : 50;
    const offset = Number.isFinite(offsetRaw)
      ? Math.max(0, Math.floor(offsetRaw))
      : 0;
    const mint =
      typeof req.query.mint === "string" ? req.query.mint : undefined;
    res.json(engine.getChecklist({ limit, offset, mint }));
  });

  app.get("/checklist/:id", (req, res) => {
    const id = String(req.params.id ?? "");
    const entry = engine.getChecklistById(id);
    if (!entry) {
      res.status(404).json({ ok: false, message: `Checklist not found: ${id}` });
      return;
    }
    res.json({ ok: true, entry });
  });

  app.post("/checklist", (req, res) => {
    const result = engine.createChecklist(req.body);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.status(201).json(result);
  });

  app.patch("/checklist/:id", (req, res) => {
    const id = String(req.params.id ?? "");
    const result = engine.updateChecklist(id, req.body);
    if (!result.ok) {
      const status = result.message.startsWith("Checklist not found") ? 404 : 400;
      res.status(status).json(result);
      return;
    }
    res.status(200).json(result);
  });

  app.delete("/checklist", (_req, res) => {
    if (!engine.cfg.paperMode) {
      res.status(403).json({
        ok: false,
        message:
          "PAPER_MODE only: refusing checklist clear while live mode is configured.",
      });
      return;
    }
    const result = engine.clearChecklists();
    res.status(200).json({
      ...result,
      message: `Cleared ${result.cleared} checklists`,
    });
  });

  app.get("/journal", async (req, res, next) => {
    try {
      const limitRaw = Number(req.query.limit ?? 50);
      const offsetRaw = Number(req.query.offset ?? 0);
      const limit = Number.isFinite(limitRaw)
        ? Math.min(Math.max(1, Math.floor(limitRaw)), 500)
        : 50;
      const offset = Number.isFinite(offsetRaw)
        ? Math.max(0, Math.floor(offsetRaw))
        : 0;
      // Includes Daily/Weekly/Monthly/Overall P&L summary (USD + quote asset).
      // ?mode=paper|live_dry_run|live|all (default all) filters rows + P&L summary.
      const modeQ = req.query.mode;
      const mode = isJournalModeFilter(modeQ) ? modeQ : undefined;
      res.json(await engine.getJournal({ limit, offset, mode }));
    } catch (err) {
      next(err);
    }
  });

  /** Update free-text learning note on a journal entry. */
  app.patch("/journal/:id", (req, res) => {
    const id = String(req.params.id ?? "");
    const body = req.body as { note?: unknown } | null;
    const note =
      body && typeof body === "object" && typeof body.note === "string"
        ? body.note
        : null;
    if (note == null) {
      res.status(400).json({ ok: false, message: 'Body must include string "note"' });
      return;
    }
    const result = engine.updateJournalNote(id, note);
    if (!result.ok) {
      res.status(404).json(result);
      return;
    }
    res.status(200).json(result);
  });

  /**
   * Explicit journal clear only. Does NOT run on /runner/reset —
   * learning history is kept across paper session resets.
   */
  app.delete("/journal", (_req, res) => {
    if (!engine.cfg.paperMode) {
      res.status(403).json({
        ok: false,
        message:
          "PAPER_MODE only: refusing journal clear while live mode is configured.",
      });
      return;
    }
    const result = engine.clearJournal();
    res.status(200).json({ ...result, message: `Cleared ${result.cleared} journal entries` });
  });

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      log.error("API error", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    },
  );

  // Last-resort error handler: never leak stacks, RPC URLs, or key material.
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ ok: false, message: redactSecrets(err).slice(0, 300) });
    },
  );

  return app;
}

export async function startControlApi(
  engine: BotEngine,
  opts: ApiOptions = {},
): Promise<{ host: string; port: number; close: () => Promise<void> }> {
  const host = opts.host ?? process.env.API_HOST ?? "0.0.0.0";
  const port = Number(opts.port ?? process.env.API_PORT ?? 8787);
  const app = createControlApp(engine);

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      log.info(`Control API listening on http://${host}:${port}`);
      resolve({
        host,
        port,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((e) => (e ? rej(e) : res()));
          }),
      });
    });
    server.on("error", reject);
  });
}
