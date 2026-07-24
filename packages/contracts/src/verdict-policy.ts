import type { AuditCheckId } from "./audit-checks";

export const CHECKS_WIRING_POLICY_VERSION = "1.0.0";

export const AVAILABILITY_ANNUAL_RETURN_DELTA_FAIL_THRESHOLD = 0.02;
export const AVAILABILITY_CONTAMINATED_SELECTION_RATE_FAIL_THRESHOLD = 0.1;
export const REGIME_PNL_SHARE_RESERVATION_THRESHOLD = 0.8;
export const REGIME_PNL_SHARE_FAIL_THRESHOLD = 0.95;
export const REGIME_MINIMUM_SLICE_DAYS = 60;
export const HOMOGENEITY_CORRELATION_FAIL_THRESHOLD = 0.9;
export const HOMOGENEITY_MINIMUM_DECAY_YEARS = 4;
export const CLAIM_SHARPE_OVERSTATEMENT_MULTIPLIER = 1.5;
export const CLAIM_ANNUAL_RETURN_GAP_THRESHOLD = 0.08;
export const CLAIM_PROFILE_RECOVERY_CONDITION = "提交原回测口径（ClaimProfile）后复审";

/**
 * Frozen CHECKS_WIRING §4 recovery paths. An omitted check is intentionally
 * unrecoverable; the host must never infer a recovery path from agent prose.
 */
export const FAILURE_RECOVERY_CONDITION_BY_CHECK: Readonly<Partial<Record<AuditCheckId, string>>> =
  Object.freeze({
    "param-robustness": "收窄参数敏感面或加环境过滤",
    "data-availability": "改用 PIT 成分池重跑",
    "cost-stress": "降低调仓频率/换手后复审",
    "regime-dependency": "增加环境过滤规则",
  });
