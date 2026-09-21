import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// ── File existence ─────────────────────────────────────────────────────────────

const serviceTs = fs.readFileSync("src/lib/personal-portfolio/personal-portfolio-service.ts", "utf8");
const typesTs   = fs.readFileSync("src/lib/personal-portfolio/types.ts", "utf8");
const indexTs   = fs.readFileSync("src/lib/personal-portfolio/index.ts", "utf8");

const routeMain        = fs.readFileSync("src/app/api/personal-portfolio/route.ts", "utf8");
const routeProjects    = fs.readFileSync("src/app/api/personal-portfolio/projects/route.ts", "utf8");
const routeSnapshot    = fs.readFileSync("src/app/api/personal-portfolio/snapshot/route.ts", "utf8");
const routePrioritize  = fs.readFileSync("src/app/api/personal-portfolio/prioritize/route.ts", "utf8");
const routeAttention   = fs.readFileSync("src/app/api/personal-portfolio/attention/route.ts", "utf8");
const routeNeglect     = fs.readFileSync("src/app/api/personal-portfolio/neglect/route.ts", "utf8");
const routeCommandCenter = fs.readFileSync("src/app/api/personal-portfolio/command-center/route.ts", "utf8");

const migrationSql = fs.readFileSync(
  "supabase/migrations/20260714000000_personal_portfolio_foundation.sql",
  "utf8",
);

const docsMd = fs.readFileSync("docs/personal-portfolio-intelligence.md", "utf8");

// ── Types ──────────────────────────────────────────────────────────────────────

test("types: declares PersonalPortfolioRow", () => {
  assert.match(typesTs, /PersonalPortfolioRow/);
});

test("types: declares PersonalPortfolioProjectRow", () => {
  assert.match(typesTs, /PersonalPortfolioProjectRow/);
});

test("types: declares PersonalPortfolioSnapshotRow", () => {
  assert.match(typesTs, /PersonalPortfolioSnapshotRow/);
});

test("types: declares PersonalPortfolioAttentionItemRow", () => {
  assert.match(typesTs, /PersonalPortfolioAttentionItemRow/);
});

test("types: declares PortfolioProjectMetric", () => {
  assert.match(typesTs, /PortfolioProjectMetric/);
});

test("types: declares PersonalPortfolioResult<T>", () => {
  assert.match(typesTs, /PersonalPortfolioResult/);
});

test("types: Result is discriminated union with ok:true/ok:false", () => {
  assert.match(typesTs, /ok: true/);
  assert.match(typesTs, /ok: false/);
});

test("types: declares PortfolioRanking", () => {
  assert.match(typesTs, /PortfolioRanking/);
});

test("types: declares AttentionAllocationPlan", () => {
  assert.match(typesTs, /AttentionAllocationPlan/);
});

test("types: declares NeglectAnalysis", () => {
  assert.match(typesTs, /NeglectAnalysis/);
});

test("types: declares PersonalCommandCenterPayload", () => {
  assert.match(typesTs, /PersonalCommandCenterPayload/);
});

test("types: declares PersonalPortfolioEventType union", () => {
  assert.match(typesTs, /PersonalPortfolioEventType/);
});

test("types: event PERSONAL_PORTFOLIO_CREATED declared", () => {
  assert.match(typesTs, /PERSONAL_PORTFOLIO_CREATED/);
});

test("types: event PERSONAL_PORTFOLIO_PROJECT_ADDED declared", () => {
  assert.match(typesTs, /PERSONAL_PORTFOLIO_PROJECT_ADDED/);
});

test("types: event PERSONAL_PORTFOLIO_PROJECT_REMOVED declared", () => {
  assert.match(typesTs, /PERSONAL_PORTFOLIO_PROJECT_REMOVED/);
});

test("types: event PERSONAL_PORTFOLIO_SNAPSHOT_GENERATED declared", () => {
  assert.match(typesTs, /PERSONAL_PORTFOLIO_SNAPSHOT_GENERATED/);
});

test("types: event PERSONAL_PORTFOLIO_PRIORITIZED declared", () => {
  assert.match(typesTs, /PERSONAL_PORTFOLIO_PRIORITIZED/);
});

