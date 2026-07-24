import type { AuditCheckId } from "./audit-checks";

export const CHECKS_WIRING_POLICY_VERSION = "1.0.0";

export const AVAILABILITY_ANNUAL_RETURN_DELTA_FAIL_THRESHOLD = 0.02;
export const AVAILABILITY_CONTAMINATED_SELECTION_RATE_FAIL_THRESHOLD = 0.1;
export const CLAIM_SHARPE_OVERSTATEMENT_MULTIPLIER = 1.5;
export const CLAIM_ANNUAL_RETURN_GAP_THRESHOLD = 0.08;
export const CLAIM_PROFILE_RECOVERY_CONDITION = "提交原回测口径（ClaimProfile）后复审";

/**
 * Frozen CHECKS_WIRING §4 recovery paths. An omitted check is intentionally
 * unrecoverable; the host must never infer a recovery path from agent prose.
 */
export const FAILURE_RECOVERY_CONDITION_BY_CHECK: Readonly<Partial<Record<AuditCheckId, string>>> =
  Object.freeze({
    "param-robustness":
      "Narrow the parameter-sensitive region or add a market-regime filter, then rerun the audit.",
    "data-availability": "Use point-in-time index constituents and rerun the audit.",
    "cost-stress": "Reduce rebalance frequency or turnover, then rerun the audit.",
    "regime-dependency": "Add an explicit market-regime filter and rerun the audit.",
  });
