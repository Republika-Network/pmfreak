# Personal Portfolio Intelligence

EPIC 5 — Personal Portfolio Intelligence gives each owner a curated, ranked view of their projects and synthesizes a daily Personal Command Center.

---

## Architecture

```
PortfolioProjectMetric[]  (input from Project OS / health data)
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  personal-portfolio-service.ts                                  │
│                                                                 │
│  Sprint 1: Foundation    createPersonalPortfolio()              │
│                          addProjectToPortfolio()                │
│                          removeProjectFromPortfolio()           │
│                          listPortfolioProjects()                │
│                          generatePortfolioSnapshot()            │
│                                                                 │
│  Sprint 2: Ranking       rankPortfolioProjects()                │
│                          calculatePortfolioAttentionScore()     │
│                                                                 │
│  Sprint 3: Attention     generateAttentionAllocation()          │
│                          calculateAttentionWeight()             │
│                                                                 │
│  Sprint 4: Neglect       analyzeProjectNeglect()                │
│                          generateNeglectConsequences()          │
│                                                                 │
│  Sprint 5: Command Ctr   generatePersonalCommandCenter()        │
│                          getTodayFocus()                        │
│                          getCriticalProjects()                  │
│                          generateRecommendedAgenda()            │
│                                                                 │
│  Explain                 explainPersonalPortfolioIntelligence() │
└─────────────────────────────────────────────────────────────────┘
        │
        ▼
  Supabase (personal_portfolios, personal_portfolio_projects,
            personal_portfolio_snapshots,
            personal_portfolio_attention_items)
        │
        ▼
  Platform Events  (governance category, actorType=user)
```

`generatePortfolioSnapshot()` orchestrates all five sprints in a single call: it computes ranking, attention allocation, neglect consequences, and command center payload before persisting the snapshot row. Sprints 2–5 are also exposed as standalone pure functions for independent use.

---

## Data Model

### `personal_portfolios`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| workspace_id | uuid | Workspace isolation |
| owner_id | uuid | Owner isolation — `auth.uid()` |
| name | text | Required |
| description | text \| null | |
| status | text | `active` \| `archived` |
| created_at | timestamptz | |
| updated_at | timestamptz | |

**Indexes:** `(workspace_id, owner_id)`, `(workspace_id, status)`

### `personal_portfolio_projects`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| workspace_id | uuid | |
| portfolio_id | uuid FK → personal_portfolios | |
| project_id | uuid | Reference to Project OS |
| added_at | timestamptz | |

**Unique constraint:** `(portfolio_id, project_id)` — prevents duplicates.

**Indexes:** `(workspace_id, portfolio_id)`, `(workspace_id, project_id)`

### `personal_portfolio_snapshots`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| workspace_id | uuid | |
| portfolio_id | uuid FK | |
| snapshot_status | text | `generated` \| `validated` \| `archived` |
| total_projects | int | |
| healthy_projects | int | |
| warning_projects | int | |
| critical_projects | int | |
| overall_health | int | 0–100, average of project healthScores |
| ranked_project_ids | uuid[] | Ordered by urgency score desc |
| attention_allocation | jsonb | `{projectId: percentage}` |
| neglect_consequences | jsonb | `{projectId: NeglectConsequence}` |
| command_center_payload | jsonb | Full `PersonalCommandCenterPayload` |
| snapshot_payload | jsonb | Raw metrics input |
| generated_at | timestamptz | |
| created_at | timestamptz | |

### `personal_portfolio_attention_items`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| workspace_id | uuid | |
| snapshot_id | uuid FK | |
| project_id | uuid | |
| attention_type | text | One of eight types below |
| severity | text | `low` \| `medium` \| `high` \| `critical` |
| title | string | |
| description | text \| null | |
| recommended_action | text \| null | |
| created_at | timestamptz | |

**Attention types:** `critical_signal`, `overdue_commitment`, `execution_drift`, `authority_gap`, `low_health_score`, `neglect_risk`, `capacity_conflict`, `escalation_pending`

---

## Service Layer

