/**
 * Ollama engines as the backend puts them on the wire (#132), shared by the
 * specs that name, list or bind one. Not a spec itself: vitest only collects
 * `*.test.*`.
 */

import type { EngineSnapshot, LoadedModel } from '@/types/metrics'

/** Where an Ollama server listens unless `OLLAMA_HOST` says otherwise. */
export const OLLAMA_ENDPOINT = 'http://localhost:11434'

/**
 * tinyllama as a real Ollama 0.19.0 on a DGX Spark reported it from `/api/ps`
 * (`src/engines/fixtures/ollama_ps_loaded.json`), mapped field by field the
 * way the backend maps it. Fully resident in GPU memory, so VRAM equals size.
 */
export const TINYLLAMA: LoadedModel = {
  name: 'tinyllama:latest',
  parameter_size: '1B',
  quantization: 'Q4_0',
  size_bytes: 800454656,
  vram_bytes: 800454656,
  context_length: 2048,
  expires_at: '2026-10-16T10:54:20.322299928+02:00',
}

/**
 * A model pulled straight from Hugging Face, whose name carries its
 * organization — and, unlike tinyllama, only partly in VRAM. Not captured:
 * the shape is the capture's, the values are the second model a spec needs.
 */
export const HF_QWEN: LoadedModel = {
  name: 'hf.co/Qwen/Qwen3-8B-GGUF:Q4_K_M',
  parameter_size: '8.2B',
  quantization: 'Q4_K_M',
  size_bytes: 6 * 1024 ** 3,
  vram_bytes: 4 * 1024 ** 3,
  context_length: 4096,
  expires_at: null,
}

/**
 * An Ollama engine holding `loaded` — which the backend sorts by name, so
 * callers pass it sorted. What every Ollama snapshot carries regardless: no
 * single `model`, no metric group, and no flag that would turn one on.
 */
export function ollamaEngine(
  loaded: LoadedModel[],
  overrides: Partial<EngineSnapshot> = {},
): EngineSnapshot {
  return {
    engine_type: 'Ollama',
    endpoint: OLLAMA_ENDPOINT,
    status: { type: 'Running' },
    model: null,
    model_metadata_error: null,
    loaded_models: loaded,
    metric_groups: [],
    metrics_off: null,
    metrics: null,
    recent_requests: [],
    deployment_mode: 'Native',
    gpu_indexes: [],
    ...overrides,
  }
}
