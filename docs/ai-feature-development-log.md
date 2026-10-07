# Development log: AI-generated model metadata

A record of how the AI feature was chosen, built, tested and fixed, written to be reused
when writing the project documentation and the dissertation. Every number below was
measured on the running application; nothing is estimated unless it says so.

For the design itself — architecture, prompt, schema, concepts, evaluation plan — see
[ai-model-metadata.md](ai-model-metadata.md). This file is the story of the work.

---

## 1. Summary

Uploaded 3D models (GLB files) arrive with meaningless names such as
`038_Giraffaxon_Art.glb`. The application now catalogues each model automatically:

1. The browser renders a small preview image of the model and measures its real size
   from the geometry (bounding box, in metres).
2. The server sends the image, the file name and the size to a vision-capable AI model.
3. The model returns a structured answer — readable name, one category from a fixed list,
   3–6 tags, a one-sentence description and a confidence level — which is stored next to
   the file and shown in the model library.
4. A person can correct the suggestion; the corrected entry is marked as human-edited.

The feature works with **Google Gemini** (in use, free tier) or **Anthropic Claude**,
switchable by configuration. Tested end to end on 7 October 2026.

---

## 2. Project timeline

Context: what existed before the AI feature, from the git history.

| Date | Commit | Milestone |
| --- | --- | --- |
| 2026-07-14 | `2eabfd0` | Base application: React + Express, login and registration, organizations with invite codes, GLB library with 3D preview (three.js) and thumbnails, Supabase Postgres + Storage, deployment on Render |
| 2026-09-15 | `0575c57` | Password recovery with one-time recovery codes |
| 2026-09-19 | `1b03e32` | Faster login (native bcrypt, one query per login) |
| 2026-09-21 | `154cf5a` | Roles and permissions, member management, production lines with QR codes |
| 2026-09-21 | `b84c26b` | Roles table layout fix |
| 2026-09-21 | `6e49118` | Instant role edits (optimistic UI), Render service moved to Frankfurt next to the database |
| 2026-10-07 | `6b54ebc` | **AI feature, first version (Claude)** |
| 2026-10-07 | `65949da` | **Gemini support; provider made interchangeable** |
| 2026-10-07 | `c3292e8` | **Robustness fixes found during end-to-end testing; table layout** |

---

## 3. How the feature was chosen

Several AI features were considered for this project and ranked by value against effort:

| Idea | Effort | Depends on |
| --- | --- | --- |
| **Automatic metadata for uploaded models** (chosen) | Small | Data that already exists (thumbnails) |
| Natural-language search in the library | Small–medium | Metadata from the chosen feature |
| AI summary of activity on a production line | Medium | A change history (not stored yet) |
| AI layout assistant (propose machine positions) | Large | A layouts table (not built yet) |
| AI safety check of a layout (blocked aisles, clearances) | Medium | Layouts |
| Voice commands in the AR app | Large | AR app integration |

Generating 3D models from text was rejected: industrial equipment needs exact dimensions,
which generated meshes do not provide.

**Why this one:** it uses data the application already produces, it is cheap, its result
is immediately visible, and a wrong answer costs nothing — a person edits a name.

---

## 4. What was built, step by step

### 4.1 First version, with Claude (`6b54ebc`)

**Server**

- `server/ai.js` — the AI module: system prompt, Zod schema of the answer, closed list
  of 10 categories, request to the model, post-processing of tags.
- `server/db.js` — new columns on `files`: `display_name`, `category`, `tags` (JSONB),
  `description`, `width_m`, `depth_m`, `height_m`, `ai_status`, `ai_confidence`,
  `ai_model`, `ai_error`, `ai_generated_at`. Added with `ADD COLUMN IF NOT EXISTS`, so
  existing databases migrate on the next start.
- `server/index.js` — three routes and changes to upload:
  - `POST /api/files` (upload) now stores the measured size, sets `ai_status = 'pending'`,
    **answers immediately**, then starts the analysis in the background.
  - `POST /api/files/:id/describe` — run or re-run the analysis for one model (covers
    models uploaded before the feature existed, and retries after a failure).
  - `PATCH /api/files/:id` — a person saves corrected values; status becomes `edited`.
  - `GET /api/model-categories` — the category list and whether AI is enabled, so the
    page offers exactly the choices the model has.

**Client**

- `client/src/utils/thumbnail.js` — the existing preview renderer now also returns the
  model's dimensions from its bounding box (glTF is defined in metres, Y is up).