All service functions follow the `PersonalPortfolioResult<T>` discriminated union:

```typescript
type PersonalPortfolioResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; failureClass: string };
```

**Failure classes:** `validation_failed`, `not_found`, `persistence_failed`, `duplicate`

### Sprint 1: Foundation

| Function | Description |
|---|---|
| `createPersonalPortfolio(input)` | Create a portfolio. Validates workspaceId, ownerId, name. Emits `PERSONAL_PORTFOLIO_CREATED`. |
| `addProjectToPortfolio(input)` | Add a project. Returns `failureClass: "duplicate"` (HTTP 409) if already present. Emits `PERSONAL_PORTFOLIO_PROJECT_ADDED`. |
| `removeProjectFromPortfolio(input)` | Remove a project. Returns `failureClass: "not_found"` if not present. Emits `PERSONAL_PORTFOLIO_PROJECT_REMOVED`. |
| `listPortfolioProjects(input)` | List all projects in a portfolio, scoped by workspace. |
| `generatePortfolioSnapshot(input)` | Full snapshot: health counts + ranking + attention + neglect + command center. Persists to DB. Emits `PERSONAL_PORTFOLIO_SNAPSHOT_GENERATED`. |
| `listPortfolios(input)` | List active portfolios for an owner in a workspace. |
| `getPortfolio(input)` | Fetch a single portfolio by ID + workspaceId. |
| `getLatestPortfolioSnapshot(input)` | Fetch the most recent non-archived snapshot with its attention items. |

### Sprint 2: Ranking Model

Each project receives a 0–100 urgency score from six weighted factors:

| Factor | Weight | Source |
|---|---|---|
| Health deficit `(100 - healthScore)` | 30% | `healthScore` |
| Risk score | 20% | `riskScore` |
| Execution drift (overdue tasks × 8, max 100) | 15% | `overdueTaskCount` |
| Open decisions (count × 10, max 100) | 15% | `openDecisionsCount` |
| Open commitments (count × 10, max 100) | 10% | `openCommitmentsCount` |
| Critical focus items (count × 12, max 100) | 10% | `criticalFocusCount` |

Projects are sorted descending by score. Ties are deterministic (stable sort). Rank starts at 1.

| Function | Description |
|---|---|
| `rankPortfolioProjects(metrics)` | Returns a `PortfolioRanking` with ranked projects and score breakdowns. |
| `calculatePortfolioAttentionScore(metric)` | Returns the raw urgency score for a single project. |

### Sprint 3: Attention Allocation Model

Attention percentage is proportional to urgency score, with a **minimum floor of 5%** per project so no project is ever invisible.

```
rawPct = projectScore / totalScore * 100   (or 100/N if totalScore === 0)
allocPct = max(5, round(rawPct))
```

Justifications by score tier:

| Condition | Justification |
|---|---|
| rank === 1 | "Highest priority — requires immediate attention" |
| score >= 70 | "High urgency — significant risks or drift detected" |
| score >= 40 | "Moderate attention — monitor and unblock" |
| score < 40 | "Stable — routine check-in sufficient" |

Note: due to the minimum floor, the sum of percentages may slightly exceed 100 when there are many low-scoring projects.

| Function | Description |
|---|---|
| `generateAttentionAllocation(metrics)` | Returns an `AttentionAllocationPlan` with per-project allocations. |
| `calculateAttentionWeight(projectScore, totalScore)` | Pure helper returning raw weight percentage. |

### Sprint 4: Neglect Consequence Engine

A **read-only, pure analysis** of what happens if the owner neglects a project. Does not modify any entities.

```
blockedDeliverables = blockedTaskCount + openCommitmentsCount
healthImpact = -round((100 - healthScore) * 0.15 + overdueTaskCount * 3 + openDecisionsCount * 2)
escalationProbability = min(0.99,
  (100 - healthScore) * 0.006 +
  riskScore * 0.005 +
  overdueTaskCount * 0.04 +
  openDecisionsCount * 0.03
)
```

Severity thresholds:

