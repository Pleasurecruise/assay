/**
 * The two-check real-data runner is intentionally archived.
 *
 * data-availability, regime-dependency, and homogeneity-decay now receive
 * deterministic instruments in v9, so the former UNVERIFIABLE golden must
 * never be used as an acceptance gate or refresh target. Its immutable output
 * remains under artifacts/archive for historical mechanism comparison.
 */
export const PRE_PIT_ARCHIVE_FIXTURE = "artifacts/archive/assay-pre-pit-real-data-run.json";

if (import.meta.main) {
  throw new Error("The pre-PIT two-check E2E is archived; run the v9 terminal acceptance instead.");
}
