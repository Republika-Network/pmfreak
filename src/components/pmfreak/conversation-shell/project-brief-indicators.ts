import type { OperationalGovernanceBrief } from "@/lib/projects/first-insight";

export type BriefIndicator = { key: "risks" | "issues" | "gaps"; label: string; tone: "danger" | "task" | "approval" };

/**
 * The project's latest governance brief, reduced to the three counts the
 * Command Center's project list used to badge (high/critical execution risks,
 * detected RAID issues, governance gaps). CHAT-SHELL-01 removed that inner list;
 * the counts now sit, small, in the conversation header. Only non-zero counts are
 * shown, and each is exactly the brief's own number — no score, no rollup. With
 * no brief there are no indicators, never zeros: "no brief yet" is not "clear".
 */
export function projectBriefIndicators(brief: OperationalGovernanceBrief | null): BriefIndicator[] {
  if (!brief) return [];
  const highRisks = brief.topExecutionRisks.filter((risk) => risk.severity === "high" || risk.severity === "critical").length;
  const issues = brief.detectedRaidOverview.snapshot.issues;
  const gaps = brief.governanceGaps.length;
  const indicators: BriefIndicator[] = [];
  if (highRisks > 0) indicators.push({ key: "risks", tone: "danger", label: `${highRisks} high risk${highRisks === 1 ? "" : "s"}` });
  if (issues > 0) indicators.push({ key: "issues", tone: "task", label: `${issues} issue${issues === 1 ? "" : "s"}` });
  if (gaps > 0) indicators.push({ key: "gaps", tone: "approval", label: `${gaps} governance gap${gaps === 1 ? "" : "s"}` });
  return indicators;
}
