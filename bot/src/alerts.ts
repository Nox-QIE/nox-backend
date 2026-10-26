/**
 * Error-rate alerts for the operator (APP-08). Every structured log line passes through; when an
 * error kind crosses its threshold inside its window, one alert goes out, then that rule is quiet
 * for an hour. Single incidents with their own alert (a disputed game, a low operator balance, a
 * suspended agent) are not repeated here.
 */
export interface AlertRule {
  event: string;
  /** Events within `windowMs` that raise the alert. */
  count: number;
  windowMs: number;
  message: (n: number, minutes: number) => string;
}

export const DEFAULT_RULES: AlertRule[] = [
  { event: "chain_error", count: 3, windowMs: 10 * 60_000, message: (n, m) => `${n} chain errors in ${m} min: games are being cancelled. Check the RPCs and the operator wallet.` },
  { event: "gm_error", count: 10, windowMs: 10 * 60_000, message: (n, m) => `${n} Game Master errors in ${m} min: narration is falling back to templates. Check the LLM provider.` },
  { event: "bot_error", count: 5, windowMs: 10 * 60_000, message: (n, m) => `${n} bot errors in ${m} min. Check the bot logs.` },
];

export class AlertMonitor {
  private readonly seen = new Map<string, number[]>();
  private readonly lastAlert = new Map<string, number>();

  constructor(
    private readonly o: { send: (text: string) => void; rules?: AlertRule[]; cooldownMs?: number; now?: () => number },
  ) {}

  observe(line: Record<string, unknown>) {
    const rule = (this.o.rules ?? DEFAULT_RULES).find((r) => r.event === line.event);
    if (!rule) return;
    const now = (this.o.now ?? Date.now)();
    const times = (this.seen.get(rule.event) ?? []).filter((t) => now - t < rule.windowMs);
    times.push(now);
    this.seen.set(rule.event, times);
    const last = this.lastAlert.get(rule.event) ?? -Infinity;
    if (times.length >= rule.count && now - last >= (this.o.cooldownMs ?? 3600_000)) {
      this.lastAlert.set(rule.event, now);
      this.o.send(`⚠️ <b>Nox alert</b>: ${rule.message(times.length, Math.round(rule.windowMs / 60_000))}`);
    }
  }
}
