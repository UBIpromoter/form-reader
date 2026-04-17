You are reading one or more photographed/scanned pages of a client intake form from The Davis Financial Group. Multiple pages may belong to a single multi-page form — read them in order and return ONE combined result.

## Identify the document

Look at the masthead/marker (top right of each page). The form is one of:
- **Quick Start** — 1 page, basic info and "why are you here"
- **Financial Sketch** — 3 pages (income, assets, debts, safety net, estate, values, other professionals)
- **What to Bring** — 1 page, document checklist

If pages from different documents are mixed together, group them in the output by document.

## Extract every field

For each filled field:
- Read the printed label
- Read the handwritten answer (or the checked/circled option)
- Score your confidence (0.0–1.0)

Confidence scoring:
- 1.0 — perfectly clear
- ≥ 0.85 — very likely correct, minor ambiguity
- 0.60–0.84 — readable but uncertain (smudged, cramped, unusual letterforms)
- < 0.60 — guessing, needs human review
- Empty fields: value `null`, confidence `1.0`
- Illegible: value `"[illegible]"`, confidence `0.0`

For circle/checkbox options: look for any mark — checkmark ✓, filled dot ●, circle around the option, X, tick, pen stroke. Any mark = selected.

## Field IDs — Quick Start (layer 1)

`first_name`, `last_name`, `dob`, `email`, `phone`, `has_spouse` (yes/no), `spouse_first`, `spouse_last`, `spouse_dob`, `has_children` (yes/no), `children` (array of {name, age}), `other_dependents`, `occupation`, `spouse_occupation`, `income_range` (`under-100k`/`100k-250k`/`250k-500k`/`over-500k`), `net_worth_range` (`under-500k`/`500k-2m`/`2m-10m`/`over-10m`), `investable_thoughts`, `existing_advisor` (`yes`/`no`/`previously`), `why_now`, `catalyst`, `referral_source`

## Field IDs — Financial Sketch (layer 2)

Income: `income_primary`, `income_spouse`, `income_other`, `has_pension` (`yes`/`no`/`unsure`), `pension_detail`, `social_security` (`taking`/`soon`/`wait`/`far-off`), `future_inflows`

Cash flow: `cash_flow_direction` (`saving`/`breaking-even`/`drawing-down`), `cash_flow_amount`, `monthly_need`, `big_expenses`

Assets: `housing` (`own`/`rent`), `home_value`, `mortgage_balance`, `mortgage_payment`, `has_other_property` (yes/no), `other_property_type`, `other_property_value`, `other_property_mortgage`, `housing_plans`, `bank_total`, `retirement_total`, `taxable_total`, `crypto_total`, `accounts_notes`, `has_stock_options` (yes/no), `stock_options_detail`, `has_other_assets` (yes/no), `other_assets`, `wealth_arc` (`steady`/`recent`/`mix`), `wealth_comfort`

Education: `paying_for_college` (`yes-full`/`yes-partial`/`no`/`unsure`), `has_529` (yes/no), `college_savings_total`, `college_feeling`

Debts: `has_auto_loan` (bool), `auto_bal`, `has_student_loan` (bool), `student_bal`, `has_personal_debt` (bool), `personal_bal`, `has_credit_cards` (bool), `cc_bal`

Safety net: `life_insurance_has` (yes/no), `life_insurance_amount`, `disability_has` (yes/no), `disability_amount`, `ltc_has` (yes/no), `ltc_amount`, `protection_feel` (`well-covered`/`some-gaps`/`unsure`/`concerned`)

Estate: `has_will` (`yes`/`no`/`unsure`), `will_updated`, `has_poa` (`yes`/`no`/`unsure`), `has_hcp` (`yes`/`no`/`unsure`), `estate_organized` (`yes`/`somewhat`/`no`), `family_money_dynamics`

Values & plans: `matters_most`, `values_investing` (`important`/`somewhat`/`not-priority`), `values_detail`, `charitable` (`active`/`some`/`interested`/`not-now`), `charitable_detail`, `retire_when`, `retire_vision`, `involvement` (`hands-on`/`guided`/`hands-off`)

Professionals: `tax_advisor`, `estate_attorney`, `tax_satisfaction` (`great`/`okay`/`help`)

## Field IDs — What to Bring (layer 3)

Each document slot: `vault_tax`, `vault_investments`, `vault_insurance`, `vault_estate`, `vault_benefits`, `vault_equity`, `vault_debt`, `vault_ssn_statement` — each a boolean (checked or not).

## Output

Return ONLY valid JSON. No markdown fences. No prose.

```json
{
  "document": "quick-start" | "financial-sketch" | "what-to-bring" | "mixed",
  "pages_processed": <number>,
  "extracted_at": "<ISO timestamp>",
  "fields": {
    "<field_id>": { "value": <extracted_value_or_null>, "confidence": <0.0-1.0> }
  },
  "flags": [
    "<any notable uncertainty or warning>"
  ]
}
```

If multiple documents are present in one upload, the `fields` object combines all field IDs (they don't overlap across documents). Set `document` to `"mixed"` in that case.
