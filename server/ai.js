// Automatic metadata for uploaded 3D models.
//
// A GLB file arrives with a name like "038_Giraffaxon_Art.glb", which tells a planner
// nothing. We send a vision model two things the browser already produced at upload
// time — the thumbnail image and the model's real size from its bounding box — and ask
// for a short catalogue entry: a readable name, one category from a fixed list, a few
// tags and one sentence of description.
//
// Design choices worth noting:
//
//   * The answer is a *structured output*: the API receives a schema (below) and must
//     produce JSON matching it, so the server never parses free text.
//   * Measurements are NOT asked of the model. Sizes come from the geometry itself, which
//     is exact; the model only judges what the object *is*, which is what vision is for.
//   * The provider is interchangeable. Everything that defines the task — prompt, schema,
//     categories, validation — lives here and is shared, so switching between Gemini and
//     Claude changes which model answers, not the question it is asked.
import { z } from 'zod';
import * as anthropic from './ai-providers/anthropic.js';
import * as gemini from './ai-providers/gemini.js';

const PROVIDERS = { gemini, anthropic };

// The answer is short; this is a ceiling, not an expected length.
const MAX_TOKENS = 1000;

// SDKs retry overloaded or rate-limited requests on their own, with growing pauses.
// Without a ceiling a busy free tier can keep one request alive for minutes, leaving the
// model stuck on "Analysing...". The timeout applies to each attempt, so the worst case
// is about (MAX_RETRIES + 1) x TIMEOUT_MS, here roughly 90 s; after that the attempt is
// recorded as failed and the person can retry.
const TIMEOUT_MS = 45_000;
const MAX_RETRIES = 1;

// Provider errors carry an HTTP status; turn the common ones into something a person
// can act on, instead of storing a raw JSON error body.
function explainProviderError(err, providerName) {
  const status = err?.status;
  if (status === 401 || status === 403) return `The ${providerName} API key was rejected`;
  if (status === 404) return `The configured ${providerName} model is not available to this key`;
  if (status === 429) return `${providerName} rate limit reached; try again in a minute`;
  if (status === 503 || status === 529) {
    return `${providerName} is overloaded right now; try again later`;
  }
  if (/timed? ?out/i.test(err?.message || '') || err?.name?.includes('Timeout')) {
    return `${providerName} did not answer in time; try again later`;
  }
  return err?.message || 'The AI request failed';
}

// A closed list keeps the data usable for filtering and for the layout rules that come
// later: free-form categories would drift ("robot", "robotic arm", "Roboter"...).
export const CATEGORIES = [
  'robot',
  'conveyor',
  'machine',
  'workbench',
  'storage',
  'safety',
  'agv',
  'tool',
  'furniture',
  'other',
];

export const CATEGORY_LABELS = {
  robot: 'Robot',
  conveyor: 'Conveyor',
  machine: 'Machine',
  workbench: 'Workbench',
  storage: 'Storage',
  safety: 'Safety equipment',
  agv: 'AGV / transport',
  tool: 'Tool',
  furniture: 'Furniture',
  other: 'Other',
};

const ModelMetadata = z.object({
  display_name: z
    .string()
    .describe('Short human-readable name for this object, 2-5 words, in English'),
  category: z.enum(CATEGORIES).describe('Single best category for this object'),
  tags: z
    .array(z.string())
    .describe('3 to 6 short lowercase keywords someone might search for'),
  description: z
    .string()
    .describe('One sentence describing what this object is and where it is used'),
  confidence: z
    .enum(['high', 'medium', 'low'])
    .describe('How clearly the image identifies the object'),
});

const SYSTEM_PROMPT = `You catalogue 3D models for a factory layout planning tool.

You are given a rendered preview of one 3D model, its file name and its real size in
metres (measured from the geometry, so trust it over your impression of the image).

Write a catalogue entry: a short name a factory planner would recognise, one category,
a few search keywords and one sentence of description.

Rules:
- Judge only what you can see. Never invent a manufacturer, model number or capability.
- The file name is a hint, not the truth; it is often meaningless (e.g. "038_Art_v2").
- Use the given measurements to tell similar shapes apart: a 0.2 m box is a tool or a
  part, a 2 m box is a cabinet or a machine.
- If the preview is unclear or the object is not factory equipment, pick the closest
  category (or "other"), describe what you actually see, and set confidence to "low".`;

/**
 * The provider in use: AI_PROVIDER when set, otherwise the first one with an API key.
 * Returns null when none is configured, which switches the feature off.
 */
export function activeProvider() {
  const requested = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (requested) {
    const provider = PROVIDERS[requested];
    return provider?.isConfigured() ? provider : null;
  }
  return Object.values(PROVIDERS).find((p) => p.isConfigured()) ?? null;
}

export function isEnabled() {
  return activeProvider() !== null;
}

// Thumbnails are stored as data URLs ("data:image/webp;base64,AAAA..."), while the APIs
// want the media type and the payload separately.
function parseDataUrl(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(
    dataUrl || ''
  );
  if (!match) return null;
  return { mediaType: match[1], data: match[2] };
}

function describeSize(dimensions) {
  if (!dimensions) return 'Real size: unknown.';
  const { width_m: w, depth_m: d, height_m: h } = dimensions;
  if (![w, d, h].every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return 'Real size: unknown.';
  }
  const fmt = (n) => (n < 0.1 ? `${Math.round(n * 1000)} mm` : `${n.toFixed(2)} m`);
  return `Real size (width x depth x height): ${fmt(w)} x ${fmt(d)} x ${fmt(h)}.`;
}

/**
 * Asks the configured model to describe one 3D model.
 *
 * @returns {Promise<{metadata: object, model: string, provider: string, usage: object}>}
 * @throws if the feature is disabled, the thumbnail is unusable, the request is
 *         declined, the answer does not match the schema, or the API call fails.
 *         Callers treat every failure the same way: the upload itself stays valid,
 *         only the extra metadata is missing.
 */
export async function describeModel({ filename, thumbnail, dimensions }) {
  const provider = activeProvider();
  if (!provider) throw new Error('AI metadata is disabled (no AI provider API key is set)');
  const image = parseDataUrl(thumbnail);
  if (!image) throw new Error('This model has no usable preview image');

  let result;
  try {
    result = await provider.describe({
      system: SYSTEM_PROMPT,
      image,
      text: `File name: ${filename}\n${describeSize(dimensions)}`,
      schema: ModelMetadata,
      maxTokens: MAX_TOKENS,
      timeoutMs: TIMEOUT_MS,
      maxRetries: MAX_RETRIES,
    });
  } catch (err) {
    throw new Error(explainProviderError(err, provider.name === 'gemini' ? 'Gemini' : 'Claude'));
  }
  const { output, model, usage } = result;
  if (!output) throw new Error('The model did not return a usable answer');

  return {
    metadata: {
      ...output,
      // Keep the catalogue tidy: lowercase, de-duplicated, at most six tags.
      tags: [...new Set(output.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(
        0,
        6
      ),
    },
    model,
    provider: provider.name,
    usage,
  };
}
