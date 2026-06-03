/**
 * llm_client.mjs — LM Studio API client for event-os-core TAP layer
 *
 * Thin wrapper around the LM Studio local inference endpoint.
 * Temperature is set low to maximize output stability.
 *
 * CONTRACT:
 *   - READ ONLY from LLM perspective (sends prompts, receives suggestions)
 *   - Never writes events, never acquires leases
 *   - All LLM output is ADVISORY only
 *
 * Status: FUNCTIONAL (requires LM Studio daemon running at localhost:1234)
 */

const DEFAULT_ENDPOINT = 'http://localhost:1234/v1/chat/completions';
const DEFAULT_MODEL    = 'Qwen3-Zero-Coder-Reasoning-V2-0.8B-NEO-EX-IQ4_XS';
const SYSTEM_PROMPT    = `You are the TAP planning layer for an event-sourced control plane.
Output structured JSON only. Follow the provided schema exactly.
You may normalize ideas and propose architecture.
You never create tasks directly; architecture projection creates tasks.
Never score scheduler decisions, validate bridge tokens, acquire leases, or write events.
Your role: OBSERVE, ANALYZE, COMPILE ARCHITECTURE, SUGGEST.`;

/**
 * Call the LM Studio inference endpoint.
 *
 * @param {string} userPrompt
 * @param {object} context       — context object from context_builder.mjs
 * @param {object} [options]
 * @param {string} [options.model]
 * @param {number} [options.temperature]
 * @param {string} [options.endpoint]
 * @returns {Promise<string>}    parsed LLM response text
 */
export async function callLLM(userPrompt, context, options = {}) {
  const endpoint    = options.endpoint    ?? DEFAULT_ENDPOINT;
  const model       = options.model       ?? DEFAULT_MODEL;
  const temperature = options.temperature ?? 0.05;

  const payload = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: JSON.stringify({ prompt: userPrompt, context }) },
    ],
    temperature,
    stream: false,
  };

  let response;
  try {
    response = await fetch(endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  } catch (e) {
    throw new Error(`LM Studio unreachable at ${endpoint}: ${e.message}. Run: bash lmstudio/install.sh`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`LM Studio returned ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

/**
 * Call the LLM and parse the response as JSON.
 * Returns null if parsing fails (LLM returned invalid JSON).
 *
 * @param {string} userPrompt
 * @param {object} context
 * @param {object} [options]
 * @returns {Promise<object|null>}
 */
export async function callLLMJson(userPrompt, context, options = {}) {
  const raw = await callLLM(userPrompt, context, options);
  try {
    // LLMs sometimes wrap JSON in markdown code fences — strip them
    const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}
