import { AGENT_CARD_PATH, type AgentCard } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type TaskStore,
} from "@a2a-js/sdk/server";
import {
  UserBuilder,
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
} from "@a2a-js/sdk/server/express";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import express, { type Express, type Request, type RequestHandler } from "express";
import { createAssayAgentCard } from "./agent-card";
import type { AssayAuthService } from "./auth";
import { DEFAULT_ASSAY_A2A_CORS_ORIGINS } from "./configuration";
import type { AssayDatabase, StoredAuditRecord } from "./database";

export interface CreateAssayA2AAppOptions {
  executor: AgentExecutor;
  publicUrl?: string;
  corsOrigins?: readonly string[];
  agentCard?: AgentCard;
  taskStore?: TaskStore;
  capabilities?: AssayServiceCapabilities;
  authService?: AssayAuthService;
  database?: AssayDatabase;
}

export interface AssayServiceCapabilities {
  skill: "audit_strategy";
  dataProvider: "PandaData";
  dataTools: readonly string[];
  backtester: "assay-backtester@1";
  dataCredentialsConfigured: boolean;
}

export interface AssayA2AApp {
  app: Express;
  agentCard: AgentCard;
  requestHandler: DefaultRequestHandler;
  taskStore: TaskStore;
}

export const ASSAY_A2A_REST_PATH = "/a2a";
export const ASSAY_A2A_JSON_RPC_PATH = "/a2a/jsonrpc";
const AUTHENTICATED_USER_ID = Symbol("authenticatedUserId");

type AuthenticatedRequest = Request & {
  [AUTHENTICATED_USER_ID]?: string;
};

function normalizePublicUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function createAssayA2AApp(options: CreateAssayA2AAppOptions): AssayA2AApp {
  const publicUrl = normalizePublicUrl(options.publicUrl ?? "http://127.0.0.1:3001");
  const corsOrigins = new Set(options.corsOrigins ?? DEFAULT_ASSAY_A2A_CORS_ORIGINS);
  const agentCard =
    options.agentCard ??
    createAssayAgentCard(
      `${publicUrl}${ASSAY_A2A_REST_PATH}`,
      `${publicUrl}${ASSAY_A2A_JSON_RPC_PATH}`,
    );
  const taskStore = options.taskStore ?? new InMemoryTaskStore();
  const requestHandler = new DefaultRequestHandler(agentCard, taskStore, options.executor);
  const app = express();
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.vary("Origin");
    response.vary("Access-Control-Request-Private-Network");
    const requestOrigin = request.get("Origin");
    if (requestOrigin !== undefined && corsOrigins.has(requestOrigin)) {
      response.setHeader("Access-Control-Allow-Origin", requestOrigin);
      response.setHeader("Access-Control-Allow-Credentials", "true");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      response.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, A2A-Version, A2A-Extensions",
      );
      if (request.get("Access-Control-Request-Private-Network") === "true") {
        response.setHeader("Access-Control-Allow-Private-Network", "true");
      }
    }
    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    next();
  });
  if (options.authService !== undefined) {
    app.all("/api/auth/*splat", toNodeHandler(options.authService.auth));
  }
  app.use(express.json({ limit: "1mb" }));
  const requireSession = createRequireSession(options.authService);
  const database = options.database;
  if (database !== undefined && requireSession !== undefined) {
    app.get("/api/audits", requireSession, (_request, response) => {
      const userId = response.locals.userId as string;
      response.json({ items: database.listAudits(userId) });
    });
    app.post("/api/audits", requireSession, (request, response) => {
      try {
        const userId = response.locals.userId as string;
        const audit = database.upsertAudit(userId, request.body as StoredAuditRecord);
        response.status(201).json(audit);
      } catch (error) {
        response.status(400).json({
          error: error instanceof Error ? error.message : "Invalid stored audit",
        });
      }
    });
    app.delete("/api/audits/:auditId", requireSession, (request, response) => {
      const userId = response.locals.userId as string;
      const auditId = request.params.auditId;
      if (typeof auditId !== "string" || auditId.trim().length === 0) {
        response.status(400).json({ error: "Audit id is required" });
        return;
      }
      const deleted = database.deleteAudit(userId, auditId);
      response.status(deleted ? 204 : 404).end();
    });
  }
  if (requireSession !== undefined) {
    app.use(ASSAY_A2A_REST_PATH, requireSession);
  }
  const a2aUserBuilder = createA2AUserBuilder(options.authService);
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
  app.use(
    ASSAY_A2A_JSON_RPC_PATH,
    jsonRpcHandler({
      requestHandler,
      userBuilder: a2aUserBuilder,
    }),
  );
  app.use(
    ASSAY_A2A_REST_PATH,
    restHandler({
      requestHandler,
      userBuilder: a2aUserBuilder,
    }),
  );
  app.get("/healthz", (_request, response) => {
    response.json({ status: "ok" });
  });
  app.get("/capabilities", (_request, response) => {
    response.json(
      options.capabilities ?? {
        skill: "audit_strategy",
        dataProvider: "PandaData",
        dataTools: [],
        backtester: "assay-backtester@1",
        dataCredentialsConfigured: false,
      },
    );
  });
  app.get("/readyz", (_request, response) => {
    const dataCredentialsConfigured = options.capabilities?.dataCredentialsConfigured ?? false;
    response.status(dataCredentialsConfigured ? 200 : 503).json({
      status: dataCredentialsConfigured ? "ready" : "not_ready",
      checks: {
        a2a: true,
        model: true,
        pandaDataCredentials: dataCredentialsConfigured,
      },
    });
  });

  return {
    app,
    agentCard,
    requestHandler,
    taskStore,
  };
}

function createRequireSession(
  authService: AssayAuthService | undefined,
): RequestHandler | undefined {
  if (authService === undefined) {
    return undefined;
  }
  return async (request, response, next) => {
    try {
      const session = await authService.auth.api.getSession({
        headers: fromNodeHeaders(request.headers),
      });
      if (session === null) {
        response.status(401).json({ error: "Authentication required" });
        return;
      }
      response.locals.userId = session.user.id;
      (request as AuthenticatedRequest)[AUTHENTICATED_USER_ID] = session.user.id;
      next();
    } catch {
      response.status(401).json({ error: "Authentication required" });
    }
  };
}

function createA2AUserBuilder(authService: AssayAuthService | undefined) {
  if (authService === undefined) {
    return UserBuilder.noAuthentication;
  }
  return async (request: Request) => {
    const userId = (request as AuthenticatedRequest)[AUTHENTICATED_USER_ID];
    if (userId === undefined) {
      throw new Error("Authenticated A2A request is missing its user identity");
    }
    return {
      get isAuthenticated() {
        return true;
      },
      get userName() {
        return userId;
      },
    };
  };
}
