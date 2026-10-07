// Gemini (Google) implementation of the model-description request.
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

export const name = 'gemini';
// Which models the free tier covers changes over time; check the rate-limit page in
// Google AI Studio and set GEMINI_MODEL if this one is not available to your key.
export const defaultModel = 'gemini-3.8-flash';

export function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

let client;
function getClient() {
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

// Gemini takes a plain JSON Schema. The Zod schema stays the single source of truth;
// the "$schema" marker is metadata the API does not need.
function toJsonSchema(schema) {
  const { $schema, ...jsonSchema } = z.toJSONSchema(schema);
  return jsonSchema;
}

/** Same contract as the Anthropic implementation; see ai-providers/anthropic.js. */
export async function describe({ system, image, text, schema, maxTokens, timeoutMs, maxRetries }) {
  const model = process.env.GEMINI_MODEL || defaultModel;
  const interaction = await getClient().interactions.create(
    {
      model,
      system_instruction: system,
      input: [
        { type: 'image', data: image.data, mime_type: image.mediaType },
        { type: 'text', text },
      ],
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: toJsonSchema(schema),
      },
      generation_config: {
        // Same reasoning as Claude's effort setting: a short, concrete judgement.
        thinking_level: 'low',
        max_output_tokens: maxTokens,
      },
    },
    { timeout: timeoutMs, maxRetries }
  );

  if (!interaction.output_text) throw new Error('The model returned no answer');
  let parsed;
  try {
    parsed = JSON.parse(interaction.output_text);
  } catch {
    throw new Error('The model returned malformed JSON');
  }
  // The API is asked to follow the schema; we still check, so both providers hand the
  // rest of the application data that has passed the exact same validation.
  const checked = schema.safeParse(parsed);
  return {
    output: checked.success ? checked.data : null,
    model,
    usage: {
      input_tokens: interaction.usage?.total_input_tokens ?? 0,
      output_tokens: interaction.usage?.total_output_tokens ?? 0,
    },
  };
}
