import type { ToolApproval, ToolApprovalDecision, ToolTier } from "@oh-my-pi/pi-agent-core";

export interface ToolAuthorizationRequest {
  agentId: string;
  taskId: string;
  traceId: string;
  toolCallId: string;
  toolName: string;
  tier: ToolTier;
  reason?: string;
}

export type ToolAuthorizer = (request: ToolAuthorizationRequest) => boolean | Promise<boolean>;

export interface ToolPolicyDecision {
  allowed: boolean;
  tier: ToolTier;
  reason?: string;
}

export function resolveToolApproval(
  approval: ToolApproval | undefined,
  args: unknown,
): ToolApprovalDecision {
  if (approval === undefined) {
    return "exec";
  }
  return typeof approval === "function" ? approval(args) : approval;
}

export class ToolPolicy {
  constructor(readonly authorize?: ToolAuthorizer) {}

  async evaluate(
    request: Omit<ToolAuthorizationRequest, "tier" | "reason">,
    approval: ToolApproval | undefined,
    args: unknown,
  ): Promise<ToolPolicyDecision> {
    const resolved = resolveToolApproval(approval, args);
    const tier = typeof resolved === "string" ? resolved : resolved.tier;
    const reason = typeof resolved === "string" ? undefined : resolved.reason;

    if (tier === "read") {
      return { allowed: true, tier, reason };
    }

    const allowed = this.authorize ? await this.authorize({ ...request, tier, reason }) : false;

    return {
      allowed,
      tier,
      reason: reason ?? (allowed ? undefined : `${tier} tools require an explicit host approval`),
    };
  }
}