| Condition | Severity |
|---|---|
| probability >= 0.75 OR status = "critical" | critical |
| probability >= 0.50 OR status = "warning" | high |
| probability >= 0.25 | medium |
| otherwise | low |

| Function | Description |
|---|---|
| `analyzeProjectNeglect(metric)` | Returns a `NeglectConsequence` for a single project. |
| `generateNeglectConsequences(metrics)` | Returns a `NeglectAnalysis` for the full portfolio, including `mostCriticalProjectId`. |

### Sprint 5: Personal Command Center

A **pure compute function** that produces a daily briefing. No side effects, no DB calls.

| Bucket | Description |
|---|---|
| `immediateAttention` | Focus items from critical-severity or status="critical" projects (max 10) |
| `highAttention` | Focus items from high-severity or status="warning" projects (max 10) |
| `recommendedOrder` | All projects ordered by urgency rank with attention % and top priority |
| `todaySummary` | Plain-language summary generated from criticalCount and totalProjects |

| Function | Description |
|---|---|
| `generatePersonalCommandCenter(input)` | Returns a full `PersonalCommandCenterPayload`. |
| `getTodayFocus(payload)` | Extracts `{critical, high}` from a payload. |
| `getCriticalProjects(metrics)` | Filters metrics to status="critical" projects. |
| `generateRecommendedAgenda(metrics)` | Returns ranked `CommandCenterAgendaItem[]`. |

---

## API Routes

All routes require authentication via `requireAuthenticatedUser()`. Unauthenticated requests return HTTP 401. All error responses have the shape `{ ok: false, error: string }`.

### `GET /api/personal-portfolio`