- `client/src/pages/MainMenu.jsx` — the library shows the generated name, original file
  name, description, tags, category, real size and AI status ("Analysing…", "Analysis
  failed"). While any model is pending, the page re-reads the list every 3 seconds.
  Buttons: **Details**, **Describe with AI** / **Re-run AI**.
- `client/src/components/ModelDetailsDialog.jsx` — form for correcting the suggestion.

**Documentation:** `docs/ai-model-metadata.md` (design and concepts), README section,
`server/.env.example`.

### 4.2 Choosing Gemini; making the provider interchangeable (`65949da`)

The Google AI Pro student plan was checked first: it is a consumer subscription for the
Gemini app and **does not include API access** for a server. The relevant free option is
the **free tier of the Gemini API in Google AI Studio**, which needs no billing account.

Rather than replacing Claude, the AI code was split so the task is defined once and each
provider is a small adapter:

- `server/ai.js` — shared: prompt, schema, categories, input preparation, validation,
  provider selection.
- `server/ai-providers/anthropic.js` — Claude adapter (`messages.parse` with the Zod
  schema).
- `server/ai-providers/gemini.js` — Gemini adapter (Interactions API with a JSON Schema
  generated from the same Zod schema; the answer is then validated with that Zod schema).

Selection: `AI_PROVIDER=gemini|anthropic`; when unset, the first provider with a key is
used. If `AI_PROVIDER` names a provider without a key, the feature turns **off** instead
of silently using the other provider — so a comparison between models can never mix
providers by accident.

The Gemini API shape was taken from the installed SDK's type definitions
(`@google/genai` 2.27.0), not from memory: the current API (`interactions.create`) differs
from most online tutorials (`generateContent`).

### 4.3 Fixes found by end-to-end testing (`c3292e8`)

See section 6 for what went wrong. Changes made:

- Per-attempt timeout of 45 s and one retry, so a stuck request ends in about 90 s.
- Provider errors stored as readable reasons instead of raw JSON.
- On server start, analyses left `pending` by a restart are marked failed, so the page
  stops waiting and offers a retry.
- Models table: "File" and "Uploaded by" merged, action buttons wrap two per row,
  generated names wrap between words. Table width went from **1281 px to 936 px**,
  fitting the page again.

---

## 5. Key design decisions

These are the decisions worth defending in the dissertation.

1. **Never ask the AI for what a program can compute.** Dimensions come from the
   geometry (exact, free, instant). They are *given to* the model as context, because
   scale tells similar shapes apart (0.2 m box = tool, 2 m box = cabinet).
2. **Structured output, not free text.** The model must answer in a fixed JSON schema,
   so the server never parses prose and the result goes straight into database columns.
3. **Closed category list.** Ten fixed values instead of free text, so "robot", "robotic
   arm" and "6-axis manipulator" cannot all appear for the same kind of object.
4. **Prompt written against specific failure modes:** no invented manufacturers or
   specifications (hallucination), the file name is only a hint, use the measurements,
   and say "low confidence" instead of guessing.
5. **Upload never waits for the AI.** The analysis runs after the upload response; the
   page polls while anything is pending.
6. **Failure is normal, not exceptional.** Any AI failure is recorded on the row; the
   model itself stays uploaded, viewable and downloadable.
7. **Human-in-the-loop.** The AI answer is a draft; a person's correction wins and is
   marked `edited`.
8. **Interchangeable provider, identical validation.** Both providers receive the same
   prompt and schema and their answers pass the same Zod check, so comparing them
   changes exactly one variable: the model.
9. **No silent fallback between models or providers.** The model that produced each
   entry is stored (`ai_model`), which keeps any evaluation honest.

---

## 6. Problems found during testing, and how they were solved

| # | Problem | Cause | Solution |
| --- | --- | --- | --- |
| 1 | Server would not start; database unreachable ("tenant not found") | The Supabase free project was **paused** after about a week without activity | Resumed the project in the Supabase dashboard |
| 2 | First test query failed: column `width_m` does not exist | New columns are created at server start, and the server had not been started since the change | Test scripts call the schema setup first; in normal use this happens automatically |
| 3 | Gemini requests hung for minutes with no output | Google returned **503 "high demand"** for the newest Flash models; the SDK retried silently with growing pauses | Measured each model directly; switched to a model that answers; added timeout and retry limits |
| 4 | First timeout test still took 130 s instead of 60 s | The timeout applies **per attempt**; retries multiply it | Lowered to 45 s per attempt with one retry (about 90 s worst case) |
| 5 | A crashed or restarted server could leave models on "Analysing…" forever | The analysis runs inside the server process | On start, `pending` rows are marked failed with a retry message |
| 6 | Raw JSON error bodies would be shown to users | Errors were stored as received | Status codes mapped to readable reasons (401/403 key rejected, 404 model unavailable, 429 rate limit, 503 overloaded, timeout) |
| 7 | Models table wider than the page; buttons cut off | New columns plus five buttons on one line | Columns merged, buttons wrap, names wrap by word |
| 8 | Generated names broke mid-word ("test edi / t") | A style meant for file names (break anywhere) was applied to names | Separate style for names (wrap between words) |

### Gemini model availability on the free tier (7 Oct 2026, 14:16–14:26 UTC)

Measured with the project's API key:

| Model | Result |
| --- | --- |
| `gemini-3.8-flash` (Google's recommended default) | 503 "currently experiencing high demand" |
| `gemini-3.7-flash` | 503 high demand |
| `gemini-3.6-flash` | no answer within 30 s |
| `gemini-3.5-flash` | 503 on one endpoint; answered a one-word prompt in **22 s** on the other |
| **`gemini-3.5-flash-lite`** | **answered the real image request in 2.1 s, correctly** |
| `gemini-3.1-flash-lite` | no answer within 25 s |
| `gemini-2.5-flash` | 404 "no longer available to new users" |

**Decision:** `GEMINI_MODEL=gemini-3.5-flash-lite` for now. Free-tier capacity is a
limitation worth reporting: at test time most of the newer models were unavailable.

---

## 7. Test results

All on the real application (local server, Supabase database, Gemini
`gemini-3.5-flash-lite`).

### Offline checks (no network)

| Check | Result |
| --- | --- |
| No API key → feature refuses to run, buttons hidden | ✅ |
| Missing / non-image / non-data-URL preview rejected before any network call | ✅ |
| Provider selection: no key → off; Gemini key → Gemini; both keys → Gemini; `AI_PROVIDER=anthropic` → Claude; `AI_PROVIDER=gemini` without its key → off (not Claude); unknown provider → off | ✅ all 7 cases |
| Zod schema converts to a valid JSON Schema for Gemini (enum of categories, arrays, descriptions) | ✅ |

### End-to-end

| Test | Result |
| --- | --- |
| "Describe with AI" on two existing models | Both done in **6.9 s** (includes the 3 s polling interval) |
| `PalletConveyor.glb` | **"Pallet Roller Conveyor"**, category *conveyor*, tags *conveyor, roller, pallet, transport, material handling* |
| `arm_chair__furniture.glb` | **"Upholstered Office Armchair"**, category *furniture*, tags *chair, armchair, seating, office, furniture* |
| Full upload as the page does it (render → measure → upload) | Size measured in browser: **1.52 × 1.214 × 0.618 m**; preview **4 KB**; upload answered in **1.0 s** with status `pending` |
| Analysis after that upload | Ready after **6.5 s**: "Roller Conveyor with Pallet", *conveyor*, confidence **high** |
| Single image request to Gemini (probe) | **2.1 s**, about 1,100 input tokens and 25 output tokens |
| Correction in the Details dialog | Pre-filled with the suggestion and its source; after saving, name and tags updated and status `edited` |
| Models table width | 936 px in a 936 px container, no horizontal scroll |
| Production build of the client | Passes |

The test copy uploaded during testing was deleted afterwards. The AI descriptions of the
two real models were kept.

---

## 8. Configuration

In `server/.env` (never committed):

```
GEMINI_API_KEY=...                 # Google AI Studio → Get API key (no billing needed)
AI_PROVIDER=gemini
GEMINI_MODEL=gemini-3.5-flash-lite # remove to return to the default gemini-3.8-flash
```

To use Claude instead: `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY=...`
(optionally `ANTHROPIC_MODEL=...`). No code changes are needed either way.

The same variables must be set on Render (service → Environment) for the deployed site.
Without them the site works normally and the AI buttons are hidden.

---

## 9. Open items

- [ ] Add `GEMINI_API_KEY`, `AI_PROVIDER` and `GEMINI_MODEL` on Render.
- [ ] Try `gemini-3.8-flash` again when Google's capacity recovers.
- [ ] Build the labelled evaluation set (30–50 models) described in
      [ai-model-metadata.md](ai-model-metadata.md), section 6.
- [ ] Optional: run the same set through Claude and compare accuracy, confidence
      calibration, edit rate and cost — the provider split was built for this.
- [ ] Optional: natural-language search over the generated tags.

---

## 10. Files

| File | Role |
| --- | --- |
| `server/ai.js` | Task definition: prompt, schema, categories, provider selection, error handling |
| `server/ai-providers/gemini.js` | Gemini adapter |
| `server/ai-providers/anthropic.js` | Claude adapter |
| `server/db.js` | New columns on `files` |
| `server/index.js` | Upload changes, describe / edit / categories routes, restart recovery |
| `client/src/utils/thumbnail.js` | Preview rendering and size measurement |
| `client/src/pages/MainMenu.jsx` | Library table, AI status, polling, actions |
| `client/src/components/ModelDetailsDialog.jsx` | Manual correction form |
| `client/src/App.css` | Styles for the catalogue and dialog |
| `server/.env.example` | Documented configuration |
| `docs/ai-model-metadata.md` | Design, concepts, evaluation plan |
| `docs/ai-feature-development-log.md` | This file |
