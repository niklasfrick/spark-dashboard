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
])

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
  { keyword: 'gpt-', slug: 'openai', alt: 'OpenAI' },
]

const ASSET_BASE = '/icons/providers'

function buildLogo(slug: string, alt: string): ProviderLogo {
  return { url: `${ASSET_BASE}/${slug}.svg`, alt, slug }
}

export function getProviderLogo(modelName: string | null | undefined): ProviderLogo | null {
  if (!modelName) return null

  const trimmed = modelName.trim()
  if (!trimmed) return null

  // 1) Prefer explicit `Org/Model` prefix resolution.
  const slashIdx = trimmed.indexOf('/')
  if (slashIdx > 0) {
    const rawPrefix = trimmed.slice(0, slashIdx).trim()
    if (rawPrefix) {
      const normalized = rawPrefix.toLowerCase()
      const slug =
        ORG_ALIAS[normalized] ?? (ORG_IDENTITY.has(normalized) ? normalized : null)
      if (slug) return buildLogo(slug, rawPrefix)
    }
  }

  // 2) Fall back to keyword scan across the full model name.
  const haystack = trimmed.toLowerCase()
  for (const { keyword, slug, alt } of KEYWORD_FALLBACKS) {
    if (haystack.includes(keyword)) return buildLogo(slug, alt)
  }

  return null
}
