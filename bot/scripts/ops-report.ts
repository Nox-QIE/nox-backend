/**
 * Daily operations report (APP-08): games, players, AI cost, gas, failures, new wallets and the gas
 * given to them, and Scam Shield practice per day, plus the latest operator balance. Reads the bot store only; needs no keys.
 *   npm run ops:report            (last 7 days)
 *   npm run ops:report -- 30
 */
import { SqliteStore } from "../src/store.js";
import { gasReport, qie } from "../src/treasury.js";

export interface OpsDay {
  day: string;
  games: number;
  seats: number;
  aiUsd: number;
  /** Games whose model has no known price (cost left out of aiUsd). */
  unpriced: number;
  /** Share of beats that fell back to the template (every voice failed). */
  templateShare: number;
  gasFeeWei: bigint;
  failedTxs: number;
  practiceStarted: number;
  practiceFinished: number;
  /** Wallets created (F01-D05) and QIE dripped to players, of which onboarding (first gas, F01-D04). */
  newWallets: number;
  dripWei: bigint;
  onboardingDripWei: bigint;
}

export function opsDays(store: SqliteStore, fromMs: number, toMs: number): OpsDay[] {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const days = new Map<string, OpsDay>();
  const row = (d: string) => {
    if (!days.has(d)) days.set(d, { day: d, games: 0, seats: 0, aiUsd: 0, unpriced: 0, templateShare: 0, gasFeeWei: 0n, failedTxs: 0, practiceStarted: 0, practiceFinished: 0, newWallets: 0, dripWei: 0n, onboardingDripWei: 0n });
    return days.get(d)!;
  };
  for (const g of store.finishedGames(fromMs, toMs)) {
    const r = row(day(g.endedAt));
    r.games++;
    r.seats += g.players;
  }
  const beats = new Map<string, { template: number; all: number }>();
  for (const g of store.gmGames(fromMs, toMs)) {
    const r = row(day(g.at));
    if (g.costUsd === null) r.unpriced++;
    else r.aiUsd += g.costUsd;
    const b = beats.get(r.day) ?? { template: 0, all: 0 };
    b.template += g.template;
    b.all += g.persona + g.nox + g.template;
    beats.set(r.day, b);
  }
  for (const [d, b] of beats) row(d).templateShare = b.all ? b.template / b.all : 0;
  for (const g of gasReport(store.txsBetween(fromMs, toMs))) {
    const r = row(g.day);
    r.gasFeeWei += g.feeWei;
    r.failedTxs += g.failed;
  }
  for (const t of store.txsBetween(fromMs, toMs)) {
    if (t.step !== "gas drip" || t.status !== "success") continue;
    const r = row(day(t.at));
    r.dripWei += t.valueWei ?? 0n;
    if (t.reason === "onboarding") r.onboardingDripWei += t.valueWei ?? 0n;
  }
  for (const w of store.walletsCreated(fromMs, toMs)) row(w.day).newWallets = w.wallets;
  for (const p of store.practiceStats(day(fromMs))) {
    const r = row(p.day);
    r.practiceStarted = p.started;
    r.practiceFinished = p.finished;
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

if (process.argv[1]?.endsWith("ops-report.ts")) {
  const n = Number(process.argv[2] ?? 7);
  if (!Number.isInteger(n) || n < 1) throw new Error("days must be a whole number ≥ 1");
  const store = new SqliteStore(process.env.NOX_DB_PATH || "data/nox.db");
  const to = Date.now() + 1;
  const rows = opsDays(store, to - n * 86_400_000, to);
  console.log(`day         games seats    AI USD  template   gas QIE        failed tx  practice  wallets  dripped QIE (onboarding)`);
  for (const r of rows) {
    console.log(
      `${r.day}  ${String(r.games).padStart(5)} ${String(r.seats).padStart(5)} ${r.aiUsd.toFixed(4).padStart(9)}${r.unpriced ? "*" : " "} ${`${Math.round(r.templateShare * 100)}%`.padStart(8)}   ${qie(r.gasFeeWei, 8).padStart(12)} ${String(r.failedTxs).padStart(10)}  ${`${r.practiceFinished}/${r.practiceStarted}`.padEnd(8)}  ${String(r.newWallets).padStart(7)}  ${qie(r.dripWei, 6)} (${qie(r.onboardingDripWei, 6)})`,
    );
  }
  if (rows.some((r) => r.unpriced)) console.log("* some games used a model without a known price (NOX_GM_PRICE_PER_M)");
  const bal = store.operatorBalances(to - n * 86_400_000).at(-1);
  if (bal) console.log(`Operator balance: ${qie(bal.wei)} QIE at ${new Date(bal.at).toISOString()}`);
  store.close();
}
