# Form Reader

**Snap a form, get clean structured data back.**

A thin AI extraction layer for handwritten forms and general documents. Users scan with whatever they already trust — iOS Notes, the Files app, Google Drive, Adobe Scan — and upload the result here. The tool extracts fields into structured JSON, shows a side-by-side review, and exports the cleaned data wherever it needs to go.

Built for **The Davis Financial Group** as their first-client intake tool, but designed to be generic enough that the same pipeline handles any form (or any document) with a different prompt.

## Why this exists

Every serious document-scanning app (iOS Notes, Google Drive, Adobe Scan, Microsoft Lens) already has excellent native camera capture, edge detection, multi-page support, and review UX. Building a scanner from scratch in the browser would reinvent work those teams already did better than we ever could.

What *doesn't* exist is a simple upload-and-extract tool that knows specific forms deeply and returns clean structured data the advisor can actually use. So we built that layer and nothing more.

## What it does

- Accepts images (JPG / PNG / HEIC) and PDFs — single or multi-page, any combination
- Sends them to a vision model with a domain-specific prompt
- Returns structured JSON with per-field confidence scores
- Shows a side-by-side review: original pages on the left, extracted fields on the right
- Amber-flags anything the model was unsure about
- Lets the user edit any field inline before exporting
- Exports via email (mailto), clipboard, or JSON download

## What it doesn't do

- No camera UX of its own — uses the browser's file input, drag-and-drop, paste, and the Web Share Target API (PWA)
- No data persistence — images stay in the browser, results stay with the user
- No user accounts, no history, no database
- No client-facing outputs — this is a back-office tool

## Modes

**Davis mode (default).** Knows the three Davis Financial intake documents cold (Quick Start, Financial Sketch, What to Bring) and extracts into their schema. Multi-page forms are sent as one request.

**General mode ("digitize anything").** Takes any photo or PDF and returns clean markdown, a one-line summary, and extracted key facts. For notes, receipts, letters, whiteboards, anything.

## Running locally

```bash
git clone https://github.com/UBIpromoter/form-reader.git
cd form-reader
npm install
export OPENROUTER_API_KEY=sk-or-...
node server.js
```

Then open `http://localhost:8091`.

## Configuration

Environment variables:

- `OPENROUTER_API_KEY` (required) — OpenRouter API key
- `PORT` (optional, default `8091`)
- `MODEL` (optional, default `google/gemini-2.0-flash-001`) — any OpenRouter vision model
- `KILL_SWITCH=true` — returns 503 on all extraction requests. For shutting off a public instance fast.

## Abuse protection

For public deployments:

- 20 requests per minute per IP (in-memory rate limit)
- 15 MB maximum payload per request
- 10 files maximum per request
- Kill switch via `KILL_SWITCH=true` env var

## Architecture

- **Server:** 300 lines of Node. No frameworks. Just Busboy for multipart parsing, standard `https` for the OpenRouter call.
- **Frontend:** single HTML file, no build step, no dependencies. Vanilla JS + CSS.
- **Model:** Gemini 2.0 Flash via OpenRouter. Cheap, fast, good at vision.
- **Prompt:** domain-specific Markdown files in `prompts/`. Swap the prompt, swap the domain.

## Adapting to a different form

1. Copy `prompts/davis.md` to `prompts/<yourform>.md`
2. Edit the field list and output schema to match your form
3. In `server.js`, add the new prompt to the `PROMPTS` map
4. In `public/index.html`, add your field metadata to `DAVIS_FIELDS` (rename or fork)

Or fork the repo and replace both entirely.

## Hosting notes

Works on any VPS that can run Node. Behind a reverse proxy for TLS. For the Davis demo it runs on a home server with a Cloudflare tunnel; for real deployment it would live on whatever infrastructure the client controls.

## License

MIT.

## Credits

Built by Green Wall AI Consulting as the first-client deliverable for The Davis Financial Group. The scanner work is deliberately not reinvented — we lean on iOS Notes, Files, Google Drive, and other native scanners for capture, and focus our effort on the AI extraction layer.
