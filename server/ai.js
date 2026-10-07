// Automatic metadata for uploaded 3D models.
//
// A GLB file arrives with a name like "038_Giraffaxon_Art.glb", which tells a planner
// nothing. We send Claude two things the browser already produced at upload time — the
// thumbnail image and the model's real size from its bounding box — and ask for a short
// catalogue entry: a readable name, one category from a fixed list, a few tags and one
// sentence of description.
//
// Two design choices worth noting:
//
//   * The answer is a *structured output*: we hand the API a schema (below) and the model
//     is constrained to produce JSON matching it, so the server never parses free text.
//   * Measurements are NOT asked of the model. Sizes come from the geometry itself, which
//     is exact; the model only judges what the object *is*, which is what vision is for.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

// One Claude request per model is enough, and the answer is short.
const MAX_TOKENS = 1000;

// Default is Anthropic's current flagship; override per deployment, e.g. a cheaper model
// for bulk imports, without touching the code.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';

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

export function isEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// Thumbnails are stored as data URLs ("data:image/webp;base64,AAAA..."), while the API
// wants the media type and the payload separately.
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

let client;
function getClient() {
  // Constructed lazily so the server still starts when the key is absent.
  if (!client) client = new Anthropic();
  return client;
}

/**
 * Asks Claude to describe one model.
 *
 * @returns {Promise<{metadata: object, model: string, usage: object}>}
 * @throws if the feature is disabled, the thumbnail is unusable, the request is
 *         declined, or the API call fails. Callers treat every failure the same way:
 *         the upload itself stays valid, only the extra metadata is missing.
 */
export async function describeModel({ filename, thumbnail, dimensions }) {
  if (!isEnabled()) throw new Error('AI metadata is disabled (ANTHROPIC_API_KEY is not set)');
  const image = parseDataUrl(thumbnail);
  if (!image) throw new Error('This model has no usable preview image');

  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    // Naming the object is a short, concrete judgement, so the cheapest reasoning
    // setting is enough; raising it costs tokens without changing the answer.
    output_config: {
      effort: 'low',
      format: zodOutputFormat(ModelMetadata),
    },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: image.mediaType, data: image.data },
          },
          {
            type: 'text',
            text: `File name: ${filename}\n${describeSize(dimensions)}`,
          },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('The request was declined by the model');
  }
  const metadata = response.parsed_output;
  if (!metadata) throw new Error('The model did not return a usable answer');

  return {
    metadata: {
      ...metadata,
      // Keep the catalogue tidy: lowercase, de-duplicated, at most six tags.
      tags: [...new Set(metadata.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(
        0,
        6
      ),
    },
    model: response.model,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}
