import { useState } from 'react'
import { getProviderLogo } from '@/lib/providerLogo'
import {
  engineDisplayName,
  engineIconSrc,
  formatEndpoint,
  formatGpuIndexes,
  modelMetadataWarning,
  shortModelName,
} from '@/lib/format'
import { useEngineLabel } from '@/lib/engineLabelStore'
import { engineKey } from '@/lib/identity'
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
  // An operator-assigned label (e.g. "conf-qwen") replaces the raw model
  // filename — a llama.cpp model's name is a long .gguf path, so naming the
  // engine is what an operator wants to read. Set per-engine, shared across
  // the page, remembered in localStorage.
  const { label, setLabel } = useEngineLabel(engineKey(engine))
  // The model is the headline; the endpoint is already on the frame's title
  // row, so repeating it here would spend the panel's widest line on it twice.
  // With no model to name, the absence is the headline — it is the thing an
  // operator has to act on, not a footnote under a blank line. When the
  // engine refused to say, the refusal is a better headline than a generic
  // absence: the model may well be loaded, only its name is unreadable. A
  // label, when set, outranks all of that — it is what the operator chose.
  const modelHeadline = model?.name
    ? shortModelName(model.name)
    : warning
      ? 'Model name unavailable'
      : 'No model loaded'
  const headline = label ?? modelHeadline

  return (
    <div className="h-full min-h-0 flex flex-col gap-2 overflow-y-auto">
      <div className="shrink-0 flex items-center gap-2 min-w-0">
        {logo && <ProviderMark logo={logo} size="lg" />}
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <p
              className="text-sm font-semibold text-zinc-100 truncate leading-tight"
              title={model?.name ?? engine.endpoint}
            >
              {headline}
            </p>
            <ModelLabelEditor label={label} modelName={model?.name ?? null} onCommit={setLabel} />
          </div>
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

      {/* The engine is serving but its /metrics endpoint is off (llama.cpp
          started without --metrics). Say so, and how to turn it on, instead of
          leaving the metrics panels silently blank. */}
      {engine.metrics_disabled && (
        <p role="alert" className="shrink-0 text-[11px] leading-snug text-amber-200">
          Metrics are disabled — restart <code className="font-mono">llama-server</code> with{' '}
          <code className="font-mono">--metrics</code> to enable the metrics panels.
        </p>
      )}

      {/* Everything the backend could tell us about the deployment and the
          weights, in the order the fixed dashboard showed it. Each is omitted
          when unknown rather than rendered as a dash — an absent chip reads as
          "not reported", which is what it means. */}
      <div className="flex items-start gap-1.5 flex-wrap content-start">
        <EngineChip label={engineDisplayName(engine.engine_type)} iconSrc={engineIconSrc(engine.engine_type)} />
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
 * Rename an engine so its panels say what an operator thinks it is
 * ("conf-qwen") rather than a raw `.gguf` path. Presentational: the label value
 * and its subscription live in the parent, which passes the current label and
 * a commit callback. Enter or blur saves; Escape cancels.
 */
function ModelLabelEditor({
  label,
  modelName,
  onCommit,
}: {
  label: string | null
  modelName: string | null
  onCommit: (value: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const begin = () => {
    setDraft(label ?? modelName ?? '')
    setEditing(true)
  }
  const commit = () => {
    onCommit(draft)
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setEditing(false)
          }
        }}
        placeholder={modelName ?? 'Label'}
        aria-label="Engine display label"
        className="w-36 shrink-0 rounded border border-zinc-600 bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-100 outline-none focus:border-amber-400"
      />
    )
  }

  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        onClick={begin}
        title={label ? 'Edit display label' : 'Set a display label'}
        aria-label={label ? 'Edit display label' : 'Set a display label'}
        className="rounded px-1 py-0.5 text-[10px] leading-none text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
      >
        ✎
      </button>
      {label && (
        <button
          type="button"
          onClick={() => onCommit('')}
          title="Clear display label"
          aria-label="Clear display label"
          className="rounded px-1 py-0.5 text-[10px] leading-none text-zinc-500 hover:bg-zinc-800 hover:text-amber-300"
        >
          ×
        </button>
      )}
    </span>
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
