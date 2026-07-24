import type { AgentTool } from "@assay/agent-runtime";
import { z, type ZodType } from "zod/v4";
import type { PandaDataGateway, PandaDataOperation } from "./panda-gateway";

const symbolSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(200)]);
const dateSchema = z.string().regex(/^\d{8}$/, "Use YYYYMMDD date format");
const fieldsSchema = symbolSchema.optional();
const maxRowsSchema = z.number().int().min(1).max(5_000).default(1_000);
const marketTypeSchema = z.enum(["stock", "index", "fund", "future"]).optional();
const exchangeSchema = z.enum(["SH", "SZ", "BJ"]).optional();
const quarterSchema = z
  .string()
  .regex(/^\d{4}(?:Q[1-4]|0331|0630|0930|1231)$/, "Use YYYYQn or YYYYMMDD quarter format");

const marketDataSchema = z
  .object({
    symbol: symbolSchema,
    startDate: dateSchema,
    endDate: dateSchema,
    type: marketTypeSchema,
    fields: fieldsSchema,
    indicator: z.string().optional(),
    st: z.boolean().optional(),
    maxRows: maxRowsSchema,
  })
  .strict();

const adjustmentFactorSchema = z
  .object({
    symbol: symbolSchema,
    startDate: dateSchema,
    endDate: dateSchema,
    fields: fieldsSchema,
    maxRows: maxRowsSchema,
  })
  .strict();

const indexWeightsSchema = z
  .object({
    indexSymbol: symbolSchema,
    stockSymbol: symbolSchema.optional(),
    startDate: dateSchema,
    endDate: dateSchema,
    fields: fieldsSchema,
    maxRows: maxRowsSchema,
  })
  .strict();

const tradeListSchema = z
  .object({
    date: z.union([dateSchema, z.array(dateSchema).min(1).max(100)]),
    exchange: exchangeSchema,
    maxRows: maxRowsSchema,
  })
  .strict();

const stockStatusSchema = z
  .object({
    symbol: symbolSchema,
    startDate: dateSchema,
    endDate: dateSchema,
    fields: fieldsSchema,
    maxRows: maxRowsSchema,
  })
  .strict();

const factorSchema = z
  .object({
    symbol: symbolSchema.optional(),
    startDate: dateSchema,
    endDate: dateSchema,
    type: marketTypeSchema,
    factors: symbolSchema,
    indexComponent: z.string().optional(),
    maxRows: maxRowsSchema,
  })
  .strict();

const tradeCalendarSchema = z
  .object({
    startDate: dateSchema,
    endDate: dateSchema,
    exchange: exchangeSchema,
    isTradingDay: z.union([z.literal(0), z.literal(1)]).optional(),
    fields: fieldsSchema,
    maxRows: maxRowsSchema,
  })
  .strict();

const financialBulletinSchema = z
  .object({
    symbol: symbolSchema,
    infoDate: dateSchema.optional(),
    endQuarter: quarterSchema.optional(),
    fields: fieldsSchema,
    maxRows: maxRowsSchema,
  })
  .strict();

const financialReportsSchema = z
  .object({
    symbol: symbolSchema,
    startQuarter: quarterSchema.optional(),
    endQuarter: quarterSchema.optional(),
    date: dateSchema.optional(),
    isLatest: z.boolean().default(false),
    fields: fieldsSchema,
    maxRows: maxRowsSchema,
  })
  .strict();

const strategySignalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("template"),
      template: z.enum(["momentum", "reversal", "volatility", "turnover_rate"]),
      params: z
        .object({
          window: z.number().int().min(2).max(252),
          direction: z.enum(["low", "high"]).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("library"),
      name: z.string().min(1),
    })
    .strict(),
]);

