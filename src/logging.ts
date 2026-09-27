type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const minLevel: Level =
  (process.env.LOG_LEVEL as Level | undefined) ?? "info";

function shouldLog(level: Level): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function stamp(): string {
  return new Date().toISOString();
}

export const log = {
  debug(msg: string, extra?: unknown): void {
    if (!shouldLog("debug")) return;
    console.debug(`[${stamp()}] DEBUG ${msg}`, extra ?? "");
  },
  info(msg: string, extra?: unknown): void {
    if (!shouldLog("info")) return;
    console.log(`[${stamp()}] INFO  ${msg}`, extra ?? "");
  },
  warn(msg: string, extra?: unknown): void {
    if (!shouldLog("warn")) return;
    console.warn(`[${stamp()}] WARN  ${msg}`, extra ?? "");
  },
  error(msg: string, extra?: unknown): void {
    if (!shouldLog("error")) return;
    console.error(`[${stamp()}] ERROR ${msg}`, extra ?? "");
  },
};
