import { describe, expect, test } from "vitest";
import {
  createPandaDataTools,
  type PandaDataGateway,
  type PandaDataOperation,
  type PandaDataResult,
} from "../src";

class RecordingGateway implements PandaDataGateway {
  lastCall?: {
    operation: PandaDataOperation;
    params: Readonly<Record<string, unknown>>;
    options?: {
      maxRows?: number;
      requestId?: string;
      signal?: AbortSignal;
    };
  };

  async query(
    operation: PandaDataOperation,
    params: Readonly<Record<string, unknown>>,
    options?: {
      maxRows?: number;
      requestId?: string;
      signal?: AbortSignal;
    },
  ): Promise<PandaDataResult> {
    this.lastCall = { operation, params, options };
    return {
      operation,
      sourceRef: "pandadata:market_data:test",
      rowCount: 1,
      truncated: false,
      rows: [{ date: "20260105", symbol: "000001.SZ", close: 10.5 }],
    };
  }
}

describe("PandaData agent tools", () => {
  test("forwards validated parameters and the tool-call trace id", async () => {
    const gateway = new RecordingGateway();
    const tool = createPandaDataTools(gateway).find(
      (candidate) => candidate.name === "panda_market_data",
    );
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("panda_market_data tool was not registered");
    }

    const result = await tool.execute("tool-call-1", {
      symbol: "000001.SZ",
      startDate: "20260101",
      endDate: "20260131",
      maxRows: 250,
    });

    expect(result.isError).toBeUndefined();
    expect(gateway.lastCall).toEqual({
      operation: "market_data",
      params: {
        symbol: "000001.SZ",
        startDate: "20260101",
        endDate: "20260131",
      },
      options: {
        maxRows: 250,
        requestId: "tool-call-1",
        signal: undefined,
      },
    });
  });
});
