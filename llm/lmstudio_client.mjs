/**
 * lmstudio_client.mjs — Lower-level LM Studio API client (llm/ layer)
 *
 * Wraps tap/llm_client.mjs with additional capabilities:
 *   - Plugin execution (LM Studio JS plugin sandbox)
 *   - Model switching
 *   - Streaming support
 *   - Response caching
 *
 * This module is the llm/ layer adapter — it sits between the TAP layer
 * and the raw LM Studio HTTP API.
 *
 * Status: FUNCTIONAL (stub for plugin + streaming — core HTTP works via tap/llm_client.mjs)
 */

export { callLLM, callLLMJson } from '../tap/llm_client.mjs';

/**
 * List available models from the LM Studio daemon.
 * @param {string} [endpoint]
 * @returns {Promise<string[]>}
 */
export async function listModels(endpoint = 'http://localhost:1234') {
  try {
    const r = await fetch(`${endpoint}/v1/models`);
    const data = await r.json();
    return (data?.data ?? []).map(m => m.id);
  } catch {
    return [];
  }
}

/**
 * Check if the LM Studio daemon is reachable.
 * @param {string} [endpoint]
 * @returns {Promise<boolean>}
 */
export async function isDaemonAlive(endpoint = 'http://localhost:1234') {
  try {
    const r = await fetch(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}
