import { describe, expect, test } from "vitest";
import { ArkResponsesStrategyParser } from "../src/natural-language-parser";

describe("ArkResponsesStrategyParser", () => {
  test("uses the competition Responses endpoint without exposing the API key in output", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const parser = new ArkResponsesStrategyParser({
      apiKey: "secret-test-key",
      model: "ep-test",
      baseUrl: "https://ark.example/api/v3/",
      maxAttempts: 1,
      fetchImpl: async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        requests.push({ url, init });
        return Response.json({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: '{"specVersion":"1","universe":{"index":"000300.SH"}}',
                },
              ],
            },
          ],
        });
      },
    });

    await expect(parser.parse("沪深 300 动量策略")).resolves.toEqual({
      specVersion: "1",
      universe: { index: "000300.SH" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://ark.example/api/v3/responses");
    expect(requests[0]?.init?.headers).toMatchObject({
      authorization: "Bearer secret-test-key",
      "content-type": "application/json",
    });
    expect(requests[0]?.init?.body).not.toContain("secret-test-key");
  });

  test("retries only bounded transient responses", async () => {
    let attempts = 0;
    const parser = new ArkResponsesStrategyParser({
      apiKey: "secret-test-key",
      model: "ep-test",
      maxAttempts: 2,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(null, { status: 429 });
        }
        return Response.json({ output_text: '{"specVersion":"1"}' });
      },
    });

    await expect(parser.parse("strategy")).resolves.toEqual({ specVersion: "1" });
    expect(attempts).toBe(2);
  });
});
