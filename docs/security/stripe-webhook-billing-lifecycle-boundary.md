# Stripe webhook / billing lifecycle trust boundary

Trust boundary for `POST /api/billing/webhook` — the only endpoint where an
unauthenticated, internet-facing request is allowed to mutate
`company_subscriptions`. Companion to
[`billing-authorization-boundary.md`](./billing-authorization-boundary.md)
(Perilla 2), which hardened checkout-session/portal-session creation but
explicitly scoped webhook handling out: *"`POST /api/billing/webhook` is
Stripe-authenticated (webhook secret), not user-role-authenticated, and is
out of scope."* This document closes that scope gap.

**Webhook verification happens before any service-role access.**

## The vulnerability this closes

Perilla 2 made checkout-session creation depend on `workspace_memberships.role`
instead of display role/metadata. But the billing lifecycle does not end at
checkout — Stripe calls back asynchronously via webhooks
(`checkout.session.completed`, `customer.subscription.*`, `invoice.*`) to
activate, update, or cancel a subscription. Before this fix:

- `companyIdFromSubscription()` read `subscription.metadata.companyId`
  **first**, falling back to the server-side customer→company lookup only if
  metadata was absent. Metadata was trusted ahead of the authoritative
  mapping instead of being validated against it.
- The idempotency guard (`tryRecordProcessedBillingWebhookEvent`) inserted a
  `billing_webhook_events` row *before* processing ran. If processing then
  threw, the event was already marked "seen" — a genuine transient failure
  permanently blocked Stripe's automatic retry from ever being reprocessed,
  with no distinction between "applied successfully" and "crashed mid-way."
- An unknown Stripe price id silently downgraded the plan to `"free"` while
  still writing whatever subscription status Stripe sent — an inconsistent,
  partially-trusted state (e.g. `status: "active"` on a `"free"` plan) rather
  than refusing to activate.
- `invoice.paid` / `invoice.payment_failed` had no explicit handling at all.
- There was no cross-check between the subscription id already on record for
  a company and the customer id on an incoming event, so a
  customer-id/subscription-id mismatch would not be detected.

None of these were exploitable without a valid Stripe signature (the
signature check itself was already correct), but they violated the same
principle Perilla 2 established: **a trust boundary must be authorized from a
server-side record, not from data an external party supplied** — Stripe
metadata included.

## Endpoints in scope

| Endpoint | Auth model | What it does |
| --- | --- | --- |
| `POST /api/billing/webhook` | Stripe signature (`STRIPE_WEBHOOK_SECRET`), no user session | Verifies, deduplicates, maps, and applies Stripe billing lifecycle events to `company_subscriptions` |

`POST /api/billing/create-checkout-session` and
`POST /api/billing/create-portal-session` are covered by
`billing-authorization-boundary.md` and are unchanged by this fix, other than
that the metadata they write to Stripe (`companyId`, `plan`) is now
explicitly documented as a **hint only** — see below.

## Signature verification

`src/lib/stripe-webhook-verification.ts` exports `verifyStripeWebhookEvent()`:

```
verifyStripeWebhookEvent({ rawBody, signature, webhookSecret, stripeClient })
  → { ok: true, event }
  → { ok: false, reason: "missing_signature" | "missing_secret" | "invalid_signature" | "invalid_payload" }
```

It fails closed in every branch:

- No `webhookSecret` (`STRIPE_WEBHOOK_SECRET` unset) → `missing_secret`.
- No `stripe-signature` header → `missing_signature`.
- `stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)` throws
  (bad signature, tampered body, wrong secret, expired timestamp) →
  `invalid_signature`.
- Only a successful `constructEvent` call returns `{ ok: true, event }`.

The route (`src/app/api/billing/webhook/route.ts`) reads the body with
`request.text()` and passes that raw string straight into verification.
**`request.json()`/`JSON.parse()` is never called before verification** —
Stripe signs the exact byte sequence of the body, so parsing it first (even
just to peek at a field) would decouple "what we validate" from "what we act
on," and would make it possible to construct a body that parses differently
than it was signed.

