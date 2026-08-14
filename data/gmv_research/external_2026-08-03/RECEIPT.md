# P1 external GMV / BUY research — batch B

Researched: 2026-08-03. Entity key is Koronet `company_id` / company-location.

| Account | GMV result | BUY result | Why |
|---|---|---|---|
| `821576` Main / Pennsauken | BLOCKED | BLOCKED | Public revenue is for the three-warehouse company, not the Pennsauken location. |
| `827180` Main / Clifton | BLOCKED | BLOCKED | Same legal-company scope conflict; public revenue estimates also conflict. |
| `765491` Dreisbach | BLOCKED | BLOCKED | One uncalibrated $7.5M directory estimate conflicts with official six-branch scope. |
| `623491` Baisch & Skinner | BLOCKED | BLOCKED | Third-party revenue reports conflict from $3.5M to $100M. |

No observed Koronet BUY or SELL was used as company potential. No model ratio was presented as external evidence.

## Exact next evidence needed

1. Main: legal-entity revenue for a defined fiscal year and a branch allocation method (or company-location-to-legal-entity mapping which says to use aggregate).
2. Dreisbach: audited/owner-provided annual sales or an authoritative financial-data source that explicitly covers all six branches.
3. Baisch & Skinner: an authoritative annual-revenue source; then company/branch scope confirmation.
4. All four: annual COGS, gross margin, or a separately versioned internal procurement-ratio model calibrated on comparable accounts before deriving BUY potential.

The JSON files use the canonical staging contract for the durable importer. Current importer support for `external_estimates` must be added before application; no data was sent to Supabase in this research pass.
