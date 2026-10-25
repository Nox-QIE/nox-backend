import Anthropic from "@anthropic-ai/sdk";

export interface GmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface GmCompletion {
  text: string;
  usage: GmUsage;
  model: string;
}

/** Port for the Game Master's language model, so narration can be tested without the network. */
export interface GmModel {
  readonly model: string;
  complete(system: string, user: string, timeoutMs: number): Promise<GmCompletion>;
}

export class GmModelError extends Error {}

// Models that accept the server-side `fallbacks: "default"` refusal routing on the Claude API.
const DEFAULT_FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export type GmProvider = "anthropic" | "oxion";

export interface GmModelOptions {
  provider: GmProvider;
  model: string;
  /** Oxion only: Anthropic-compatible root; a trailing /v1 (as in Oxion's docs) is accepted. */
  baseURL?: string;
  /** Oxion only: the cc_… key, sent as a Bearer token. */
  authToken?: string;
}

export function createGmModel(o: GmModelOptions): GmModel {
  if (o.provider === "anthropic") return new AnthropicGmModel(o.model, new Anthropic(), true);
  if (!o.authToken) throw new Error("OXION_API_KEY is not set");
  // apiKey: null so a stray ANTHROPIC_API_KEY in the environment is never sent to a third party.
  // The SDK appends /v1/messages itself, so drop a trailing /v1 to avoid /v1/v1/messages.
  const baseURL = (o.baseURL ?? "https://oxionai.com").replace(/\/+$/, "").replace(/\/v1$/, "");
  const client = new Anthropic({ baseURL, apiKey: null, authToken: o.authToken });
  return new AnthropicGmModel(o.model, client, false);
}

/**
 * Claude through the Anthropic SDK. `native` = the real Claude API, where we add effort and
 * server-side refusal fallbacks; Anthropic-compatible gateways (Oxion) get the plain request.
 */
export class AnthropicGmModel implements GmModel {
  constructor(
    readonly model: string,
    private readonly client: Anthropic,
    private readonly native: boolean,
  ) {}

  async complete(system: string, user: string, timeoutMs: number): Promise<GmCompletion> {
    const body = {
      model: this.model,
      // Short narration; headroom so adaptive thinking never truncates the text.
      max_tokens: 2048,
      system,
      messages: [{ role: "user" as const, content: user }],
    };
    // The narrator retries once itself, then falls back to templates; never block a game phase.
    const opts = { timeout: timeoutMs, maxRetries: 0 };
    const msg = this.native
      ? await this.client.beta.messages.create(
          {
            ...body,
            output_config: { effort: "low" },
            ...(DEFAULT_FALLBACK_MODELS.has(this.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          },
          opts,
        )
      : await this.client.messages.create(body, opts);
    if (msg.stop_reason === "refusal") throw new GmModelError("refusal");
    if (msg.stop_reason === "max_tokens") throw new GmModelError("max_tokens");
    const text = msg.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("")
      .trim();
    return {
      text,
      model: msg.model,
      usage: {
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

/** USD per million tokens: [input, output]. Cache reads/writes priced at 0.1x / 1.25x input. */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

/** `price` overrides the built-in Claude API table, e.g. for a gateway with its own rates. */
export function costUsd(model: string, u: GmUsage, price?: [number, number]): number | null {
  // Accept pool labels ("oxion:claude-opus-5.5"); gateways spell versions with dots, the Claude API with dashes.
  const id = model.slice(model.lastIndexOf(":") + 1).replace(/\./g, "-");
  const p = price ?? PRICES[id];
  if (!p) return null;
  const [inp, out] = p;
  return (u.inputTokens * inp + u.cacheReadTokens * inp * 0.1 + u.cacheWriteTokens * inp * 1.25 + u.outputTokens * out) / 1e6;
}
