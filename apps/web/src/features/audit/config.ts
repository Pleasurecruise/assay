import {
  Database,
  Gauge,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Waves,
  type LucideIcon,
} from "lucide-react";

import type { AuditCheckId } from "@assay/contracts/audit-checks";

export type AuditMode = "strategy" | "factor" | "compare";

export interface CheckDefinition {
  id: AuditCheckId;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
}

export const CHECK_DEFINITIONS: readonly CheckDefinition[] = [
  {
    id: "param-robustness",
    label: "Parameter robustness",
    shortLabel: "Parameters",
    icon: SlidersHorizontal,
  },
  {
    id: "data-availability",
    label: "Data availability",
    shortLabel: "Data",
    icon: Database,
  },
  {
    id: "cost-stress",
    label: "Transaction cost stress",
    shortLabel: "Costs",
    icon: Gauge,
  },
  {
    id: "regime-dependency",
    label: "Market regime dependency",
    shortLabel: "Regimes",
    icon: Waves,
  },
  {
    id: "homogeneity-decay",
    label: "Homogeneity and decay",
    shortLabel: "Decay",
    icon: Sparkles,
  },
] as const;

export const MODE_OPTIONS: readonly {
  id: AuditMode;
  label: string;
  disabled: boolean;
  icon: LucideIcon;
}[] = [
  { id: "strategy", label: "Strategy", disabled: false, icon: ShieldCheck },
  { id: "factor", label: "Factor", disabled: true, icon: Sparkles },
  { id: "compare", label: "Compare", disabled: true, icon: Waves },
] as const;