## When the service-role client is instantiated

Never before verification succeeds. The route's order of operations:

```
1. rawBody = await request.text()
2. signature = request.headers.get("stripe-signature")
3. stripeClient = getStripeServerClient()      — Stripe SDK client, not a DB client
4. verifyStripeWebhookEvent(...)                — fails closed, see above
   → not ok: return 400, no DB client ever created
5. createPrivilegedSupabaseClient({ routeId, operation, reason, systemActor: "stripe_webhook" })
   — instantiated exactly once, reused for the rest of the request
6. beginBillingWebhookEventProcessing(...)      — idempotency claim
7. resolveStripeBillingLifecycleDecision(...)   — mapping + catalog validation
8. applyStripeBillingLifecycleDecision(...)     — the only mutation point
9. markBillingWebhookEventProcessed(...)
```

Every helper below step 5 (`beginBillingWebhookEventProcessing`,
`resolveStripeBillingLifecycleDecision`, `applyStripeBillingLifecycleDecision`,
`markBillingWebhookEvent*`) takes the already-built `supabase` client as an
explicit parameter rather than building its own — see the `client` option on
`getCompanySubscription`/`updateCompanySubscription`/
`findCompanyIdByStripeCustomerId`/`findCompanyIdByStripeSubscriptionId` in
`src/lib/billing.ts`. This is deliberate: it makes "was the service-role
client created before or after verification" directly observable in tests
(fake `createPrivilegedSupabaseClient` is never called on a
signature-rejection path) rather than something that has to be inferred from
reading every function body.

## Idempotency

`billing_webhook_events` (originally added for Perilla 2's residual-risk
list, hardened here) is the source of truth. Schema after
`20260817000000_stripe_webhook_lifecycle_hardening.sql`:

```
event_id           text primary key   -- Stripe event.id
event_type         text not null
livemode           boolean not null
processing_status  text not null check (processing_status in ('processing','processed','ignored','failed'))
error_reason        text
received_at         timestamptz not null
processed_at         timestamptz
updated_at           timestamptz not null
```

`beginBillingWebhookEventProcessing()` claims an event by inserting a
`processing` row. `event_id` is the primary key, so a concurrent duplicate
insert loses the race with a `23505` unique-violation, not a double
processing pass:

| Outcome | Meaning | Route behavior |
| --- | --- | --- |
| `new` | First time seeing this event id | Proceed to resolve + apply |
| `already_processed` | Row exists with `processed` or `ignored` status | Return `200 { received: true, duplicate: true }`, no mutation |
| `already_processing` | Row exists with `processing` status (another in-flight request, or an unreadable row after a race) | Return `200 { received: true, duplicate: true }`, no mutation |
| `retry_failed` | Row exists with `failed` status; this request atomically re-claimed it via a conditional `UPDATE ... WHERE processing_status = 'failed'` | Proceed to resolve + apply, same as `new` |

A row only reaches `processed` or `ignored` **after** the corresponding
mutation (or intentional no-mutation) has actually completed — never before.
If `resolveStripeBillingLifecycleDecision`/`applyStripeBillingLifecycleDecision`
throws, the event is marked `failed` (with a sanitized `error_reason`, capped
at 500 characters, newlines stripped — never a raw error object, stack trace,
or secret), and the route still returns `200` unless the idempotency claim
itself failed, so a legitimate future Stripe redelivery can retry it. This
replaces the previous behavior, where the row was written *before* processing
started, so a crash still left the event permanently marked "seen."

## Mapping: how customer/subscription/session resolve to a company

`company_subscriptions` uses `company_id` as its primary key (this codebase's
billing entity — see "Why `companyId`, not `workspaceId`" below), with
`stripe_customer_id` and `stripe_subscription_id` as unique columns. That
table, populated by our own server code, is the **only** authoritative
mapping:

- `findCompanyIdByStripeCustomerId(customerId)` — resolves a company from a
  Stripe customer id.
