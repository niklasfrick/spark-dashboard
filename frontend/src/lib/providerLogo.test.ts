import { describe, it, expect } from 'vitest'
import {
  engineProviderLogo,
  getNamespacedProviderLogo,
  getProviderLogo,
  modelNamespace,
  providerPrefix,
} from './providerLogo'
import { HF_QWEN, TINYLLAMA, ollamaEngine } from '@/test/ollama'

describe('getProviderLogo', () => {
  it('resolves a Qwen prefix to the local qwen asset', () => {
    const logo = getProviderLogo('Qwen/Qwen2.5-7B-Instruct')
    expect(logo).not.toBeNull()
    expect(logo?.slug).toBe('qwen')
    expect(logo?.alt).toBe('Qwen')
    expect(logo?.url).toBe('/icons/providers/qwen.svg')
  })

  it('maps mistralai (HF) to the mistral-ai asset', () => {
    const logo = getProviderLogo('mistralai/Mistral-7B-Instruct-v0.3')
    expect(logo?.slug).toBe('mistral-ai')
    expect(logo?.url).toBe('/icons/providers/mistral-ai.svg')
  })

  it('maps meta-llama to the meta asset', () => {
    expect(getProviderLogo('meta-llama/Llama-3.1-8B-Instruct')?.slug).toBe('meta')
  })

  it('maps deepseek-ai to the deepseek asset', () => {
    expect(getProviderLogo('deepseek-ai/DeepSeek-V3')?.slug).toBe('deepseek')
  })

  it('maps moonshotai to the moonshot-ai asset', () => {
    const logo = getProviderLogo('moonshotai/Kimi-K2-Instruct')
    expect(logo?.slug).toBe('moonshot-ai')
    expect(logo?.url).toBe('/icons/providers/moonshot-ai.svg')
  })

  it('maps unsloth to the unsloth webp asset', () => {
    const logo = getProviderLogo('unsloth/Llama-3.2-3B-Instruct')
    expect(logo?.slug).toBe('unsloth')
    expect(logo?.url).toBe('/icons/providers/unsloth.webp')
  })

  it('maps HuggingFaceTB to the huggingfacetb webp asset', () => {
    const logo = getProviderLogo('HuggingFaceTB/SmolLM-1.7B-Instruct')
    expect(logo?.slug).toBe('huggingfacetb')
    expect(logo?.alt).toBe('HuggingFaceTB')
    expect(logo?.url).toBe('/icons/providers/huggingfacetb.webp')
  })

  it('maps zai-org to the z-ai asset', () => {
    const logo = getProviderLogo('zai-org/GLM-4.5')
    expect(logo?.slug).toBe('z-ai')
    expect(logo?.url).toBe('/icons/providers/z-ai.svg')
  })

  it('maps minimaxai to the minimax asset', () => {
    const logo = getProviderLogo('MiniMaxAI/MiniMax-M1-80k')
    expect(logo?.slug).toBe('minimax')
    expect(logo?.url).toBe('/icons/providers/minimax.svg')
  })

  it('maps LiquidAI to the liquid-ai asset', () => {
    const logo = getProviderLogo('LiquidAI/LFM2-1.2B')
    expect(logo?.slug).toBe('liquid-ai')
    expect(logo?.alt).toBe('LiquidAI')
    expect(logo?.url).toBe('/icons/providers/liquid-ai.svg')
  })

  it('keyword-matches a bare LFM model id to liquid-ai', () => {
    expect(getProviderLogo('lfm2-1.2b')?.slug).toBe('liquid-ai')
    expect(getProviderLogo('LFM-40B')?.slug).toBe('liquid-ai')
  })

  it('maps BAAI to the baai webp asset', () => {
    const logo = getProviderLogo('BAAI/bge-m3')
    expect(logo?.slug).toBe('baai')
    expect(logo?.alt).toBe('BAAI')
    expect(logo?.url).toBe('/icons/providers/baai.webp')
  })

  it('maps baidu to the baidu webp asset', () => {
    const logo = getProviderLogo('baidu/ERNIE-4.5-21B-A3B-PT')
    expect(logo?.slug).toBe('baidu')
    expect(logo?.alt).toBe('baidu')
    expect(logo?.url).toBe('/icons/providers/baidu.webp')
  })

  it('maps Intel to the intel asset', () => {
    const logo = getProviderLogo('Intel/neural-chat-7b-v3-3')
    expect(logo?.slug).toBe('intel')
    expect(logo?.alt).toBe('Intel')
    expect(logo?.url).toBe('/icons/providers/intel.svg')
  })

  it('keyword-matches a glm model id to z-ai', () => {
    expect(getProviderLogo('glm-4.5-air')?.slug).toBe('z-ai')
  })

  it('keyword-matches a bare minimax model id', () => {
    expect(getProviderLogo('minimax-m1')?.slug).toBe('minimax')
  })

  it('is case-insensitive on the org prefix', () => {
    expect(getProviderLogo('QWEN/Qwen2.5')?.slug).toBe('qwen')
    expect(getProviderLogo('OpenAI/gpt-oss')?.slug).toBe('openai')
  })

  // Keyword fallback — when the model name has no Org/ prefix or an unknown one.
  it('keyword-matches a bare qwen model id', () => {
    expect(getProviderLogo('qwen2.5-7b-instruct')?.slug).toBe('qwen')
  })

  it('keyword-matches a llama model id to meta', () => {
    expect(getProviderLogo('llama-3.1-8b-instruct')?.slug).toBe('meta')
  })

  it('keyword-matches a mistral model id', () => {
    expect(getProviderLogo('mistral-7b-instruct-v0.3')?.slug).toBe('mistral-ai')
  })

  it('keyword-matches a mixtral model id to mistral-ai', () => {
    expect(getProviderLogo('mixtral-8x7b')?.slug).toBe('mistral-ai')
  })

  it('keyword-matches a deepseek model id', () => {
    expect(getProviderLogo('deepseek-v3')?.slug).toBe('deepseek')
  })

  it('treats an unknown Org/ prefix as authoritative and skips keyword fallback', () => {
    // `custom-org` is not a recognized provider, so even though the model slug
    // contains the `qwen` keyword, we must not misattribute it to Qwen.
    expect(getProviderLogo('custom-org/qwen2-rewrite')).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(getProviderLogo('some-random-org/model')).toBeNull()
    expect(getProviderLogo('totally-opaque-name')).toBeNull()
  })

  it('returns null for null or empty input', () => {
    expect(getProviderLogo(null)).toBeNull()
    expect(getProviderLogo(undefined)).toBeNull()
    expect(getProviderLogo('')).toBeNull()
    expect(getProviderLogo('/model')).toBeNull()
  })
})