const strategyBacktestSchema = z
  .object({
    spec: z
      .object({
        specVersion: z.literal("1"),
        universe: z.object({ index: z.string().min(1) }).strict(),
        signal: strategySignalSchema,
        selection: z
          .object({
            topN: z.number().int().min(1).max(200),
            weighting: z.literal("equal"),
          })
          .strict(),
        rebalance: z
          .object({
            frequency: z.enum(["weekly", "monthly"]),
            at: z.literal("close"),
          })
          .strict(),
        window: z
          .object({
            start: dateSchema,
            end: dateSchema,
          })
          .strict(),
        costs: z
          .object({
            model: z.enum(["none", "standard", "realistic", "pessimistic"]),
          })
          .strict(),
        claims: z
          .object({
            annualReturn: z.number().finite().optional(),
            sharpe: z.number().finite().optional(),
            maxDrawdown: z.number().finite().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    windowVariants: z.array(z.number().int().min(2).max(252)).min(1).max(9).optional(),
    costBps: z.array(z.number().finite().min(0).max(1_000)).min(1).max(8).optional(),
    maxRows: z.literal(1).default(1),
  })
  .strict();

interface PandaToolParameters extends Record<string, unknown> {
  maxRows: number;
}

interface ToolDefinition<TSchema extends ZodType<PandaToolParameters>> {
  operation: PandaDataOperation;
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
}

function createTool<TSchema extends ZodType<PandaToolParameters>>(
  gateway: PandaDataGateway,
  definition: ToolDefinition<TSchema>,
): AgentTool<TSchema> {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    approval: "read",
    intent: "omit",
    strict: true,
    parameters: definition.parameters,
    async execute(toolCallId, parameters, signal) {
      try {
        const { maxRows, ...params } = parameters;
        const result = await gateway.query(definition.operation, params, {
          maxRows: typeof maxRows === "number" ? maxRows : 1_000,
          requestId: toolCallId,
          signal,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "PandaData tool failed";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "data_unavailable",
                message,
              }),
            },
          ],
          isError: true,
        };
      }
    },
  };
}

export function createPandaDataTools(gateway: PandaDataGateway): readonly AgentTool[] {
  return [
    createTool(gateway, {
      operation: "market_data",
      name: "panda_market_data",
      label: "PandaData Market Data",
      description:
        "读取可复核的历史股票或指数行情。日期必须是 YYYYMMDD；返回 sourceRef、总行数和受限行数据。",
      parameters: marketDataSchema,
    }),
    createTool(gateway, {
      operation: "adj_factor",
      name: "panda_adj_factor",
      label: "PandaData Adjustment Factors",
      description: "读取历史复权因子，用于避免分红送转造成的伪收益。",
      parameters: adjustmentFactorSchema,
    }),
    createTool(gateway, {
      operation: "index_weights",
      name: "panda_index_weights",
      label: "PandaData Index Constituents",
      description: "读取历史指数成分及权重，用于按历史时点重建股票池并检查幸存者偏差。",
      parameters: indexWeightsSchema,
    }),
    createTool(gateway, {
      operation: "trade_list",
      name: "panda_trade_list",
      label: "PandaData Tradable List",
      description: "读取指定交易日和交易所的可交易证券列表。",
      parameters: tradeListSchema,
    }),
    createTool(gateway, {
      operation: "stock_status_change",
      name: "panda_stock_status_change",
      label: "PandaData Stock Status",
      description: "读取上市、退市、停牌等状态变化，检查历史可交易性和时间穿越。",
      parameters: stockStatusSchema,
    }),
    createTool(gateway, {
      operation: "factor",
      name: "panda_factor",
      label: "PandaData Factors",
      description: "读取平台因子值，用于因子同质化、IC、RankIC 和逐年衰减检查。",
      parameters: factorSchema,
    }),
    createTool(gateway, {
      operation: "trade_calendar",
      name: "panda_trade_calendar",
      label: "PandaData Trading Calendar",
      description: "读取交易日历，用于无前视地确定周度或月度调仓日期。",
      parameters: tradeCalendarSchema,
    }),
    createTool(gateway, {
      operation: "financial_forecast",
      name: "panda_financial_forecast",
      label: "PandaData Financial Forecasts",
      description: "读取带 info_date 的业绩预告，用于判断某历史时点是否已能获知财务信息。",
      parameters: financialBulletinSchema,
    }),
    createTool(gateway, {
      operation: "financial_performance",
      name: "panda_financial_performance",
      label: "PandaData Performance Bulletins",
      description: "读取带 info_date 的业绩快报，用于检查披露时点和财务前视偏差。",
      parameters: financialBulletinSchema,
    }),
    createTool(gateway, {
      operation: "financial_reports",
      name: "panda_financial_reports",
      label: "PandaData Financial Reports",
      description:
        "读取季度财务记录；默认 isLatest=false 以保留历史版本。该接口没有已验证的公告时间，结论必须声明限制。",
      parameters: financialReportsSchema,
    }),
    createTool(gateway, {
      operation: "strategy_backtest",
      name: "assay_strategy_backtest",
      label: "Assay Deterministic Backtest",
      description:
        "运行 Assay 自有的确定性历史回测。可一次指定最多 9 个窗口和 8 个成本档，返回年化收益、Sharpe、最大回撤、换手率、盈亏平衡成本、数据来源与计算假设。",
      parameters: strategyBacktestSchema,
    }),
  ];
}
