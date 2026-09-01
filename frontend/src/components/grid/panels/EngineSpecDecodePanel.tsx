import { SpecDecodeSection } from '@/components/engines/EngineCardPrimitives'
import { EnginePanelBody } from './EnginePanelBody'
import { engineLabel } from './engineLabel'
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
  if (resolution.status !== 'resolved') return <EnginePanelNotice resolution={resolution} />

  const { metric } = resolution
  const draftTokens = metric('spec_decode_draft_tokens_total')

  // The counter is present whenever speculative decoding is configured, and
  // sits at zero on an engine that has not drafted anything yet. Gating on a
  // drafted token keeps the panel from showing an all-dashes section that
  // looks like a fault.
  if (draftTokens === null || draftTokens === 0) {
    return (
      <PanelNotice>
        {draftTokens === null
          ? 'This engine is not using speculative decoding.'
          : 'No tokens drafted yet.'}
      </PanelNotice>
    )
  }

  return (
    <EnginePanelBody
      label={engineLabel(resolution)}
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
