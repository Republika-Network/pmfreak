import type { SubscriptionPlan } from "@/lib/billing";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getUploadLimit } from "@/lib/feature-gates";

export { canExportReports, canInviteTeamMembers, canRunAiAnalysis, canUsePortfolioMemory } from "@/lib/plan-access";
export type CompanyUsageState = { currentMonth: string; uploadCount: number };
const getCurrentMonthKey = () => { const now = new Date(); return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`; };
const defaultUsage = (): CompanyUsageState => ({ currentMonth: getCurrentMonthKey(), uploadCount: 0 });
const normalizeUsage = (row: { current_month: unknown; upload_count: unknown }): CompanyUsageState => ({ currentMonth: typeof row.current_month === "string" && row.current_month.length > 0 ? row.current_month : getCurrentMonthKey(), uploadCount: typeof row.upload_count === "number" ? row.upload_count : 0 });
// Read-only. company_usage is written only by the server-side quota RPCs
// (src/lib/quota/upload-quota.ts); clients have no write privilege on it (PR-2, F3). A missing
// row or a stale month is reported as a fresh month with zero uploads, exactly what the next
// reservation will record when reserve_upload_quota initializes or rolls the row over.
export const getCompanyUsage = async (companyId: string): Promise<CompanyUsageState> => { const supabase = await createSupabaseServerClient(); const { data, error } = await supabase.from("company_usage").select("current_month, upload_count").eq("company_id", companyId).maybeSingle(); if (error) throw new Error(`Unable to read company usage: ${error.message}`); if (!data) return defaultUsage(); const usage = normalizeUsage(data); return usage.currentMonth === getCurrentMonthKey() ? usage : defaultUsage(); };
export const canUploadDocuments = (plan: SubscriptionPlan, currentUploadCount: number, incomingCount = 1) => { const limit = getUploadLimit(plan); return limit === null ? true : currentUploadCount + incomingCount <= limit; };
export const getUploadLimitForPlan = (plan: SubscriptionPlan) => getUploadLimit(plan);