// A model loaded into Ollama is named by its pull reference — `tinyllama:latest`,
// `qwen3:8b` — which says nothing about who trained it unless an organization
// is spelled out. Only that is read; a keyword is never guessed from (#132).
describe('getNamespacedProviderLogo', () => {
  it('reads the organization of an `org/model:tag` name through the alias tables', () => {
    expect(getNamespacedProviderLogo('qwen/qwen3:8b')?.slug).toBe('qwen')
    expect(getNamespacedProviderLogo('mistralai/mistral-small:24b')?.slug).toBe('mistral-ai')
  })

  it('reads the organization of a model pulled from Hugging Face', () => {
    const logo = getNamespacedProviderLogo('hf.co/Qwen/Qwen3-8B-GGUF:Q4_K_M')
    expect(logo?.slug).toBe('qwen')
    expect(logo?.alt).toBe('Qwen')
    expect(logo?.url).toBe('/icons/providers/qwen.svg')
    expect(getNamespacedProviderLogo('huggingface.co/unsloth/gemma-3-4b-it-GGUF')?.slug).toBe(
      'unsloth',
    )
  })

  it('guesses nothing from a bare name, however familiar its keyword', () => {
    // `tinyllama` is not Meta's model, and `qwen3:8b` names no organization.
    expect(getNamespacedProviderLogo('tinyllama:latest')).toBeNull()
    expect(getNamespacedProviderLogo('qwen3:8b')).toBeNull()
    expect(getNamespacedProviderLogo('llama3.1:8b')).toBeNull()
  })

  it('shows nothing for an organization it has no mark for', () => {
    expect(getNamespacedProviderLogo('hf.co/bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M')).toBeNull()
    expect(getNamespacedProviderLogo('someone/llama-finetune:latest')).toBeNull()
  })

  it('reads no organization from the registry host or a path it does not know', () => {
    // A host is not a provider, and a three-part name on another registry is
    // not one of the two forms that spell an organization out.
    expect(getNamespacedProviderLogo('hf.co/Qwen3-8B-GGUF')).toBeNull()
    expect(getNamespacedProviderLogo('registry.example.com/qwen/qwen3:8b')).toBeNull()
  })

  it('returns null for null or empty input', () => {
    expect(getNamespacedProviderLogo(null)).toBeNull()
    expect(getNamespacedProviderLogo(undefined)).toBeNull()
    expect(getNamespacedProviderLogo('')).toBeNull()
    expect(getNamespacedProviderLogo('/qwen3')).toBeNull()
  })
})

