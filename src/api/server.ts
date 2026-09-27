/**
 * HTTP control API for the paper bot.
 * Phone / Capacitor UI talks here; engine stays on the laptop/server.
 *
 * Writes that start trading require PAPER_MODE=true.
 */
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
      methods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
    }),
  );
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "solana-memecoin-bot-control",
      paperMode: engine.cfg.paperMode,
      ts: Date.now(),
    });
  });

  app.get("/status", (_req, res) => {
    res.json(engine.getStatus());
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
      const portfolio = await engine.getPortfolio();
      res.json({
        bankrollUsd: engine.cfg.bankrollUsd,
        portfolio,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/trades", (req, res) => {
    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(1, Math.floor(limitRaw)), 500)
      : 50;
    res.json({ trades: engine.getTrades(limit) });
  });

  app.post("/runner/start", async (req, res) => {
    if (!engine.cfg.paperMode) {
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
    if (!engine.cfg.paperMode) {
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
  app.post("/position/exit", exitHandler);

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
