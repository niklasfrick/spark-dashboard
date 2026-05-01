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
])

/**
 * Providers whose local asset is not an SVG. Most assets are SVGs, so SVG
 * stays the default — add an entry here only when a vector logo isn't
 * available and a raster fallback is shipped instead.
 */
const SLUG_EXTENSION: Record<string, string> = {
  unsloth: 'webp',
  huggingfacetb: 'webp',
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

function buildLogo(slug: string, alt: string): ProviderLogo {
  const ext = SLUG_EXTENSION[slug] ?? 'svg'
  return { url: `${ASSET_BASE}/${slug}.${ext}`, alt, slug }
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
  const slashIdx = trimmed.indexOf('/')
  if (slashIdx > 0) {
    const rawPrefix = trimmed.slice(0, slashIdx).trim()
    if (rawPrefix) {
      const normalized = rawPrefix.toLowerCase()
      const slug =
        ORG_ALIAS[normalized] ?? (ORG_IDENTITY.has(normalized) ? normalized : null)
      if (slug) return buildLogo(slug, rawPrefix)
    }
    return null
  }

  // No org prefix — fall back to keyword scan across the full model name.
  const haystack = trimmed.toLowerCase()
  for (const { keyword, slug, alt } of KEYWORD_FALLBACKS) {
    if (haystack.includes(keyword)) return buildLogo(slug, alt)
  }

  return null
}
