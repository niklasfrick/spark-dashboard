import type { EngineSnapshot } from '@/types/metrics'

export interface ProviderLogo {
  url: string
  alt: string
  slug: string
}

/**
 * Maps a normalized (lowercased) HuggingFace-style org prefix to the local
 * SVG slug under `public/icons/providers/`. Add an entry here (and ship the
 * matching `<slug>.svg` file) to support new providers.
 */
const ORG_ALIAS: Record<string, string> = {
  mistralai: 'mistral-ai',
  'deepseek-ai': 'deepseek',
  'meta-llama': 'meta',
  moonshotai: 'moonshot-ai',
  'unsloth-ai': 'unsloth',
  zai: 'z-ai',
  'zai-org': 'z-ai',
  minimaxai: 'minimax',
  'minimax-ai': 'minimax',
  liquidai: 'liquid-ai',
}

/** Providers whose HF org prefix (lowercased) matches the local slug exactly. */
const ORG_IDENTITY: ReadonlySet<string> = new Set([
  'qwen',
  'google',
  'openai',
  'microsoft',
  'meta',
  'nvidia',
  'deepseek',
  'mistral-ai',
  'moonshot-ai',
  'unsloth',
  'z-ai',
  'minimax',
  'huggingfacetb',
  'intel',
  'liquid-ai',
  'baai',
  'baidu',
])

/**
 * Providers whose local asset is not an SVG. Most assets are SVGs, so SVG
 * stays the default — add an entry here only when a vector logo isn't
 * available and a raster fallback is shipped instead.
 */
const SLUG_EXTENSION: Record<string, string> = {
  unsloth: 'webp',
  huggingfacetb: 'webp',
  baai: 'webp',
  baidu: 'webp',
}

/**
 * Keyword fallback used when the model name has no `Org/` prefix, or the
 * prefix is unrecognized. Maps a case-insensitive substring to the local
 * slug and a display-friendly label. Order matters — more specific keywords
 * should come first so `mixtral` matches mistral-ai, not the other way around.
 */
const KEYWORD_FALLBACKS: { keyword: string; slug: string; alt: string }[] = [
  { keyword: 'qwen', slug: 'qwen', alt: 'Qwen' },
  { keyword: 'deepseek', slug: 'deepseek', alt: 'DeepSeek' },
  { keyword: 'mixtral', slug: 'mistral-ai', alt: 'Mistral AI' },
  { keyword: 'mistral', slug: 'mistral-ai', alt: 'Mistral AI' },
  { keyword: 'llama', slug: 'meta', alt: 'Meta' },
  { keyword: 'gemma', slug: 'google', alt: 'Google' },
  { keyword: 'gemini', slug: 'google', alt: 'Google' },
  { keyword: 'phi-', slug: 'microsoft', alt: 'Microsoft' },
  { keyword: 'kimi', slug: 'moonshot-ai', alt: 'Moonshot AI' },
  { keyword: 'glm-', slug: 'z-ai', alt: 'Z.ai' },
  { keyword: 'minimax', slug: 'minimax', alt: 'MiniMax' },
  { keyword: 'gpt-', slug: 'openai', alt: 'OpenAI' },
  { keyword: 'lfm', slug: 'liquid-ai', alt: 'LiquidAI' },
]

const ASSET_BASE = '/icons/providers'

/**
 * The provider a model name spells out before its first `/` (`Qwen/Qwen3-8B` ->
 * `Qwen`), as written and trimmed; null when the name has no `/`, nothing
 * precedes it, or the name is empty. The one place a name is cut at its prefix.
 */
export function providerPrefix(modelName: string | null | undefined): string | null {
  const trimmed = modelName?.trim()
  if (!trimmed) return null
  const slashIdx = trimmed.indexOf('/')
  if (slashIdx <= 0) return null
  return trimmed.slice(0, slashIdx).trim() || null
}

function buildLogo(slug: string, alt: string): ProviderLogo {
  const ext = SLUG_EXTENSION[slug] ?? 'svg'
  return { url: `${ASSET_BASE}/${slug}.${ext}`, alt, slug }
}

/** The mark of an organization a model name spells out, through the alias
 *  tables; null for one no mark is shipped for. Labelled with the
 *  organization as written. */
function orgLogo(rawOrg: string): ProviderLogo | null {
  const normalized = rawOrg.toLowerCase()
  const slug = ORG_ALIAS[normalized] ?? (ORG_IDENTITY.has(normalized) ? normalized : null)
  return slug ? buildLogo(slug, rawOrg) : null
}

export function getProviderLogo(modelName: string | null | undefined): ProviderLogo | null {
  if (!modelName) return null

  const trimmed = modelName.trim()
  if (!trimmed) return null

  // When an explicit `Org/Model` prefix is present, the org is authoritative:
  // resolve strictly from the prefix and do NOT fall back to keyword matching
  // across the model slug (which would misattribute e.g. `custom-org/llama-3b`
  // to Meta). The aggregator handles the "unknown prefix" case by labeling the
  // chip with the raw prefix.
  if (trimmed.indexOf('/') > 0) {
    const prefix = providerPrefix(trimmed)
    return prefix ? orgLogo(prefix) : null
  }

  // No org prefix — fall back to keyword scan across the full model name.
  const haystack = trimmed.toLowerCase()
  for (const { keyword, slug, alt } of KEYWORD_FALLBACKS) {
    if (haystack.includes(keyword)) return buildLogo(slug, alt)
  }

  return null
}

/** Registry hosts that serve a Hugging Face repository to Ollama under its own
 *  organization: `hf.co/<org>/<repo>:<quant>`. */
const HUGGING_FACE_HOSTS: ReadonlySet<string> = new Set(['hf.co', 'huggingface.co'])

/**
 * The organization a model name spells out — `org/model:tag`, or a Hugging Face
 * pull, `hf.co/org/model:tag` — as written; null for any other shape. A bare
 * `tinyllama:latest` names none, and neither does a host.
 */
export function modelNamespace(modelName: string | null | undefined): string | null {
  const parts = modelName?.trim().split('/') ?? []
  const fromHuggingFace = parts.length > 0 && HUGGING_FACE_HOSTS.has(parts[0].toLowerCase())
  if (fromHuggingFace) return parts.length === 3 ? providerPrefix(parts.slice(1).join('/')) : null
  return parts.length === 2 ? providerPrefix(modelName) : null
}

/**
 * The provider of a model an Ollama engine has loaded — read only from an
 * organization its name spells out (`modelNamespace`), never from a keyword in
 * it. Ollama names a model by its pull reference, so `tinyllama:latest` carries
 * "llama" without being Meta's, and `qwen3:8b` names no organization at all:
 * where the name does not say, no mark is better than a guessed one.
 */
export function getNamespacedProviderLogo(modelName: string | null | undefined): ProviderLogo | null {
  const org = modelNamespace(modelName)
  return org ? orgLogo(org) : null
}

/**
 * The provider mark for an engine as a whole. A single-model engine type is
 * marked by its model, exactly as `getProviderLogo` reads it. An engine holding
 * a list of models (Ollama) is marked only when it holds exactly one and that
 * model's name spells out its provider: with none loaded there is nothing to
 * mark, and with several one mark would claim one provider for all of them.
 */
export function engineProviderLogo(
  engine: Pick<EngineSnapshot, 'model' | 'loaded_models'>,
): ProviderLogo | null {
  const loaded = engine.loaded_models
  if (loaded == null) return getProviderLogo(engine.model?.name)
  return loaded.length === 1 ? getNamespacedProviderLogo(loaded[0].name) : null
}
