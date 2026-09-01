/**
 * What a panel can be pointed at, as a list an operator picks from.
 *
 * The mirror image of `bindings`: that module reads a binding and resolves it,
 * this one offers the ones a panel could have. Both obey the same prohibition —
 * **no silent substitution**. A panel pinned to a GPU or an engine that is not
 * on this host keeps its own option, marked absent and selected, because a
 * control that quietly showed a different target would repoint the panel the
 * moment anything else about it was edited.
 *
 * Pure, so the awkward cases — a pin to something absent, a binding that could
 * not be read, a binding of the wrong kind for the panel — are covered without
 * rendering anything.
 */

import { engineDescription } from '@/lib/format'
import { findEngineByEndpoint, findGpuByIndex, gpuIndexOf, type EngineIdentity, type GpuIdentity } from '@/lib/identity'
import type { GpuMetrics } from '@/types/metrics'
import { FOLLOW, UNREADABLE, type PanelBinding } from './bindings'
import type { PanelBindingKind } from './panels'

/** The value of the option a panel that follows its page carries. */
const FOLLOW_CHOICE = 'follow'

/**
 * The value shown for a binding that names nothing this panel can use. Offered
 * so the control has something to select — never a target to choose.
 */
const UNREADABLE_CHOICE = 'unreadable'

/** One thing a panel could be pointed at. */
export interface BindingChoice {
  /** Round-trips through `bindingFromChoice`; safe as an option value. */
  value: string
  label: string
  /** The target is not on this host — a pin left dangling, or a broken binding. */
  absent?: boolean
}

/** Everything the control needs: what to offer, and what is selected now. */
export interface BindingControl {
  value: string
  choices: BindingChoice[]
}

/** A GPU as the control names it. */
type GpuChoiceSource = GpuIdentity & Pick<GpuMetrics, 'name'>

/**
 * The targets a panel of this binding kind can be pointed at, with the one it
 * currently holds selected.
 *
 * A panel that binds to nothing gets no choices — there is nothing on a
 * host-wide panel to pin, and offering a control that does nothing is worse
 * than offering none.
 */
export function bindingChoices(
  kind: PanelBindingKind,
  binding: PanelBinding,
  gpus: readonly GpuChoiceSource[],
  engines: readonly EngineIdentity[],
): BindingControl {
  if (kind === 'none') return { value: FOLLOW_CHOICE, choices: [] }

  const pinned = kind === binding.kind ? binding : null
  const readable = pinned !== null || binding.kind === 'follow'

  const choices: BindingChoice[] = [
    // The unreadable option leads, because it is what the panel is right now
    // and the operator's next move is to replace it.
    ...(readable ? [] : [{ value: UNREADABLE_CHOICE, label: 'Not readable — choose a target', absent: true }]),
    { value: FOLLOW_CHOICE, label: kind === 'gpu' ? 'Follow the page’s GPU' : 'Follow the page’s engine' },
    ...(kind === 'gpu' ? gpus.map(gpuChoice) : engines.map(engineChoice)),
  ]

  const value = pinned ? choiceOf(pinned) : readable ? FOLLOW_CHOICE : UNREADABLE_CHOICE
  const missing = pinned && !onThisHost(pinned, gpus, engines) ? absentChoice(pinned) : null

  return { value, choices: missing ? [...choices, missing] : choices }
}

/**
 * The binding a chosen option means.
 *
 * Anything that is not one of the offered targets — the unreadable option
 * included — reads as unreadable rather than as a guess. The values come from
 * this module's own choices, so there is no legitimate third case.
 */
export function bindingFromChoice(value: string): PanelBinding {
  if (value === FOLLOW_CHOICE) return FOLLOW

  const separator = value.indexOf(':')
  const kind = value.slice(0, separator)
  const target = value.slice(separator + 1)
  if (target.length === 0) return UNREADABLE

  if (kind === 'gpu') {
    const index = Number(target)
    return Number.isInteger(index) && index >= 0 ? { kind: 'gpu', index } : UNREADABLE
  }

  return kind === 'engine' ? { kind: 'engine', endpoint: target } : UNREADABLE
}

function gpuChoice(gpu: GpuChoiceSource): BindingChoice {
  const index = gpuIndexOf(gpu)
  return { value: `gpu:${index}`, label: `GPU ${index} — ${gpu.name}` }
}

function engineChoice(engine: EngineIdentity): BindingChoice {
  return { value: `engine:${engine.endpoint}`, label: engineDescription(engine) }
}

/** The option kept for a target the host does not have, so the pin stays visible. */
function absentChoice(binding: PanelBinding): BindingChoice {
  const name = binding.kind === 'gpu' ? `GPU ${binding.index}` : binding.kind === 'engine' ? binding.endpoint : ''
  return { value: choiceOf(binding), label: `${name} (not on this host)`, absent: true }
}

function onThisHost(
  binding: PanelBinding,
  gpus: readonly GpuChoiceSource[],
  engines: readonly EngineIdentity[],
): boolean {
  if (binding.kind === 'gpu') return findGpuByIndex(gpus, binding.index) !== undefined
  if (binding.kind === 'engine') return findEngineByEndpoint(engines, binding.endpoint) !== undefined
  return true
}

function choiceOf(binding: PanelBinding): string {
  if (binding.kind === 'gpu') return `gpu:${binding.index}`
  if (binding.kind === 'engine') return `engine:${binding.endpoint}`
  return binding.kind === 'follow' ? FOLLOW_CHOICE : UNREADABLE_CHOICE
}
