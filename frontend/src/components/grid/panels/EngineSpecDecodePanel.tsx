import { SpecDecodeSection, SPEC_DECODE_ROWS } from '@/components/engines/EnginePanelPrimitives'
import { EnginePanelBody } from './EnginePanelBody'
import { engineIdentity, engineLabel } from './engineLabel'
import { EnginePanelNotice, PanelNotice } from './PanelNotice'
import { useEnginePanel } from './useEnginePanel'
import type { PanelContentProps } from '../panelRegistry'

/**
 * How well speculative decoding is paying off: the token acceptance rate, the
 * mean accepted length, and the cumulative draft and accepted counters.
 *
 * The panel is its own placeable type rather than a corner of the cache panel,
 * because on the engines that run it, acceptance is the number that explains
 * the throughput — and on the engines that do not, it is dead space.
 */
export function EngineSpecDecodePanel({ panel }: PanelContentProps) {
  const resolution = useEnginePanel(panel)
  if (resolution.status !== 'resolved' && resolution.status !== 'aggregate') {
    return <EnginePanelNotice resolution={resolution} />
  }

  const { metric } = resolution
  const draftTokens = metric('spec_decode_draft_tokens_total')
  const drafts = metric('spec_decode_drafts_total')
  const acceptanceRate = metric('spec_decode_acceptance_rate')
  const meanAcceptanceLength = metric('spec_decode_mean_acceptance_length')

  // Speculative decoding is configured when any field speaks for it. vLLM
  // answers with its lifetime counters, present only with a drafter and at
  // zero until it drafts. SGLang has no token counters: it answers with its
  // acceptance gauges once it has verified a draft, and with its draft-round
  // count — zero until then — whenever it says it runs a drafter. An engine
  // with none of these fields runs no drafter.
  //
  // The engine is named on a multi-engine host for the same reason its data
  // would be: with two engines on a page, "this engine" does not say which.
  const configured = [draftTokens, drafts, acceptanceRate, meanAcceptanceLength].some(
    (value) => value !== null,
  )
  if (!configured) {
    // Under the aggregate the absence speaks for every model at once, so
    // naming one would be wrong.
    if (resolution.status === 'aggregate') {
      return <PanelNotice>No model is using speculative decoding.</PanelNotice>
    }
    const subject = engineLabel(resolution) ?? 'This engine'
    return <PanelNotice>{`${subject} is not using speculative decoding.`}</PanelNotice>
  }

  // Configured, and nothing drafted yet: no drafted volume on either
  // engine's counter and no acceptance figure. The wait is the truth, so the
  // panel says "not yet" rather than showing an all-dashes section that looks
  // like a fault.
  const drafted = (draftTokens ?? 0) > 0 || (drafts ?? 0) > 0
  if (!drafted && acceptanceRate === null && meanAcceptanceLength === null) {
    if (resolution.status === 'aggregate') {
      return <PanelNotice>No model has drafted a token yet.</PanelNotice>
    }
    const subject = engineLabel(resolution) ?? 'This engine'
    return <PanelNotice>{`${subject} has drafted no tokens yet.`}</PanelNotice>
  }

  return (
    <EnginePanelBody
      identity={engineIdentity(resolution)}
      tileRows={SPEC_DECODE_ROWS}
      tiles={
        <SpecDecodeSection
          acceptanceRate={metric('spec_decode_acceptance_rate')}
          acceptanceRateLive={metric('spec_decode_acceptance_rate_live')}
          meanAcceptanceLength={metric('spec_decode_mean_acceptance_length')}
          acceptedTokens={metric('spec_decode_accepted_tokens_total')}
          draftTokens={draftTokens}
        />
      }
    />
  )
}
