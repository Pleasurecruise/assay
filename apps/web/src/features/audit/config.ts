import { Database, Gauge, SlidersHorizontal, Sparkles, Waves, type LucideIcon } from "lucide-react";

import type { AuditCheckId } from "@assay/contracts/audit-checks";

export interface CheckDefinition {
  id: AuditCheckId;
  icon: LucideIcon;
}

export const CHECK_DEFINITIONS: readonly CheckDefinition[] = [
  {
    id: "param-robustness",
    icon: SlidersHorizontal,
  },
  {
    id: "data-availability",
    icon: Database,
  },
  {
    id: "cost-stress",
    icon: Gauge,
  },
  {
    id: "regime-dependency",
    icon: Waves,
  },
  {
    id: "homogeneity-decay",
    icon: Sparkles,
  },
] as const;