describe('modelNamespace', () => {
  it('reads the organization of the two shapes that spell one out, as written', () => {
    expect(modelNamespace('bartowski/phi-4:Q4_K_M')).toBe('bartowski')
    expect(modelNamespace('hf.co/Qwen/Qwen3-8B-GGUF:Q4_K_M')).toBe('Qwen')
    expect(modelNamespace('HuggingFace.co/unsloth/gemma-3-4b-it-GGUF')).toBe('unsloth')
  })

  it('reads none from a bare name, a bare host, or another registry', () => {
    expect(modelNamespace('tinyllama:latest')).toBeNull()
    expect(modelNamespace('hf.co/Qwen3-8B-GGUF')).toBeNull()
    expect(modelNamespace('registry.example.com/qwen/qwen3:8b')).toBeNull()
    expect(modelNamespace(null)).toBeNull()
  })
})

describe('engineProviderLogo', () => {
  it('keeps a single-model engine on its model’s logo, keyword fallback included', () => {
    const served = (name: string) => ({
      model: {
        name,
        parameter_size: null,
        quantization: null,
        precision: null,
        tensor_type: null,
        model_type: null,
        pipeline_tag: null,
      },
    })
    expect(engineProviderLogo(served('Qwen/Qwen3-8B'))?.slug).toBe('qwen')
    expect(engineProviderLogo(served('llama-3.1-8b-instruct'))?.slug).toBe('meta')
    expect(engineProviderLogo({ model: null })).toBeNull()
  })

  it('marks an Ollama engine only when it holds exactly one model that names its provider', () => {
    expect(engineProviderLogo(ollamaEngine([HF_QWEN]))?.slug).toBe('qwen')
    expect(engineProviderLogo(ollamaEngine([TINYLLAMA]))).toBeNull()
  })

  it('marks an Ollama engine with nothing loaded, or several models, with nothing', () => {
    // One mark would claim one provider for an engine serving several.
    expect(engineProviderLogo(ollamaEngine([]))).toBeNull()
    expect(engineProviderLogo(ollamaEngine([HF_QWEN, TINYLLAMA]))).toBeNull()
    expect(
      engineProviderLogo(
        ollamaEngine([HF_QWEN, { ...HF_QWEN, name: 'hf.co/Qwen/Qwen3-4B-GGUF:Q8_0' }]),
      ),
    ).toBeNull()
  })
})

describe('providerPrefix', () => {
  it('reads what precedes the first slash, as written and trimmed', () => {
    expect(providerPrefix('Qwen/Qwen3-8B')).toBe('Qwen')
    expect(providerPrefix('  custom-org /llama-3b ')).toBe('custom-org')
    expect(providerPrefix('hf.co/Qwen/Qwen3-8B-GGUF:Q4_K_M')).toBe('hf.co')
  })

  it('reads nothing from a name without a prefix', () => {
    expect(providerPrefix('tinyllama:latest')).toBeNull()
    expect(providerPrefix('/model')).toBeNull()
    expect(providerPrefix('  ')).toBeNull()
    expect(providerPrefix(null)).toBeNull()
    expect(providerPrefix(undefined)).toBeNull()
  })
})
