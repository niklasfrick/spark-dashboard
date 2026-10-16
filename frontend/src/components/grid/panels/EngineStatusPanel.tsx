import { engineProviderLogo, getNamespacedProviderLogo } from '@/lib/providerLogo'
import {
  NO_MODEL_LOADED,
  engineDisplayName,
  engineIconPath,
  engineModelLabel,
  formatContextLength,
  formatEndpoint,
  formatGpuIndexes,
  formatLoadedModelSize,
  formatUnloadTime,
  modelMetadataWarning,
  shortModelName,
} from '@/lib/format'
import type { EngineSnapshot, LoadedModel } from '@/types/metrics'
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
  const { model, loaded_models: loaded } = engine
  const logo = engineProviderLogo(engine)
  const warning = modelMetadataWarning(engine.model_metadata_error)
  // The model is the headline; the endpoint is already on the frame's title
  // row, so repeating it here would spend the panel's widest line on it twice.
  // With no model to name, the absence is the headline — it is the thing an
  // operator has to act on, not a footnote under a blank line. When the
  // engine refused to say, the refusal is a better headline than a generic
  // absence: the model may well be loaded, only its name is unreadable. An
  // engine holding a list of models (Ollama) is headlined by that list.
  const headline =
    engineModelLabel(engine) ?? (warning ? 'Model name unavailable' : NO_MODEL_LOADED)
  // The names in full, organization and all, for the headline's tooltip.
  const fullName = loaded ? loaded.map(({ name }) => name).join(', ') || null : model?.name

  return (
    // One wrapping row rather than a column: in a panel as wide as the page
    // and one row tall — the Legacy layout's header — the chips sit beside the
    // headline instead of being pushed below the panel's edge, and in a
    // narrower panel they wrap under it as they always did.
    <div className="h-full min-h-0 flex flex-wrap items-center content-start gap-x-4 gap-y-2 overflow-y-auto">
      <div className="max-w-full flex items-center gap-2 min-w-0">
        {logo && <ProviderMark logo={logo} size="lg" />}
        <div className="min-w-0">
          <p
            className="text-sm font-semibold text-zinc-100 truncate leading-tight"
            title={fullName ?? engine.endpoint}
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
        <p role="alert" className="basis-full text-[11px] leading-snug text-amber-200">
          {warning}
        </p>
      )}

      {/* Everything the backend could tell us about the deployment and the
          weights, in the order the fixed dashboard showed it. Each is omitted
          when unknown rather than rendered as a dash — an absent chip reads as
          "not reported", which is what it means. */}
      <div className="min-w-0 max-w-full flex items-start gap-1.5 flex-wrap content-start">
        <EngineChip
          label={engineDisplayName(engine.engine_type)}
          iconSrc={engineIconPath(engine.engine_type)}
        />
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

      {/* An engine holding a list of models (Ollama) itemizes it under the
          chips. With none loaded there is nothing to list: the headline
          already says so, and the engine above it is still running. */}
      {loaded && loaded.length > 0 && <LoadedModelList models={loaded} />}
    </div>
  )
}

/**
 * The models an engine that loads them on demand holds right now, one row each,
 * with what the engine says about each: its size in parameters, its
 * quantization, its context window and the memory it occupies; hovering a row
 * says when the engine will unload it. Drawn from the snapshot alone, so a
 * model loaded or unloaded shows on the next tick.
 *
 * Each row carries its own provider mark where the model's name spells one out
 * — the engine as a whole can hold several providers' models, which is why the
 * headline above wears a mark only for exactly one.
 */
function LoadedModelList({ models }: { models: readonly LoadedModel[] }) {
  return (
    <ul aria-label="Loaded models" className="basis-full min-w-0 flex flex-col gap-1">
      {models.map((model) => {
        const logo = getNamespacedProviderLogo(model.name)
        const contextLength = formatContextLength(model.context_length)
        return (
          <li
            key={model.name}
            title={formatUnloadTime(model.expires_at) ?? undefined}
            className="min-w-0 flex items-center gap-1.5 flex-wrap"
          >
            {logo && <ProviderMark logo={logo} />}
            <span className="min-w-0 truncate text-xs font-medium text-zinc-200" title={model.name}>
              {shortModelName(model.name)}
            </span>
            {model.parameter_size && <EngineChip label={model.parameter_size} />}
            {model.quantization && <EngineChip label={model.quantization} />}
            {contextLength && <EngineChip label={contextLength} />}
            <EngineChip label={formatLoadedModelSize(model)} />
          </li>
        )
      })}
    </ul>
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
