import type { StoredTx } from "./store.js";

/**
 * Operator wallet watch (F11-D06, F11-S07). The operator pays every operator transaction and every
 * gas drip, so running dry stops all games. Keeps a balance snapshot at most every 10 minutes and
 * raises an alert when the balance is below the threshold, at most once every 6 hours.
 */
export class TreasuryWatch {
  private lastSnapshot = -Infinity;
  private lastAlert = -Infinity;

  constructor(
    private readonly o: {
      alertWei: bigint;
      snapshot: (wei: bigint) => void;
      alert: (wei: bigint) => void;
      now?: () => number;
    },
  ) {}

  observe(wei: bigint) {
    const now = (this.o.now ?? Date.now)();
    if (now - this.lastSnapshot >= 10 * 60_000) {
      this.lastSnapshot = now;
      this.o.snapshot(wei);
    }
    if (wei < this.o.alertWei && now - this.lastAlert >= 6 * 3600_000) {
      this.lastAlert = now;
      this.o.alert(wei);
    }
  }
}

/** 1.234567 QIE from wei, for people. */
export function qie(wei: bigint, decimals = 6): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const whole = v / 10n ** 18n;
  const frac = ((v % 10n ** 18n) * 10n ** BigInt(decimals)) / 10n ** 18n;
  return `${neg ? "-" : ""}${whole}.${frac.toString().padStart(decimals, "0")}`;
}

export interface GasReportRow {
  day: string;
  step: string;
  txs: number;
  failed: number;
  gasUsed: bigint;
  feeWei: bigint;
}

/** Daily gas & fee per step (F11-D05), from the transaction ledger. Drips count their value separately. */
export function gasReport(txs: StoredTx[]): GasReportRow[] {
  const rows = new Map<string, GasReportRow>();
  for (const t of txs) {
    const day = new Date(t.at).toISOString().slice(0, 10);
    const key = `${day}|${t.step}`;
    const r = rows.get(key) ?? { day, step: t.step, txs: 0, failed: 0, gasUsed: 0n, feeWei: 0n };
    r.txs++;
    if (t.status !== "success") r.failed++;
    r.gasUsed += t.gasUsed ?? 0n;
    r.feeWei += t.feeWei ?? 0n;
    rows.set(key, r);
  }
  return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day) || a.step.localeCompare(b.step));
}