- No `portfolioId` param → returns `{ ok: true, portfolios: PersonalPortfolioRow[] }` (owner's active portfolios)
- With `portfolioId` param → returns `{ ok: true, snapshot: PersonalPortfolioSnapshot, provenance: "caller_supplied_unverified", note }` (404 if not found)
- Workspace: `workspaceId` query param or `user.companyId`

### `POST /api/personal-portfolio`

Body: `{ name: string, description?: string, workspaceId?: string }`

Returns: `{ ok: true, portfolio: PersonalPortfolioRow }` — HTTP 201

Errors: 400 if name is empty.

### `GET /api/personal-portfolio/projects`

Query: `portfolioId` (required), `workspaceId`

Returns: `{ ok: true, projects: PersonalPortfolioProjectRow[] }`

### `POST /api/personal-portfolio/projects`

Body: `{ portfolioId, projectId, workspaceId? }`

Returns: `{ ok: true, entry: PersonalPortfolioProjectRow }` — HTTP 201

Errors: 400 (missing params), 409 (duplicate)

### `DELETE /api/personal-portfolio/projects`

Body: `{ portfolioId, projectId, workspaceId? }`

Returns: `{ ok: true }`

Errors: 404 (not found)

### Retired in P2-17: `snapshot`, `prioritize`, `attention`, `neglect`, `command-center`

`POST /api/personal-portfolio/{snapshot,prioritize,attention,neglect,command-center}` used to accept
`projectMetrics: PortfolioProjectMetric[]` — healthScore, riskScore, status and task/decision counts —
from the request body and treat those values as truth (`snapshot` also persisted the results). No
server-side source can rebuild them without inventing a health metric, so the endpoints are retired
rather than re-sourced:

- Unauthenticated → HTTP 401, as before.
- Authenticated → HTTP 410 `{ ok: false, failureClass: "caller_metrics_not_accepted", error, replacement }`,
  returned before the body is read. No caller value reaches a computation or a table.

Snapshots persisted before retirement stay readable through `GET /api/personal-portfolio?portfolioId=…`
and are returned with `provenance: "caller_supplied_unverified"`. The pure engines below remain as a
bounded compatibility library. Server-derived portfolio attention — with coverage, confidence,
freshness and a membership snapshot — lives on the PMO Command Center
(`GET /api/pmos/{pmoId}/attention?workspaceId=…`, `src/lib/pmos/pmo-portfolio-attention.ts`).

---

## Owner Isolation

Every portfolio carries `owner_id = auth.uid()` at creation. The database enforces isolation via RLS:

```sql
create policy "portfolio_owner_access"
  on public.personal_portfolios
  for all
  to authenticated
  using (is_workspace_member(workspace_id) and owner_id = auth.uid());
```

The service layer additionally passes `ownerId` on all read queries (`listPortfolios`, `listPortfolioProjects`) as defense-in-depth. An owner cannot read, write, or reference another owner's portfolios.

---

## Workspace Isolation

All four tables carry `workspace_id`. Every query filters by `workspace_id` to prevent cross-tenant data leakage. RLS policies verify workspace membership via `is_workspace_member(workspace_id)`.

---

## Audit Events

All events use `eventCategory: "governance"`, `actorType: "user"`, `learningEligible: false`.

| Event | Trigger |
|---|---|
| `PERSONAL_PORTFOLIO_CREATED` | `createPersonalPortfolio()` — includes `name`, `ownerId` |
| `PERSONAL_PORTFOLIO_PROJECT_ADDED` | `addProjectToPortfolio()` — includes `projectId` |
| `PERSONAL_PORTFOLIO_PROJECT_REMOVED` | `removeProjectFromPortfolio()` — includes `projectId` |
| `PERSONAL_PORTFOLIO_SNAPSHOT_GENERATED` | `generatePortfolioSnapshot()` — includes `portfolioId`, `overallHealth`, `totalProjects` |
| `PERSONAL_PORTFOLIO_PRIORITIZED` | reserved in event type union |
| `PERSONAL_PORTFOLIO_ATTENTION_ALLOCATED` | reserved in event type union |
| `PERSONAL_PORTFOLIO_NEGLECT_ANALYZED` | reserved in event type union |
| `PERSONAL_PORTFOLIO_COMMAND_CENTER_GENERATED` | reserved in event type union |
| `PERSONAL_PORTFOLIO_SNAPSHOT_VALIDATED` | reserved in event type union |
| `PERSONAL_PORTFOLIO_SNAPSHOT_ARCHIVED` | reserved in event type union |
| `PERSONAL_PORTFOLIO_ARCHIVED` | reserved in event type union |

---

## Integration with Project OS

`PortfolioProjectMetric` is the integration contract between EPIC 5 and Project OS. Callers are responsible for fetching project health data from Project OS and mapping it into `PortfolioProjectMetric[]` before passing to EPIC 5 functions. EPIC 5 does not directly query project tables — it consumes pre-aggregated metrics. This keeps the boundary clean and avoids duplicating Project OS logic.

---

## Examples

### Create a portfolio and add a project

```typescript
const portfolio = await createPersonalPortfolio({
  workspaceId: "ws-uuid",
  ownerId: "user-uuid",
  name: "Q3 Focus",
  actorId: "user-uuid",
});

if (portfolio.ok) {
  await addProjectToPortfolio({
    workspaceId: "ws-uuid",
    portfolioId: portfolio.data.id,
    projectId: "proj-uuid",
    actorId: "user-uuid",
  });
}
```

### Generate a snapshot

```typescript
const snapshot = await generatePortfolioSnapshot({
  workspaceId: "ws-uuid",
  portfolioId: "port-uuid",
  actorId: "user-uuid",
  projectMetrics: [
    {
      projectId: "proj-uuid",
      projectName: "Platform Migration",
      healthScore: 45,
      riskScore: 72,
      blockedTaskCount: 3,
      overdueTaskCount: 5,
      openDecisionsCount: 2,
      openCommitmentsCount: 4,
      criticalFocusCount: 1,
      attentionItems: ["Overdue commitment: Q3 delivery", "Authority gap on architecture decision"],
      status: "warning",
    },
  ],
});
```

### Get today's command center focus

```typescript
const cc = generatePersonalCommandCenter({
  ownerId: "user-uuid",
  metrics: projectMetrics,
});
const { critical, high } = getTodayFocus(cc);
```

### Understand the system

```typescript
const explanation = explainPersonalPortfolioIntelligence();
console.log(explanation.concept);
console.log(explanation.ownerIsolation);
```
