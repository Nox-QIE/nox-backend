/**
 * The Game Master's witness report (10.07 #1): what the group did during the day's discussion, from
 * counts only. Each group message of a living player is read once, in memory, as it arrives: it adds
 * one to its author's count and one to each other living player whose display name it contains. The
 * text is then dropped: never stored, never sent to the AI. Only the counts reach the narrator. Needs
 * Telegram privacy mode off (the bot reads the group).
 */
export interface Witness {
  /** Living players named most often by others, highest first (at most three). */
  mentioned: { name: string; count: number }[];
  /** The living player who wrote the most, when one clearly did. */
  talkative: string | null;
  /** Living players who wrote nothing. */
  quiet: string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class DiscussionTally {
  private readonly spoke = new Map<string, number>();
  private readonly named = new Map<string, number>();
  private readonly patterns: { id: string; re: RegExp }[];

  /** `players`: the living players, by id, with the display name the group sees. */
  constructor(private readonly players: { id: string; name: string }[]) {
    for (const p of players) {
      this.spoke.set(p.id, 0);
      this.named.set(p.id, 0);
    }
    // Whole-word, case-insensitive matches of each display name (two letters or more).
    this.patterns = players
      .filter((p) => p.name.trim().length >= 2)
      .map((p) => ({ id: p.id, re: new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(p.name.trim())}($|[^\\p{L}\\p{N}])`, "iu") }));
  }

  /** One message; anyone who is not a living player (the dead, spectators) is ignored. */
  note(speaker: string, text: string) {
    const n = this.spoke.get(speaker);
    if (n === undefined) return;
    this.spoke.set(speaker, n + 1);
    for (const p of this.patterns) if (p.id !== speaker && p.re.test(text)) this.named.set(p.id, this.named.get(p.id)! + 1);
  }

  get messages() {
    let n = 0;
    for (const c of this.spoke.values()) n += c;
    return n;
  }

  report(): Witness {
    const nameOf = new Map(this.players.map((p) => [p.id, p.name]));
    const mentioned = [...this.named]
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id, count]) => ({ name: nameOf.get(id)!, count }));
    const counts = [...this.spoke.values()].sort((a, b) => b - a);
    // "Talkative" only for a clear leader with at least three messages.
    const top = counts[0]! >= 3 && counts[0]! > (counts[1] ?? 0) ? [...this.spoke].find(([, n]) => n === counts[0]) : undefined;
    return {
      mentioned,
      talkative: top ? nameOf.get(top[0])! : null,
      quiet: [...this.spoke].filter(([, n]) => n === 0).map(([id]) => nameOf.get(id)!),
    };
  }
}