test("types: event PERSONAL_PORTFOLIO_ATTENTION_ALLOCATED declared", () => {
  assert.match(typesTs, /PERSONAL_PORTFOLIO_ATTENTION_ALLOCATED/);
});

test("types: event PERSONAL_PORTFOLIO_NEGLECT_ANALYZED declared", () => {
  assert.match(typesTs, /PERSONAL_PORTFOLIO_NEGLECT_ANALYZED/);
});

test("types: event PERSONAL_PORTFOLIO_COMMAND_CENTER_GENERATED declared", () => {
  assert.match(typesTs, /PERSONAL_PORTFOLIO_COMMAND_CENTER_GENERATED/);
});

// ── Sprint 1: Foundation ───────────────────────────────────────────────────────

test("foundation: exports createPersonalPortfolio", () => {
  assert.match(serviceTs, /export async function createPersonalPortfolio/);
});

test("foundation: exports listPortfolios", () => {
  assert.match(serviceTs, /export async function listPortfolios/);
});

test("foundation: exports addProjectToPortfolio", () => {
  assert.match(serviceTs, /export async function addProjectToPortfolio/);
});

test("foundation: exports removeProjectFromPortfolio", () => {
  assert.match(serviceTs, /export async function removeProjectFromPortfolio/);
});

test("foundation: exports listPortfolioProjects", () => {
  assert.match(serviceTs, /export async function listPortfolioProjects/);
});

test("foundation: createPersonalPortfolio validates workspaceId", () => {
  assert.match(serviceTs, /validUuid\(input\.workspaceId\)/);
});

test("foundation: createPersonalPortfolio validates ownerId", () => {
  assert.match(serviceTs, /validUuid\(input\.ownerId\)/);
});

test("foundation: createPersonalPortfolio validates name is required", () => {
  assert.match(serviceTs, /required\(input\.name\)/);
});

test("foundation: addProjectToPortfolio validates portfolioId", () => {
  assert.match(serviceTs, /validUuid\(input\.portfolioId\)/);
});

test("foundation: addProjectToPortfolio validates projectId", () => {
  assert.match(serviceTs, /validUuid\(input\.projectId\)/);
});

test("foundation: duplicate project returns failureClass duplicate", () => {
  assert.match(serviceTs, /"duplicate"/);
  assert.match(serviceTs, /23505/);
});

test("foundation: removeProjectFromPortfolio checks not_found via count", () => {
  assert.match(serviceTs, /not_found/);
  assert.match(serviceTs, /count.*0|0.*count/);
});

test("foundation: listPortfolios filters by workspace_id and owner_id", () => {
  assert.match(serviceTs, /eq\("workspace_id", input\.workspaceId\)/);
  assert.match(serviceTs, /eq\("owner_id", input\.ownerId\)/);
});

test("foundation: listPortfolios filters by active status", () => {
  assert.match(serviceTs, /eq\("status", "active"\)/);
});

test("foundation: createPersonalPortfolio emits PERSONAL_PORTFOLIO_CREATED event", () => {
  assert.match(serviceTs, /PERSONAL_PORTFOLIO_CREATED/);
});

test("foundation: addProjectToPortfolio emits PERSONAL_PORTFOLIO_PROJECT_ADDED event", () => {
  assert.match(serviceTs, /PERSONAL_PORTFOLIO_PROJECT_ADDED/);
});

test("foundation: removeProjectFromPortfolio emits PERSONAL_PORTFOLIO_PROJECT_REMOVED event", () => {
  assert.match(serviceTs, /PERSONAL_PORTFOLIO_PROJECT_REMOVED/);
});

// ── Sprint 1: Snapshot ─────────────────────────────────────────────────────────

test("snapshot: exports generatePortfolioSnapshot", () => {
  assert.match(serviceTs, /export async function generatePortfolioSnapshot/);
});

test("snapshot: validates portfolioId uuid", () => {
  assert.match(serviceTs, /validUuid\(input\.portfolioId\)/);
});

test("snapshot: computes total_projects from metrics length", () => {
  assert.match(serviceTs, /totalProjects.*metrics\.length|metrics\.length.*totalProjects/);
});

test("snapshot: counts healthy projects by status=healthy", () => {
  assert.match(serviceTs, /status.*===.*"healthy"/);
});

