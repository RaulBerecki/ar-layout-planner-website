// Claude (Anthropic) implementation of the model-description request.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

export const name = 'anthropic';
export const defaultModel = 'claude-opus-5-5';

export function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

let client;
function getClient() {
  // Constructed lazily so the server still starts when the key is absent.
  if (!client) client = new Anthropic();
  return client;
}

/**
 * @param {object} req
 * @param {string} req.system      instructions shared by every provider
 * @param {{mediaType: string, data: string}} req.image  base64 preview
 * @param {string} req.text        file name and measured size
 * @param {import('zod').ZodType} req.schema  expected answer shape
 * @param {number} req.maxTokens
 * @returns {Promise<{output: unknown, model: string, usage: {input_tokens: number, output_tokens: number}}>}
 */
export async function describe({ system, image, text, schema, maxTokens, timeoutMs, maxRetries }) {
  const response = await getClient().messages.parse(
    {
      model: process.env.ANTHROPIC_MODEL || defaultModel,
      max_tokens: maxTokens,
      system,
      // Naming a visible object is a short, concrete judgement: low effort is enough.
      output_config: { effort: 'low', format: zodOutputFormat(schema) },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: image.mediaType,
                data: image.data,
              },
            },
            { type: 'text', text },
          ],
        },
      ],
    },
    { timeout: timeoutMs, maxRetries }
  );

  if (response.stop_reason === 'refusal') throw new Error('The request was declined by the model');
  return {
    // Already validated against the schema by the SDK; null if it could not be.
    output: response.parsed_output,
    model: response.model,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}
