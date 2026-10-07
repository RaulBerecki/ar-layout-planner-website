# AI-generated model metadata

How the application turns an anonymous `.glb` upload into a catalogue entry, and why it
is built this way. Code: [`server/ai.js`](../server/ai.js), the upload and describe
routes in [`server/index.js`](../server/index.js),
[`client/src/utils/thumbnail.js`](../client/src/utils/thumbnail.js) and
[`client/src/components/ModelDetailsDialog.jsx`](../client/src/components/ModelDetailsDialog.jsx).

## 1. The problem

A GLB exported from CAD arrives as `038_Giraffaxon_Art.glb` or `part_rev3_final.glb`.
The file name says nothing about what the object is, so the library becomes unusable as
soon as it holds more than a handful of models: nobody can find the welding robot, and
nobody can tell two similar file names apart.

Describing each model by hand is exactly the kind of work people skip. The goal is for a
useful entry — a readable name, a category, keywords, one sentence — to exist by default,
with a person needed only to correct it.

## 2. What is asked of the model, and what is not

| Fact | Where it comes from | Why |
| --- | --- | --- |
| Width, depth, height | Bounding box of the geometry, computed in the browser | Exact. A measurement is arithmetic, not judgement. |
| File size, uploader, date | The upload itself | Already known. |
| Name, category, tags, description | Claude, from the rendered preview | Recognising *what an object is* from its shape is the part only a human or a vision model can do. |

This split is the main design rule: **never ask a language model for something a program
can compute.** Asking for dimensions would add cost, latency and a chance of being wrong,
while `Box3.setFromObject()` is exact and free. The measurements are then *given to* the
model as context, because scale disambiguates shape — the same silhouette at 0.2 m is a
hand tool and at 2 m is a machine.

## 3. Data flow

```
Browser                          Server                        Claude API
───────                          ──────                        ──────────
GLB chosen
  │
  ├─ render once (three.js)
  │    ├─ thumbnail (WebP, ~3-20 KB)
  │    └─ bounding box -> width/depth/height in metres
  │
  └─ POST /api/files ──────────▶ store file in Supabase Storage
                                 insert row, ai_status = 'pending'
       ◀───────────────────────  201 Created  (returns immediately)
                                      │
                                      ├─ generateMetadata() runs after the response
                                      │     image + file name + size ─────▶ messages.parse()
                                      │     ◀──────────── JSON matching the schema
                                      └─ UPDATE files ... ai_status = 'ready'
  polls /api/files every 3 s
  while any row is 'pending'
  └─ row refreshes with name, category, tags, description
```

The upload response does not wait for Claude. A model of 15 MB already takes a while to
reach storage; adding a few seconds of inference to the same request would make the
upload feel broken. The work is started *after* `res.json()` and the page polls until the
row changes — simpler than websockets for something that finishes in seconds.

## 4. Key concepts

### 4.1 Multimodal (vision) input

The request carries two content blocks in one user message: an `image` block (base64 of
the thumbnail plus its media type) and a `text` block with the file name and measured
size. The model reads both together. The thumbnail is reused from the feature that
already renders previews — no second render, no extra storage.

### 4.2 Structured outputs

The server never parses free text. It declares a Zod schema and passes it through
`zodOutputFormat()`; the API then constrains generation so the reply matches that schema,
and the SDK returns it as `response.parsed_output`. This removes a whole class of bugs
(regexes over prose, "Sure! Here is the JSON:" prefixes, inconsistent field names) and
makes the feature safe to store directly in SQL columns.

### 4.3 A closed category list

`category` is a Zod `enum` over ten fixed values. If categories were free text, the same
object would arrive as "robot", "robotic arm" and "6-axis manipulator", and no filter or
layout rule could rely on the field. A closed vocabulary is what makes the output
*structured data* rather than *more text*. The same list is served to the UI at
`/api/model-categories`, so the dropdown a person edits with and the choices the model has
can never drift apart.

### 4.4 Prompt design