test("snapshot: counts warning projects by status=warning", () => {
  assert.match(serviceTs, /status.*===.*"warning"/);
});

test("snapshot: counts critical projects by status=critical", () => {
  assert.match(serviceTs, /status.*===.*"critical"/);
});

test("snapshot: overallHealth is averaged healthScore rounded to integer", () => {
  assert.match(serviceTs, /Math\.round.*healthScore/);
});

test("snapshot: overallHealth defaults to 100 when no projects", () => {
  assert.match(serviceTs, /totalProjects > 0[\s\S]*?100/);
});

test("snapshot: emits PERSONAL_PORTFOLIO_SNAPSHOT_GENERATED event", () => {
  assert.match(serviceTs, /PERSONAL_PORTFOLIO_SNAPSHOT_GENERATED/);
});

test("snapshot: persists attention items in personal_portfolio_attention_items table", () => {
  assert.match(serviceTs, /personal_portfolio_attention_items/);
});

test("snapshot: snapshot_status is set to generated on creation", () => {
  assert.match(serviceTs, /snapshot_status.*"generated"/);
});

// ── Sprint 2: Prioritization ──────────────────────────────────────────────────

test("prioritization: exports rankPortfolioProjects", () => {
  assert.match(serviceTs, /export function rankPortfolioProjects/);
});

test("prioritization: exports calculatePortfolioAttentionScore", () => {
  assert.match(serviceTs, /export function calculatePortfolioAttentionScore/);
});

test("prioritization: health contributes 30% of score", () => {
  assert.match(serviceTs, /\* 0\.30/);
});

test("prioritization: risk contributes 20% of score", () => {
  assert.match(serviceTs, /riskContribution.*\* 0\.20|0\.20.*riskContribution/);
});

test("prioritization: drift contributes 15% of score", () => {
  assert.match(serviceTs, /driftContribution.*0\.15|0\.15.*overdueTaskCount/);
});

test("prioritization: decisions contribute 15% of score", () => {
  assert.match(serviceTs, /decisionsContribution.*0\.15/);
});

test("prioritization: commitments contribute 10% of score", () => {
  assert.match(serviceTs, /commitmentsContribution.*0\.10/);
});

test("prioritization: criticalFocus contributes 10% of score", () => {
  assert.match(serviceTs, /criticalFocusContribution.*0\.10/);
});

test("prioritization: score is rounded to integer", () => {
  assert.match(serviceTs, /Math\.round\(score\)/);
});

test("prioritization: projects are sorted descending by score", () => {
  assert.match(serviceTs, /b\.score - a\.score/);
});

test("prioritization: rank starts at 1", () => {
  assert.match(serviceTs, /rank: i \+ 1/);
});