- `findCompanyIdByStripeSubscriptionId(subscriptionId)` — resolves a company
  (and its stored customer id) from a Stripe subscription id.

`resolveMappedCompany()` in `src/lib/billing-webhook-lifecycle.ts` is the
single call site every event handler goes through:

```
1. If the event carries a subscription id and a company is already on record
   for it:
     - if that company's stored customer id disagrees with the event's
       customer id → { mismatch: true } (event ignored, nothing mutated)
     - otherwise → that company, trusted
2. Else fall back to the customer id → company lookup (covers
   customer.subscription.created firing before any subscription id is on
   record for the company)
3. Else → unmapped (event ignored, nothing mutated)
```

This mapping exists *before* any webhook fires for the legitimate flow: 
`create-checkout-session/route.ts` creates (or reuses) the Stripe customer and
writes `company_subscriptions.stripe_customer_id` **synchronously**, before
returning the checkout URL to the browser — i.e. before the user can even
complete checkout, let alone before Stripe calls back. So for every
subscription created through PMFreak's own checkout flow, the customer→company
mapping is guaranteed to already exist by the time any webhook for that
customer arrives.

## Why metadata is not authorization

`checkout.session.completed` and `customer.subscription.*` payloads carry
`metadata.companyId` (written by `create-checkout-session/route.ts`, itself
only reachable after `requireBillingManageMembership` — see
`billing-authorization-boundary.md`). **This metadata is read only to log a
mismatch warning; it never establishes or overrides the resolved company.**

```
Stripe metadata is correlation data, not authorization.
```

Concretely: `decideForSubscriptionUpsert()` and
`decideForCheckoutSessionCompleted()` call `resolveMappedCompany()` first —
using only `company_subscriptions` — and only afterward compare
`metadata.companyId`/`session.metadata.companyId` to the resolved company id
for a `console.warn` if they disagree. The resolved (server-side) company id
is what gets passed to `applyStripeBillingLifecycleDecision()`; the metadata
value is discarded. `metadata.plan` is never read at all — the plan is always
derived from `resolvePlanFromStripePriceId()` against the price id actually
attached to the Stripe subscription line item (see below), so a manipulated
or stale `metadata.plan` value has no code path to influence billing state.

This means: even in a hypothetical where an attacker could get a
*legitimately signed* Stripe event with attacker-controlled metadata past
Stripe onto this endpoint (not achievable without compromising Stripe itself,
since the signature check already gates on `STRIPE_WEBHOOK_SECRET`), the
metadata alone still could not activate a different workspace, grant another
user a license, or select an unpurchased plan.

## Price catalog validation

`resolvePlanFromStripePriceId(priceId)` in
`src/lib/billing-webhook-lifecycle.ts` checks a price id against
`STRIPE_PRO_PRICE_ID`/`STRIPE_PMO_PRICE_ID` (the server's own environment
configuration — never a value read from the event). `resolvePlanForSubscriptionItems()`
applies this to every line item on the subscription. If **no** item matches a
known price id, the decision is `{ action: "ignore", reason: "unknown_price_id" }`
— no plan is activated, and no existing plan is silently downgraded either.
This replaced the previous behavior of silently mapping an unrecognized price
to `"free"` while still writing whatever subscription status Stripe sent.

A subscription moving to `canceled`/`unpaid`/`incomplete_expired` still
forces `plan: "free"` regardless of price id — that direction (downgrade on
cancellation) is a deliberate policy, not a mapping gap.

## Supported events and their decisions