The system prompt in `ai.js` states the role, the inputs, the task and four rules. The
rules exist because of specific failure modes:

- *"Never invent a manufacturer, model number or capability"* — a vision model asked to
  describe equipment will otherwise produce plausible, unverifiable specifics
  (hallucination). The prompt restricts it to what is visible.
- *"The file name is a hint, not the truth"* — otherwise `..._Art.glb` drags the answer
  towards "artwork".
- *"Use the given measurements"* — makes the model actually apply the scale context.
- *"If unclear, pick the closest category and set confidence to low"* — gives the model a
  legitimate way to be unsure instead of guessing confidently.

### 4.5 Self-reported confidence

`confidence` is part of the schema, and the UI shows it when it is not `high`. It is the
model's own estimate, not a calibrated probability, so it is used only to tell a person
*where to look first*, never to gate anything automatically.

### 4.6 Effort

`output_config.effort: 'low'`. Naming a visible object is a short, concrete judgement;
higher effort spends more tokens on reasoning without changing the answer. Effort is the
first lever to tune per task — low for classification like this, high where correctness
depends on multi-step reasoning (the layout checker, if it is built later, is the
opposite case).

### 4.7 Human-in-the-loop

The AI's answer is a draft. Any member who may upload models can open **Details**, fix
the fields and save; the row is then marked `ai_status = 'edited'`, which records that a
person approved it and lets a future bulk re-run skip it. This is both a usability
decision and an honesty one: the system never presents a generated guess as verified
fact, and the correction path is one click away.

### 4.8 Failure is normal, not exceptional

`generateMetadata()` never throws. Four things can go wrong — no API key, no usable
thumbnail, the request is declined (`stop_reason === 'refusal'`), or the call fails — and
in every case the row is marked `failed` with the reason stored in `ai_error`. The model
itself stays uploaded, viewable and downloadable. The UI shows "Analysis failed" and a
**Re-run AI** button. A feature that enriches data must never be able to block the data.

## 5. Cost and latency

One request per model: roughly 400-900 input tokens (a 256x256 image is on the order of
a few hundred tokens, plus a short prompt) and under 150 output tokens. At Claude Opus 5.5
rates ($4 per million input, $20 per million output) that is well under one cent per
model — a few cents for a library of a hundred. Latency is a few seconds, which the
background job hides. `ANTHROPIC_MODEL` can point at a cheaper model (for example
`claude-haiku-4-5`) for bulk imports without touching the code.

## 6. How this could be evaluated (for the thesis)

The honest way to claim the feature works is to measure it:

1. Build a small labelled set — 30-50 GLB models with a human-written name and category.
2. **Category accuracy**: exact match against the human label. Report a confusion matrix;
   the interesting cases are the pairs the model mixes up (machine vs workbench).
3. **Name quality**: have two people rate each generated name as usable / usable after an
   edit / wrong, and report agreement between the raters as well.
4. **Calibration**: compare accuracy on `high` confidence answers against `low` ones. If
   they are the same, the confidence field carries no information.
5. **Edit rate in use**: what fraction of entries a person changes afterwards — the metric
   that matters most, because it measures the work actually saved.
6. Repeat with a cheaper model to show the cost-quality tradeoff.

## 7. Limitations

- A single rendered view can be ambiguous; a cabinet and a control panel look alike from
  one angle. Several views would improve accuracy at proportionally higher cost.
- The model knows generic equipment types, not this factory's naming conventions. Feeding
  a few of the organisation's existing entries into the prompt (few-shot) would adapt the
  wording, at the cost of a longer, more expensive prompt.
- Answers are not deterministic: the same model can be described slightly differently on a
  re-run.
- The uploader's thumbnail, not the GLB, is what the model sees. A model that fails to
  render gets no description at all.

## 8. Configuration

```
ANTHROPIC_API_KEY=sk-ant-...        # required; without it the feature stays off
ANTHROPIC_MODEL=claude-opus-5-5     # optional override
```

Without the key the application behaves exactly as before: uploads work, previews work,
and the AI buttons do not appear.
