export interface NaturalLanguageParseOptions {
  signal?: AbortSignal;
}

export interface NaturalLanguageStrategyParser {
  parse(input: string, options?: NaturalLanguageParseOptions): Promise<unknown>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ArkParserErrorCode =
  | "configuration_error"
  | "request_failed"
  | "response_invalid"
  | "response_unparseable";

export class ArkParserError extends Error {
  readonly code: ArkParserErrorCode;
  readonly status?: number;

  constructor(
    code: ArkParserErrorCode,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ArkParserError";
    this.code = code;
    this.status = options?.status;
  }
}

export interface ArkResponsesStrategyParserOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  fetchImpl?: FetchLike;
}

const DEFAULT_ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 2;

const EXTRACTION_INSTRUCTIONS = `You extract a natural-language quantitative equity strategy into one JSON object.

Return JSON only, with no Markdown and no explanation. Never invent required facts that the user did not provide.

Separate the two meanings in the input:
- universe, signal, selection, rebalance, window, and costs describe the strategy and alone determine what market data is required;
- claims are performance numbers asserted by the user and are only targets for later audit comparison.
Never use a claim to infer, alter, or fill a strategy field.

The supported StrategySpec shape is:
{
  "specVersion": "1",
  "universe": { "index": "index code" },
  "signal":
    { "kind": "library", "name": "factor name" }
    or
    {
      "kind": "template",
      "template": "momentum" | "reversal" | "volatility" | "turnover_rate",
      "params": {
        "window": integer,
        "direction": "low" | "high"
      }
    },
  "selection": { "topN": integer, "weighting": "equal" },
  "rebalance": { "frequency": "weekly" | "monthly", "at": "close" },
  "window": { "start": "YYYYMMDD", "end": "YYYYMMDD" },
  "costs": { "model": "none" | "standard" | "realistic" | "pessimistic" },
  "claims": {
    "annualReturn": number, // decimal ratio: 18% must be 0.18
    "sharpe": number,
    "maxDrawdown": number
  }
}

Omit fields that are genuinely absent. Preserve explicit unsupported values so deterministic validation can reject them. Do not convert arbitrary Python, executable code, custom stock lists, full-market universes, or formula signals into a supported template.`;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function createRequestInput(input: string): string {
  return `${EXTRACTION_INSTRUCTIONS}\n\n<strategy-input>\n${input}\n</strategy-input>`;
}

function extractOutputText(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const response = value as Record<string, unknown>;
  if (typeof response.output_text === "string" && response.output_text.trim().length > 0) {
    return response.output_text;
  }
  if (!Array.isArray(response.output)) {
    return undefined;
  }

  const fragments: string[] = [];
  for (const outputItem of response.output) {
    if (typeof outputItem !== "object" || outputItem === null) {
      continue;
    }
    const content = (outputItem as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const contentItem of content) {
      if (typeof contentItem !== "object" || contentItem === null) {
        continue;
      }
      const record = contentItem as Record<string, unknown>;
      if (
        (record.type === "output_text" || record.type === "text") &&
        typeof record.text === "string"
      ) {
        fragments.push(record.text);
      }
    }
  }

  const joined = fragments.join("").trim();
  return joined.length === 0 ? undefined : joined;
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const candidates = [unfenced];
  const objectStart = unfenced.indexOf("{");
  const objectEnd = unfenced.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(unfenced.slice(objectStart, objectEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Try the bounded object slice before returning a credential-safe error.
    }
  }

  throw new ArkParserError(
    "response_unparseable",
    "Ark returned output that is not a StrategySpec JSON object",
  );
}

function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500;
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

export class ArkResponsesStrategyParser implements NaturalLanguageStrategyParser {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #fetch: FetchLike;

  constructor(options: ArkResponsesStrategyParserOptions) {
    this.#apiKey = options.apiKey.trim();
    this.#model = options.model.trim();
    this.#baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_ARK_BASE_URL);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#fetch = options.fetchImpl ?? fetch;

    if (this.#apiKey.length === 0) {
      throw new ArkParserError("configuration_error", "ARK_API_KEY is required");
    }
    if (this.#model.length === 0) {
      throw new ArkParserError("configuration_error", "An Ark model endpoint ID is required");
    }
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new ArkParserError("configuration_error", "Ark parser timeout must be positive");
    }
    if (
      !Number.isSafeInteger(this.#maxAttempts) ||
      this.#maxAttempts < 1 ||
      this.#maxAttempts > 3
    ) {
      throw new ArkParserError(
        "configuration_error",
        "Ark parser attempts must be between 1 and 3",
      );
    }
  }

  async parse(input: string, options: NaturalLanguageParseOptions = {}): Promise<unknown> {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      throw new ArkParserError("response_unparseable", "Strategy input is empty");
    }

    let lastFailure: ArkParserError | undefined;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}/responses`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: this.#model,
            input: createRequestInput(trimmed),
          }),
          signal: combineSignals(options.signal, this.#timeoutMs),
        });
      } catch (cause) {
        if (options.signal?.aborted) {
          throw cause;
        }
        lastFailure = new ArkParserError("request_failed", "Ark strategy parsing request failed", {
          cause,
        });
        continue;
      }

      if (!response.ok) {
        const failure = new ArkParserError(
          "request_failed",
          `Ark strategy parsing request failed with HTTP ${response.status}`,
          { status: response.status },
        );
        if (!shouldRetry(response.status) || attempt === this.#maxAttempts) {
          throw failure;
        }
        lastFailure = failure;
        continue;
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (cause) {
        const failure = new ArkParserError(
          "response_invalid",
          "Ark returned an invalid JSON response",
          {
            cause,
          },
        );
        if (attempt === this.#maxAttempts) {
          throw failure;
        }
        lastFailure = failure;
        continue;
      }

      const outputText = extractOutputText(payload);
      if (outputText === undefined) {
        const failure = new ArkParserError(
          "response_invalid",
          "Ark response did not contain output text",
        );
        if (attempt === this.#maxAttempts) {
          throw failure;
        }
        lastFailure = failure;
        continue;
      }

      try {
        return parseJsonObject(outputText);
      } catch (cause) {
        const failure =
          cause instanceof ArkParserError
            ? cause
            : new ArkParserError(
                "response_unparseable",
                "Ark returned output that is not a StrategySpec JSON object",
                {
                  cause,
                },
              );
        if (attempt === this.#maxAttempts) {
          throw failure;
        }
        lastFailure = failure;
      }
    }

    throw (
      lastFailure ?? new ArkParserError("request_failed", "Ark strategy parsing request failed")
    );
  }
}