| Stripe event | Decision action | Effect |
| --- | --- | --- |
| `checkout.session.completed` (mode `subscription`, `payment_status != "unpaid"`) | `activate_subscription` | Retrieves the full subscription via the Stripe API, validates mapping + price, writes plan/status/customer/subscription/period-end |
| `customer.subscription.created` | `activate_subscription` | Same validation, applied directly from the event payload |
| `customer.subscription.updated` | `update_subscription_status` | Same validation; status transitions (e.g. `trialing`→`active`, `active`→`past_due`) flow through the same catalog + mapping check |
| `customer.subscription.deleted` | `cancel_subscription` | Mapping validated (no price validation needed); forces `plan: "free"`, `status: "canceled"` |
| `invoice.paid` | `mark_payment_current` | Mapping validated via the invoice's subscription id; sets `status: "active"`, updates `currentPeriodEnd` from the invoice's period end |
| `invoice.payment_failed` | `mark_payment_failed` | Mapping validated the same way; sets `status: "past_due"` |
| Anything else | `ignore` (`unsupported_event_type:<type>`) | No mutation |

## What happens in each edge case

| Scenario | Result |
| --- | --- |
| Missing `stripe-signature` header | `400`, no service-role client created, no DB write |
| Missing `STRIPE_WEBHOOK_SECRET` | `500` (safe, generic message), no service-role client created |
| `constructEvent` throws (tampered body, wrong secret, bad signature) | `400`, no service-role client created |
| Event already `processed`/`ignored` | `200 { received: true, duplicate: true }`, no mutation |
| Event currently `processing` (concurrent request) | `200 { received: true, duplicate: true }`, no mutation |
| Event previously `failed` | Re-claimed exactly once via a conditional update, reprocessed |
| `metadata.companyId`/`metadata.userId` set to a workspace/user the mapping doesn't back | Ignored — mapping (not metadata) decides; a mismatch is logged, not trusted |
| `metadata.plan` set to a plan with no matching price id | No effect — plan is never read from metadata |
| `checkout.session.completed`/`customer.subscription.*` with no `company_subscriptions` row for that customer | `ignore` (`unmapped_customer`), `200`, no mutation |
| `customer.subscription.updated`/`.deleted` where the event's customer id disagrees with the company already on record for that subscription id | `ignore` (`customer_mismatch`), `200`, no mutation |
| Subscription price id not in `STRIPE_PRO_PRICE_ID`/`STRIPE_PMO_PRICE_ID` | `ignore` (`unknown_price_id`), `200`, no mutation, no silent downgrade |
| Unsupported/unknown event type | `ignore` (`unsupported_event_type:...`), `200`, no mutation |
| Processing throws after the event was claimed | Event marked `failed` (retryable), `500` (generic message, no error detail) |
| `event.livemode` | Recorded on the `billing_webhook_events` row for audit visibility; PMFreak does not currently run separate live/test Supabase projects, so no environment-level livemode gate is enforced beyond what Stripe itself guarantees (a test-mode secret only ever produces test-mode events) — see Residual risks |

## Why `companyId`, not `workspaceId`

