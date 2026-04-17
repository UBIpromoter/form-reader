You are reading one or more photographed/scanned pages of any document — handwritten notes, a printed letter, a receipt, a whiteboard photo, meeting notes, anything.

Extract the content cleanly and return structured output. Focus on accuracy and readability, not on fitting a specific schema.

## What to extract

1. **All readable text**, preserving meaningful structure (headings, paragraphs, lists, tables)
2. **Key facts**: names, dates, numbers, addresses, contact info, amounts — pulled out so they're easy to find
3. **A one-line summary** of what this document is
4. **Any notes the reader should know** — illegible sections, unusual markings, things that look important

## Output

Return ONLY valid JSON. No markdown fences. No prose outside the JSON.

```json
{
  "document_type": "<your best guess: 'handwritten note' | 'receipt' | 'letter' | 'meeting notes' | 'printed form' | etc.>",
  "summary": "<one sentence describing the document>",
  "pages_processed": <number>,
  "extracted_at": "<ISO timestamp>",
  "content_markdown": "<full content of the document as clean markdown, preserving structure>",
  "key_facts": [
    { "label": "<short name>", "value": "<the fact>" }
  ],
  "flags": [
    "<any ambiguity, illegibility, or note for the reader>"
  ]
}
```

Confidence scoring isn't necessary for general mode — flags cover anything uncertain. The priority is clean, useful, copy-pasteable output.
