import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";

import type { AssayDatabase } from "./database";

export interface AssayAuthConfig {
  baseUrl: string;
  secret: string;
  trustedOrigins: readonly string[];
  googleClientId: string;
  googleClientSecret: string;
}

export function createAssayAuth(config: AssayAuthConfig, database: AssayDatabase) {
  const options = {
    appName: "Assay",
    baseURL: config.baseUrl,
    secret: config.secret,
    trustedOrigins: [...new Set([config.baseUrl, ...config.trustedOrigins])],
    database: database.sqlite as Exclude<BetterAuthOptions["database"], undefined>,
    emailAndPassword: {
      enabled: false,
    },
    socialProviders: {
      google: {
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        prompt: "select_account",
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
  } satisfies BetterAuthOptions;
  const auth = betterAuth(options);

  return {
    auth,
    async initialize(): Promise<void> {
      const migrations = await getMigrations(options);
      await migrations.runMigrations();
      database.initializeAuditHistory();
    },
  };
}

export type AssayAuthService = ReturnType<typeof createAssayAuth>;
