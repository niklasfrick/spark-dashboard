import { describe, it, expect } from 'vitest'
import { getProviderLogo } from './providerLogo'

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