test("prioritization: score capped via Math.min for overdueTaskCount", () => {
  assert.match(serviceTs, /Math\.min\(100, m\.overdueTaskCount/);
});

test("prioritization: breakdown object includes all six contributions", () => {
  assert.match(serviceTs, /healthContribution/);
  assert.match(serviceTs, /riskContribution/);
  assert.match(serviceTs, /driftContribution/);
  assert.match(serviceTs, /decisionsContribution/);
  assert.match(serviceTs, /commitmentsContribution/);
  assert.match(serviceTs, /criticalFocusContribution/);
});

// ── Sprint 3: Attention Allocation ────────────────────────────────────────────

test("attention: exports generateAttentionAllocation", () => {
  assert.match(serviceTs, /export function generateAttentionAllocation/);
});

test("attention: exports calculateAttentionWeight", () => {
  assert.match(serviceTs, /export function calculateAttentionWeight/);
});

test("attention: minimum floor of 5% enforced per project", () => {
  assert.match(serviceTs, /Math\.max\(5,/);
});

test("attention: allocation is proportional to project score / total score", () => {
  assert.match(serviceTs, /r\.score \/ totalScore/);
});

test("attention: equal distribution when totalScore is 0", () => {
  assert.match(serviceTs, /100 \/ ranking\.length/);
});

test("attention: rank-1 project justification is immediate attention", () => {
  assert.match(serviceTs, /Highest priority.*immediate attention/);
});

test("attention: score>=70 justification is high urgency", () => {
  assert.match(serviceTs, /High urgency/);
});

test("attention: score>=40 justification is moderate attention", () => {
  assert.match(serviceTs, /Moderate attention/);
});

test("attention: stable justification for low-score projects", () => {
  assert.match(serviceTs, /Stable.*routine check-in/);
});

test("attention: calculateAttentionWeight returns 0 when totalScore is 0", () => {
  assert.match(serviceTs, /if \(totalScore === 0\) return 0/);
});

// ── Sprint 4: Neglect Consequence Engine ─────────────────────────────────────

test("neglect: exports analyzeProjectNeglect", () => {
  assert.match(serviceTs, /export function analyzeProjectNeglect/);
});

test("neglect: exports generateNeglectConsequences", () => {
  assert.match(serviceTs, /export function generateNeglectConsequences/);
});

test("neglect: blockedDeliverables = blockedTaskCount + openCommitmentsCount", () => {
  assert.match(serviceTs, /m\.blockedTaskCount \+ m\.openCommitmentsCount/);
});

test("neglect: escalationProbability is capped at 0.99", () => {
  assert.match(serviceTs, /Math\.min\(\s*0\.99/);
});

test("neglect: critical severity when probability >= 0.75 or status is critical", () => {
  assert.match(serviceTs, /0\.75/);
  assert.match(serviceTs, /m\.status === "critical"/);
});

test("neglect: high severity when probability >= 0.50 or status is warning", () => {
  assert.match(serviceTs, /0\.50/);
  assert.match(serviceTs, /m\.status === "warning"/);
});

test("neglect: medium severity when probability >= 0.25", () => {
  assert.match(serviceTs, /0\.25/);
});

test("neglect: generateNeglectConsequences finds most critical project", () => {
  assert.match(serviceTs, /mostCriticalProjectId/);
  assert.match(serviceTs, /severity === "critical"/);
});

test("neglect: analyzeProjectNeglect does not perform DB writes", () => {
  // analyzeProjectNeglect delegates to computeNeglectConsequence which is pure
  const fnStart = serviceTs.indexOf("export function analyzeProjectNeglect");
  const fnEnd = serviceTs.indexOf("\nexport function", fnStart + 1);
  const fnBody = serviceTs.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
  assert.doesNotMatch(fnBody, /\.insert\(|\.update\(|\.delete\(/);
});

test("neglect: generateNeglectConsequences does not perform DB writes", () => {
  const fnStart = serviceTs.indexOf("export function generateNeglectConsequences");
  const fnEnd = serviceTs.indexOf("\nexport function", fnStart + 1);
  const fnBody = serviceTs.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
  assert.doesNotMatch(fnBody, /\.insert\(|\.update\(|\.delete\(/);
});

// ── Sprint 5: Personal Command Center ─────────────────────────────────────────

test("command-center: exports generatePersonalCommandCenter", () => {
  assert.match(serviceTs, /export function generatePersonalCommandCenter/);
});

test("command-center: exports getTodayFocus", () => {
  assert.match(serviceTs, /export function getTodayFocus/);
});

test("command-center: exports getCriticalProjects", () => {
  assert.match(serviceTs, /export function getCriticalProjects/);
});

test("command-center: exports generateRecommendedAgenda", () => {
  assert.match(serviceTs, /export function generateRecommendedAgenda/);
});

test("command-center: immediateAttention limited to 10 items", () => {
  assert.match(serviceTs, /immediateAttention\.slice\(0, 10\)/);
});

test("command-center: highAttention limited to 10 items", () => {
  assert.match(serviceTs, /highAttention\.slice\(0, 10\)/);
});

test("command-center: todaySummary mentions criticalCount when > 0", () => {
  assert.match(serviceTs, /criticalCount > 0/);
  assert.match(serviceTs, /require immediate attention today/);
});

test("command-center: recommendedOrder follows ranking order", () => {
  assert.match(serviceTs, /recommendedOrder.*ranking\.map|ranking\.map.*recommendedOrder/s);
});

test("command-center: getCriticalProjects filters by status=critical", () => {
  assert.match(serviceTs, /m\.status === "critical"/);
});

test("command-center: getTodayFocus returns critical and high buckets", () => {
  assert.match(serviceTs, /critical: payload\.immediateAttention/);
  assert.match(serviceTs, /high: payload\.highAttention/);
});

test("command-center: payload includes generatedAt timestamp", () => {
  assert.match(serviceTs, /generatedAt.*new Date\(\)\.toISOString\(\)/);
});

test("command-center: generatePersonalCommandCenter is a pure function (no DB calls)", () => {
  const fnStart = serviceTs.indexOf("export function generatePersonalCommandCenter");
  const fnEnd = serviceTs.indexOf("\nexport function", fnStart + 1);
  const fnBody = serviceTs.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
  assert.doesNotMatch(fnBody, /createSupabaseServerClient|\.insert\(|\.update\(/);
});

// ── Audit / Event emission ─────────────────────────────────────────────────────

test("audit: emitPortfolioEvent uses eventCategory=governance", () => {
  assert.match(serviceTs, /eventCategory.*"governance"/);
});

test("audit: emitPortfolioEvent sets actorType=user", () => {
  assert.match(serviceTs, /actorType.*"user"/);
});

test("audit: emitPortfolioEvent includes entityId in payload", () => {
  assert.match(serviceTs, /entityId,/);
});

test("audit: learningEligible is false for portfolio events", () => {
  assert.match(serviceTs, /learningEligible: false/);
});

test("audit: snapshot generation emits event with overallHealth metadata", () => {
  assert.match(serviceTs, /overallHealth,.*totalProjects|totalProjects.*overallHealth/s);
});

// ── Owner / Workspace isolation ───────────────────────────────────────────────

test("isolation: createPersonalPortfolio inserts workspace_id", () => {
  assert.match(serviceTs, /workspace_id: input\.workspaceId/);
});

test("isolation: createPersonalPortfolio inserts owner_id", () => {
  assert.match(serviceTs, /owner_id: input\.ownerId/);
});

test("isolation: listPortfolios filters by both workspace_id and owner_id", () => {
  const fn = serviceTs.slice(serviceTs.indexOf("export async function listPortfolios"));
  assert.match(fn, /workspace_id.*ownerId|ownerId.*workspace_id/s);
});

test("isolation: getLatestPortfolioSnapshot filters by workspace_id", () => {
  assert.match(serviceTs, /getLatestPortfolioSnapshot[\s\S]*?workspace_id/);
});

test("isolation: listPortfolioProjects filters by workspace_id", () => {
  assert.match(serviceTs, /listPortfolioProjects[\s\S]*?workspace_id/);
});

test("isolation: removeProjectFromPortfolio filters delete by workspace_id", () => {
  const fn = serviceTs.slice(serviceTs.indexOf("export async function removeProjectFromPortfolio"));
  assert.match(fn, /workspace_id.*input\.workspaceId/);
});

// ── Index re-exports ───────────────────────────────────────────────────────────

test("index: re-exports createPersonalPortfolio", () => {
  assert.match(indexTs, /createPersonalPortfolio/);
});

test("index: re-exports generatePortfolioSnapshot", () => {
  assert.match(indexTs, /generatePortfolioSnapshot/);
});

test("index: re-exports rankPortfolioProjects", () => {
  assert.match(indexTs, /rankPortfolioProjects/);
});

test("index: re-exports generateAttentionAllocation", () => {
  assert.match(indexTs, /generateAttentionAllocation/);
});

test("index: re-exports generateNeglectConsequences", () => {
  assert.match(indexTs, /generateNeglectConsequences/);
});

test("index: re-exports generatePersonalCommandCenter", () => {
  assert.match(indexTs, /generatePersonalCommandCenter/);
});

test("index: re-exports explainPersonalPortfolioIntelligence", () => {
  assert.match(indexTs, /explainPersonalPortfolioIntelligence/);
});

// ── API: main route ────────────────────────────────────────────────────────────

test("api/personal-portfolio: exports GET", () => {
  assert.match(routeMain, /export async function GET/);
});

test("api/personal-portfolio: exports POST", () => {
  assert.match(routeMain, /export async function POST/);
});

test("api/personal-portfolio: POST returns 201 on success", () => {
  assert.match(routeMain, /status: 201/);
});

test("api/personal-portfolio: GET returns snapshot when portfolioId provided", () => {
  assert.match(routeMain, /snapshot.*snapshotResult\.data/);
});

test("api/personal-portfolio: GET returns portfolios list when no portfolioId", () => {
  assert.match(routeMain, /portfolios.*listResult\.data/);
});

test("api/personal-portfolio: 401 on unauthenticated", () => {
  assert.match(routeMain, /status.*401/);
});

test("api/personal-portfolio: 400 when portfolio name is empty", () => {
  assert.match(routeMain, /Portfolio name is required/);
});

test("api/personal-portfolio: error response shape has ok:false and error field", () => {
  assert.match(routeMain, /ok: false.*error|error.*ok: false/s);
});

// ── API: projects route ────────────────────────────────────────────────────────

test("api/personal-portfolio/projects: exports GET, POST, DELETE", () => {
  assert.match(routeProjects, /export async function GET/);
  assert.match(routeProjects, /export async function POST/);
  assert.match(routeProjects, /export async function DELETE/);
});

test("api/personal-portfolio/projects: GET requires portfolioId param", () => {
  assert.match(routeProjects, /portfolioId is required/);
});

test("api/personal-portfolio/projects: POST requires portfolioId and projectId", () => {
  assert.match(routeProjects, /portfolioId and projectId are required/);
});

test("api/personal-portfolio/projects: POST returns 409 on duplicate", () => {
  assert.match(routeProjects, /409/);
  assert.match(routeProjects, /"duplicate"/);
});

test("api/personal-portfolio/projects: DELETE returns 404 when project not found", () => {
  assert.match(routeProjects, /404/);
  assert.match(routeProjects, /not_found/);
});

test("api/personal-portfolio/projects: POST returns 201 on success", () => {
  assert.match(routeProjects, /status: 201/);
});

// ── API: retired caller-metric routes (P2-17) ──────────────────────────────────
//
// snapshot, prioritize, attention, neglect and command-center used to compute on
// caller-supplied `projectMetrics` (healthScore, riskScore, status, counts) and treat
// them as truth — `snapshot` even persisted the results. P2-17 retired them: each
// authenticates, then refuses with 410 before the body is read. The executed 410
// behaviour is proven in tests/module-mocks/p2-17-personal-portfolio-caller-metrics.test.mjs;
// these scans pin that no route can quietly start reading the body again.

const retiredRoutes = {
  snapshot: routeSnapshot,
  prioritize: routePrioritize,
  attention: routeAttention,
  neglect: routeNeglect,
  "command-center": routeCommandCenter,
};

for (const [name, source] of Object.entries(retiredRoutes)) {
  test(`api/personal-portfolio/${name}: exports POST`, () => {
    assert.match(source, /export async function POST\(\)/);
  });

  test(`api/personal-portfolio/${name}: authenticates, then refuses caller metrics`, () => {
    assert.match(source, /requireAuthenticatedUser\(\)/);
    assert.match(source, /status: 401/);
    assert.match(source, /return callerMetricsRetiredResponse\(\)/);
  });

  test(`api/personal-portfolio/${name}: never reads the request body or calls a metric engine`, () => {
    assert.doesNotMatch(source, /request\.json\(|body\.projectMetrics|PortfolioProjectMetric/);
    assert.doesNotMatch(source, /from "@\/lib\/personal-portfolio"/);
    assert.doesNotMatch(source, /generatePortfolioSnapshot|rankPortfolioProjects|generateAttentionAllocation|generateNeglectConsequences|generatePersonalCommandCenter/);
  });
}

test("api/personal-portfolio: the refusal is a 410 with a stable failure class", () => {
  const retired = fs.readFileSync("src/lib/personal-portfolio/caller-metrics-retired.ts", "utf8");
  assert.match(retired, /status: 410/);
  assert.match(retired, /CALLER_METRICS_FAILURE_CLASS = "caller_metrics_not_accepted"/);
});

test("api/personal-portfolio: legacy snapshots are served labelled as caller-supplied", () => {
  assert.match(routeMain, /LEGACY_SNAPSHOT_PROVENANCE/);
});

// ── Database schema ────────────────────────────────────────────────────────────

test("schema: personal_portfolios table exists", () => {
  assert.match(migrationSql, /personal_portfolios/);
});

test("schema: personal_portfolio_projects table exists", () => {
  assert.match(migrationSql, /personal_portfolio_projects/);
});

test("schema: personal_portfolio_snapshots table exists", () => {
  assert.match(migrationSql, /personal_portfolio_snapshots/);
});

test("schema: personal_portfolio_attention_items table exists", () => {
  assert.match(migrationSql, /personal_portfolio_attention_items/);
});

test("schema: RLS enabled on personal_portfolios", () => {
  assert.match(migrationSql, /enable row level security[\s\S]*?personal_portfolios|personal_portfolios[\s\S]*?enable row level security/i);
});

test("schema: owner_id column exists in personal_portfolios", () => {
  assert.match(migrationSql, /owner_id/);
});

test("schema: workspace_id column exists across tables", () => {
  const count = (migrationSql.match(/workspace_id/g) ?? []).length;
  assert.ok(count >= 4, `Expected workspace_id in all tables, found ${count} occurrences`);
});

test("schema: unique constraint prevents duplicate projects in same portfolio", () => {
  assert.match(migrationSql, /unique.*portfolio_id.*project_id|unique.*project_id.*portfolio_id/si);
});

test("schema: personal_portfolios has status column", () => {
  assert.match(migrationSql, /status.*text|text.*status/);
});

test("schema: portfolio_owner_access RLS policy exists", () => {
  assert.match(migrationSql, /portfolio_owner_access/);
});

// ── Explain capability ─────────────────────────────────────────────────────────

test("explain: explainPersonalPortfolioIntelligence exported from index", () => {
  assert.match(indexTs, /explainPersonalPortfolioIntelligence/);
});

test("explain: explainPersonalPortfolioIntelligence defined in service", () => {
  assert.match(serviceTs, /explainPersonalPortfolioIntelligence/);
});

test("explain: description includes Personal Portfolio concept", () => {
  assert.match(serviceTs, /Personal Portfolio/);
});

test("explain: description covers ranking model", () => {
  assert.match(serviceTs, /[Rr]anking|[Pp]rioritiz/);
});

test("explain: description covers attention allocation", () => {
  assert.match(serviceTs, /[Aa]ttention [Aa]llocation/);
});

test("explain: description covers neglect consequences", () => {
  assert.match(serviceTs, /[Nn]eglect/);
});

test("explain: description covers owner isolation", () => {
  assert.match(serviceTs, /[Oo]wner/);
});

test("explain: description covers command center", () => {
  assert.match(serviceTs, /[Cc]ommand [Cc]enter/);
});

// ── Documentation ──────────────────────────────────────────────────────────────

test("docs: personal-portfolio-intelligence.md exists", () => {
  assert.ok(fs.existsSync("docs/personal-portfolio-intelligence.md"));
});

test("docs: includes Architecture section", () => {
  assert.match(docsMd, /## Architecture|# Architecture/);
});

test("docs: includes Data Model section", () => {
  assert.match(docsMd, /## Data Model|# Data Model/);
});

test("docs: includes Service Layer section", () => {
  assert.match(docsMd, /## Service Layer|# Service Layer/);
});

test("docs: includes API Routes section", () => {
  assert.match(docsMd, /## API Routes|# API Routes/);
});

test("docs: covers owner isolation", () => {
  assert.match(docsMd, /[Oo]wner [Ii]solation|owner_id/);
});

test("docs: covers workspace isolation", () => {
  assert.match(docsMd, /[Ww]orkspace [Ii]solation|workspace_id/);
});

test("docs: covers attention allocation model", () => {
  assert.match(docsMd, /[Aa]ttention [Aa]llocation/);
});

test("docs: covers ranking model", () => {
  assert.match(docsMd, /[Rr]anking|[Pp]rioritiz/);
});

test("docs: covers neglect model", () => {
  assert.match(docsMd, /[Nn]eglect/);
});

test("docs: covers command center model", () => {
  assert.match(docsMd, /[Cc]ommand [Cc]enter/);
});

test("docs: covers audit events", () => {
  assert.match(docsMd, /[Aa]udit/);
});
