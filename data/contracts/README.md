# TX daily history and reporting contracts

TX strategy lane: strategic_enabler

These are local, canonical **write contracts** for the next operating layer.
They do not create a Supabase table, apply a migration, or authorize an
external action. They make the daily source files and a future database use
the same grain and keys.

## The three immutable datasets

| Dataset | One row means | Immutable key | Question it answers |
|---|---|---|---|
| `tx_daily_account_snapshot` | one commercial account at one UTC business-date and snapshot version | `snapshot_id + canonical_company_id` | What was true for this account at that cutoff? |
| `tx_daily_supply_snapshot` | one account's offer/supply slice at one cutoff | `snapshot_id + canonical_company_id + supply_side + channel + vendor_key + product_key + horizon_bucket` | What could be offered online/offline, by whom, in what product/horizon? |
| `tx_operational_reporting` | one approved action or one learning/outcome observation | `reporting_event_id` | What was proposed/done, what moved, and what did we learn? |

`snapshot_id` is an immutable, source-dated identifier such as
`tx-account-2026-08-04T060000Z-v1`. A corrected extraction never overwrites a
snapshot: it uses a new `snapshot_id`, points to `supersedes_snapshot_id`, and
keeps the old record available for audit.

## Common non-negotiables

1. `canonical_company_id` is mandatory. Alias/name-only records are quarantined
   until the identity crosswalk resolves them.
2. Every metric/value carries period, source, evidence keys, extraction time,
   trust state and freshness. `null` means unknown; zero means observed zero.
3. Online and offline are independent channel populations. They are never
   summed unless `channel=all` was supplied by the same source and period.
4. A delta is valid only when both snapshots have compatible metric definition,
   entity boundary, source coverage and observation window. Otherwise emit
   `comparison_state=blocked`, never a movement claim.
5. Supply availability is an observation at a cutoff, not a proxy from sales.
   Historical sales proxies may be stored only with `observation_kind=sales_proxy`.
6. Reporting records activity and learning; they never cause outreach,
   configuration changes, priority changes or play promotion.

## Materialization status at 2026-08-04

The account snapshot can be populated now for identity, account tags, observed
Koronet BUY/SELL/fees (where compatible), selected research estimates, SFDC
features/opportunities, settings snapshots, GA4 exact mappings and explicit
gaps. Supply can only carry historical sales proxies and selected vendor
activity now. True current online/offline offer parity, available quantity,
arrival horizon, fulfillment and same-need availability require the Snowflake
feeds named in the schemas. Reporting actions/results can be recorded now once
human-approved; attributable effects remain blocked until compatible snapshots
and an action window exist.

See the JSON schemas for exact validation rules and
`TX_HISTORY_REPORTING_IMPLEMENTATION_AUDIT_2026-08-04.md` for the rollout.

## Interim LIST coverage proxy (v1.1)

Until a true current catalog/supply feed exists, Rose records a daily
**proxy listable-pool coverage** rather than a parity/availability claim.

- **Candidate pool denominator:** the de-duplicated product set from
  `all_channel_sold_proxy ∪ unallocated_purchase_proxy`, at a stated account,
  product grain, format, horizon bucket and source window.
- **Online-evidenced numerator:** product keys with an
  `online_sold_proxy` or a separately observed `buyer_visible_listing` record
  under the same grain/window. Sales proxy remains sales proxy.
- **Coverage:** `online_evidenced_keys / candidate_pool_keys`, only where the
  product grain, format, horizon and source window are compatible. Otherwise
  `NOT_COMPARABLE` with the missing compatibility condition.
- **Benchmark:** apply exactly the same proxy definition and seasonal/window
  treatment to the named comparable cohort. It is a reference, not a claim
  that the account has current inventory/availability equal to the cohort.
- **Value:** sales GMV and purchase cost/value are retained as separate,
  source-labelled context. They must never be added into a single coverage
  denominator or TAM.

This proxy is useful for short/medium/long horizon learning and daily account
status. It must not be labelled current catalog parity, publishability, stock
or buyer-visible availability.
