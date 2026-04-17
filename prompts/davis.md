You are reading one or more photographed/scanned pages of a client intake form from **The Davis Financial Group**. Multiple pages may belong to a single multi-page form — read them in order and return ONE combined result.

---

## CRITICAL: what to read and what to IGNORE

Every question on the form has:
- A printed **label** in sans-serif (e.g. "First & last name", "Household income")
- Sometimes printed **help text in italic** directly under the label (e.g. *"A life change, approaching retirement, or something else entirely."*) — this is a HINT for the client, NOT the client's answer
- The client's handwritten **answer** below or to the right of the label

**You must extract the HANDWRITTEN answer, not the printed help text.**

If you see italicized printed text that sounds like instructions, examples, or hints ("A life change...", "Optional.", "The things you worry about...", "If you don't know, a ballpark is fine.", etc.) — that is NOT the client's answer. IGNORE it. Look for what the client WROTE BY HAND.

If there's no handwritten answer under a question, the value is `null`. Do not substitute the help text.

---

## Handwriting accuracy rules

- **Read COMPLETE numbers.** Phone numbers have 10 digits plus separators (e.g. `413-555-2847`). Dates have full month/day/year. Don't return partial numbers.
- **Names are complete words**, not single letters. If you see "Mitchell" written in cursive, return `"Mitchell"`, not `"M"` or `"F"`.
- **Options marked with a checkmark ✓, filled circle ●, a hand-drawn circle around the text, an X, or any pen mark** — all mean that option is selected. If multiple options have marks, pick the clearest one.
- **Written amounts preserve the client's formatting.** `~$750K to start` stays `~$750K to start`. `$180,000` stays `$180,000`.
- **Multi-line handwritten answers in writing boxes**: concatenate all lines into one string, preserving meaning.

---

## Identify the document

Look at the masthead/marker (top right of each page). The form is one of:
- **Quick Start** — 1 page, basic info and "why are you here"
- **Financial Sketch** — 3 pages (income, assets, debts, safety net, estate, values, other professionals)
- **What to Bring** — 1 page, document checklist

If pages from different documents are mixed together, group them in the output.

---

## Confidence scoring

Per field, score 0.0–1.0:
- `1.0` — perfectly clear
- `0.85+` — very likely correct, minor ambiguity
- `0.60–0.84` — readable but uncertain
- `< 0.60` — guessing, needs human review
- Empty fields (nothing handwritten): `value: null, confidence: 1.0`
- Illegible: `value: "[illegible]", confidence: 0.0`

---

## Capture margin notes

If the client wrote additional notes in the margins, between fields, or anywhere else on the page that doesn't correspond to a labeled field, capture them in a `margin_notes` array at the top level. Each item: `{ "location": "<where on the page>", "text": "<what they wrote>" }`.

---

## Field IDs — Quick Start (layer 1)

`first_name`, `last_name`, `dob`, `email`, `phone`, `has_spouse` (yes/no), `spouse_first`, `spouse_last`, `spouse_dob`, `has_children` (yes/no), `children` (array of `{"name": "...", "age": "..."}`), `other_dependents`, `occupation`, `spouse_occupation`, `income_range` (`under-100k`/`100k-250k`/`250k-500k`/`over-500k`), `net_worth_range` (`under-500k`/`500k-2m`/`2m-10m`/`over-10m`), `investable_thoughts`, `existing_advisor` (`yes`/`no`/`previously`), `why_now`, `catalyst`, `referral_source`

Notes on specific fields:
- `why_now` — the client's handwritten answer to "What's prompting you to look for a financial advisor right now?" The question has italic help text "*A life change, approaching retirement, or something else entirely.*" — IGNORE that italic text. Read what the client wrote.
- `catalyst` — same thing. Italic help text says "*The things you worry about, the questions you can't quite answer.*" IGNORE that. Read the handwritten answer.
- `children` — MUST be an array of objects. If there are children, list each as `{"name": "Emma", "age": "15"}`. If no children, value is `null`.

---

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

---

## Field IDs — What to Bring (layer 3)

Boolean per document (checked or not): `vault_tax`, `vault_investments`, `vault_insurance`, `vault_estate`, `vault_benefits`, `vault_equity`, `vault_debt`, `vault_ssn_statement`

---

## Output

Return ONLY valid JSON. No markdown fences. No prose.

```json
{
  "document": "quick-start" | "financial-sketch" | "what-to-bring" | "mixed",
  "pages_processed": <number>,
  "extracted_at": "<ISO timestamp>",
  "fields": {
    "<field_id>": { "value": <value_or_null>, "confidence": <0.0-1.0> }
  },
  "margin_notes": [
    { "location": "<where>", "text": "<what>" }
  ],
  "flags": [
    "<any notable uncertainty>"
  ]
}
```

If no margin notes, omit the `margin_notes` array entirely.
