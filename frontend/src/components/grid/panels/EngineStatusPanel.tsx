import { getProviderLogo } from '@/lib/providerLogo'
import {
  engineDisplayName,
  formatEndpoint,
  formatGpuIndexes,
  modelMetadataWarning,
  shortModelName,
} from '@/lib/format'
import type { EngineSnapshot } from '@/types/metrics'
import { DeploymentChip, EngineChip, ProviderMark } from './engineIdentity'
import { EnginePanelNotice, PanelNotice } from './PanelNotice'
import { usePanelDevice } from '../panelDevice'
import { useEngineTarget } from './useEnginePanel'
import type { PanelContentProps } from '../panelRegistry'

/**
 * Which engine this is, and what it is serving — the identity the fixed
 * dashboard carried in its engine header, as a panel of its own.
 *
 * It is a panel rather than a row repeated on all six metric panels for the
 * obvious reason: an operator would then be reading the same model name and the
 * same chips six times over on one page. Placed once, it says what the metric
 * panels around it are measuring.
 *
 * Bound like every other engine panel, so a host running two models can put one
 * of these above each column.
 */
export function EngineStatusPanel({ panel }: PanelContentProps) {
  // The raw target, not `useEnginePanel`: an engine that is loading a model or
  // has stopped still has an identity, and that is exactly when an operator
  // wants to read it. Gating on metrics would blank the panel that explains why
  // there are none.
  const target = useEngineTarget(panel)
  usePanelDevice(target.status === 'resolved' ? formatEndpoint(target.engine.endpoint) : null)

  // The identity of "all models" is no identity at all: there is no one model,
  // status or deployment to describe. The "All Engines" overview panel is the
  // panel for that question, so the notice points at it rather than pretending.
  if (target.status === 'aggregate') {
    return (
      <PanelNotice>
        This page shows all models. Engine identity is per-engine — pin this panel to one engine,
        or use the “All Engines” panel.
      </PanelNotice>
    )
  }

  if (target.status !== 'resolved') return <EnginePanelNotice resolution={target} />

  return <EngineIdentity engine={target.engine} />
}

function EngineIdentity({ engine }: { engine: EngineSnapshot }) {
  const { model } = engine
  const logo = getProviderLogo(model?.name)
  const warning = modelMetadataWarning(engine.model_metadata_error)
  // The model is the headline; the endpoint is already on the frame's title
  // row, so repeating it here would spend the panel's widest line on it twice.
  // With no model to name, the absence is the headline — it is the thing an
  // operator has to act on, not a footnote under a blank line. When the
  // engine refused to say, the refusal is a better headline than a generic
  // absence: the model may well be loaded, only its name is unreadable.
  const headline = model?.name
    ? shortModelName(model.name)
    : warning
      ? 'Model name unavailable'
      : 'No model loaded'

  return (
    <div className="h-full min-h-0 flex flex-col gap-2 overflow-y-auto">
      <div className="shrink-0 flex items-center gap-2 min-w-0">
        {logo && <ProviderMark logo={logo} size="lg" />}
        <div className="min-w-0">
          <p
            className="text-sm font-semibold text-zinc-100 truncate leading-tight"
            title={model?.name ?? engine.endpoint}
          >
            {headline}
          </p>
          <p className="text-[11px] text-zinc-500 truncate leading-tight">
            {engineStatusLabel(engine)}
          </p>
        </div>
      </div>

      {/* The warning accompanies whatever name resolved rather than replacing
          it: the fallback from the launch command line is still the best
          guess there is, but an operator has to know it is only a guess —
          and how to make it not one. */}
      {warning && (
        <p role="alert" className="shrink-0 text-[11px] leading-snug text-amber-200">
          {warning}
        </p>
      )}

      {/* Everything the backend could tell us about the deployment and the
          weights, in the order the fixed dashboard showed it. Each is omitted
          when unknown rather than rendered as a dash — an absent chip reads as
          "not reported", which is what it means. */}
      <div className="flex items-start gap-1.5 flex-wrap content-start">
        <EngineChip label={engineDisplayName(engine.engine_type)} iconSrc="/icons/vllm.svg" />
        <DeploymentChip mode={engine.deployment_mode} />
        {engine.gpu_indexes && engine.gpu_indexes.length > 0 && (
          <EngineChip label={formatGpuIndexes(engine.gpu_indexes)} />
        )}
        {model?.parameter_size && <EngineChip label={model.parameter_size} />}
        {model?.precision && <EngineChip label={model.precision} />}
        {model?.quantization && <EngineChip label={model.quantization} />}
        {model?.tensor_type && <EngineChip label={model.tensor_type} />}
        {model?.model_type && <EngineChip label={model.model_type} />}
        {model?.pipeline_tag && <EngineChip label={model.pipeline_tag} />}
      </div>
    </div>
  )
}

/**
 * What the engine is doing, in the operator's words rather than the wire's.
 * Deliberately says nothing about the model — that is the headline's job, and
 * an engine with metrics but no readable model is still serving.
 */
function engineStatusLabel(engine: EngineSnapshot): string {
  switch (engine.status.type) {
    case 'Error':
      return engine.status.message
    case 'Stopped':
      return 'Stopped'
    case 'Loading':
      return 'Loading'
    case 'Running':
      return 'Serving'
  }
}
