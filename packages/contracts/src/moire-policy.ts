import { AVAILABILITY_ANNUAL_RETURN_DELTA_FAIL_THRESHOLD } from "./verdict-policy";

/**
 * Frozen discriminative Moiré policy shared by the planner, synthesis, tests,
 * and any host that must reproduce the deterministic decision boundary.
 *
 * M3 is intentionally absent from v9. Defining its thresholds here would
 * incorrectly expand the implemented experiment catalog.
 */
export const MOIRE_POLICY_VERSION = "1.0.0" as const;
export const MOIRE_MAX_EXPERIMENTS = 2 as const;

export const MOIRE_M1_PARAM_RETENTION_TRIGGER = 0.4 as const;
export const MOIRE_M1_REGIME_PNL_SHARE_TRIGGER = 0.7 as const;
export const MOIRE_M1_DOMINANT_RETENTION_THRESHOLD = 0.7 as const;
export const MOIRE_M1_OTHER_RETENTION_THRESHOLD = 0.4 as const;

export const MOIRE_M2_CORRECTED_RETURN_DELTA_TRIGGER =
  AVAILABILITY_ANNUAL_RETURN_DELTA_FAIL_THRESHOLD;