`company_subscriptions` and the checkout/portal routes use `companyId`
throughout (sourced from `AuthUserContext.companyId`, itself the authenticated
user's own id — since PR-1 never the user-editable `user_metadata.company_id`) —
this predates and is a distinct identifier space from the
`workspaces`/`workspace_memberships` tables used for role-based authorization
(Perilla 1–5). `requireBillingManageMembership` in
`billing-authorization-boundary.md` authorizes *who* can trigger a checkout
using `workspaceId`; the resulting subscription record is keyed by
`companyId`. This fix does not change that existing architecture — it only
hardens the webhook trust boundary within it. Unifying the two identifier
spaces is out of scope for this perilla (see Residual risks).

## Errors never expose secrets

- HTTP error responses are always a fixed, generic string
  (`"Invalid Stripe webhook request."`, `"Stripe webhook is not configured."`,
  `"Unable to process webhook."`) — never `error.message`, a stack trace, the
  raw Stripe event, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, or the
  Supabase service-role key.
- `error_reason` persisted to `billing_webhook_events` is sanitized
  (`sanitizeReason()` in `src/lib/billing.ts`: newlines stripped, capped at
  500 characters) before being written, and is only ever populated from our
  own thrown `Error.message` strings (query failures, mapping reasons) — never
  from the raw Stripe payload or environment variables.
- Console logs use structured fields (`eventId`, `eventType`, `reason`) rather
  than dumping the full event or request object.

## Regression this fix prevents

- A request without a valid Stripe signature can no longer reach any
  service-role database call — verified before, not after.
- A replayed/duplicated Stripe event (Stripe's own redelivery, or a captured
  request replayed by an attacker who somehow obtained a previously-valid
  signed payload — signatures do not expire instantly) can no longer mutate
  `company_subscriptions` a second time.
- `metadata.companyId` no longer takes priority over the server-side
  customer→company mapping — a webhook event can no longer activate,
  update, or cancel billing for a company it isn't actually mapped to, even
  if metadata claims otherwise.
- `metadata.plan` was never wired to plan selection in the first place, and
  remains that way — codified here so a future change can't accidentally
  reintroduce it.
- An unrecognized Stripe price id can no longer result in a silently
  downgraded-but-still-"active" inconsistent state.
- A transient processing failure (e.g. a momentary DB error) no longer
  permanently blocks Stripe's automatic retry from ever reprocessing that
  event — it is marked `failed`, not `processed`.

## Tests

- `tests/stripe-webhook-verification.test.mjs` — `verifyStripeWebhookEvent()`
  in isolation: missing signature, missing secret, `constructEvent` throwing,
  and the success path, with a fake Stripe client (no network, no real
  signing).
- `tests/stripe-webhook-billing-lifecycle.test.mjs` —
  `resolveStripeBillingLifecycleDecision()` and
  `applyStripeBillingLifecycleDecision()` against a fake Supabase
  query-builder: unmapped customer, customer/subscription mismatch, unknown
  price id, metadata-manipulation attempts (`workspaceId`/`companyId`,
  `userId`, `plan`) that must not change the outcome, valid
  checkout/subscription/invoice flows, and cancellation.
- `tests/stripe-webhook-route.test.mjs` — full route-level behavioral tests
  (`handleStripeWebhook`, Stripe/Supabase mocked at the dependency boundary):
  missing signature → 400 with the DB client never instantiated, missing
  secret → fails closed, invalid signature → 400 with the DB client never
  instantiated, valid signature → processing begins, duplicate/already-
  processing event → 200 no-op, unknown event type → 200 ignored with no
  mutation, a processing exception → marked failed and a safe 500, and error
  responses never contain secrets/stack traces/the raw event.

## Residual risks

- **No dedicated pending-checkout-session table.** Mapping relies on
  `company_subscriptions.stripe_customer_id`/`stripe_subscription_id` being
  written synchronously by `create-checkout-session/route.ts` before Stripe
  can call back. This is correct for PMFreak's current single-checkout-path
  architecture, but a future multi-step or asynchronous checkout flow should
  introduce an explicit pending-session record rather than continuing to rely
  on this ordering guarantee implicitly.
- **`metadata.companyId` is still sent to Stripe and still read (as a
  logged-only hint).** It is not a security risk as implemented (see above),
  but a future engineer extending this code must not start trusting it
  without re-reading this document.
- **No environment-level live/test isolation beyond Stripe's own guarantee.**
  `event.livemode` is recorded for audit visibility but PMFreak does not
  currently run separate Supabase projects per Stripe mode; a test-mode
  webhook secret can only ever produce test-mode events, so cross-mode
  contamination is not currently possible in practice, but this should be
  revisited if/when a live Stripe account is provisioned.
- **`companyId` and `workspaceId` remain distinct identifier spaces.** This
  fix hardens the webhook boundary within the existing architecture; it does
  not unify billing identity with workspace identity.
- **`customer.subscription.trial_will_end`, refunds, disputes, and other
  Stripe events are not handled** — they fall through to the generic
  `unsupported_event_type` ignore path, which is safe (no mutation) but also
  means PMFreak takes no action on them today. Out of scope for this perilla
  per its instructions (no new entitlements engine / notification system).
- **No customer portal lifecycle changes** — `create-portal-session/route.ts`
  is unchanged; this fix only covers the webhook-driven side of the
  lifecycle.
