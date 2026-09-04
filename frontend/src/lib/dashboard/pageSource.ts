/**
 * What a page's following panels show by default: one model, every model
 * combined, or whatever the host happens to be serving.
 *
 * This is the page-level half of the binding model in `bindings.ts`, made
 * persistent. A panel bound `follow` defers to the page, and until now the page
 * could only answer with the host's default — the first running engine. The
 * source lets the operator author the answer into the document itself: a
 * "Qwen page" that opens on Qwen for every colleague and kiosk, or an overview
 * page whose engine panels show the combined figures across every engine.
 *
 * **Absent means automatic.** A page with no source follows the host's default
 * exactly as every page did before the field existed, which is what lets the
 * schema migration be a no-op and the shipped preset stay a single static
 * document.
 */

import { engineDescription, shortModelName } from '@/lib/format'
import type { EngineSnapshot } from '@/types/metrics'
import { isRecord } from './json'

/**
 * The operator's choice, as stored on the page. Absent (`undefined`) is the
 * third state — automatic — and is deliberately not a kind of its own: absent
 * is what "never configured" looks like everywhere else in the document, and a
 * stored `auto` would freeze the distinction between the two.
 *
 * Deeply readonly for the same reason a binding is: sources are values,
 * replaced rather than edited.
 */
export type PageSource =
  /** Every engine at once — following engine panels show the combined figures. */
  | { readonly kind: 'all' }
  /** One engine, named by its endpoint — the same identity a pinned panel uses. */
  | { readonly kind: 'engine'; readonly endpoint: string }

/** The all-models source. One value, so reads share it like `FOLLOW`. */
export const ALL_MODELS: PageSource = { kind: 'all' }

/**
 * Reads a persisted source. Absent or malformed becomes `undefined` —
 * automatic. Unlike a panel binding, a source that cannot be read is not kept
 * as a state of its own: no panel label promises the lost target (a following
 * panel's label is whatever the page resolves to, and says so), and automatic
 * is the state every page began in.
 */
export function readPageSource(raw: unknown): PageSource | undefined {
  if (!isRecord(raw)) return undefined
  if (raw.kind === 'all') return ALL_MODELS
  if (raw.kind === 'engine' && typeof raw.endpoint === 'string' && raw.endpoint.length > 0) {
    return { kind: 'engine', endpoint: raw.endpoint }
  }
  return undefined
}

/** The option value of the automatic source, which is not stored. */
const AUTO_CHOICE = 'auto'

/** The option value of the all-models source. */
const ALL_CHOICE = 'all'

/** One thing the page could show, as the config control offers it. */
export interface PageSourceChoice {
  /** Round-trips through `pageSourceFromChoice`; safe as an option value. */
  value: string
  label: string
  /** The engine is not on this host — a source left dangling. */
  absent?: boolean
}

/** Everything the control needs: what to offer, and what is chosen now. */
export interface PageSourceControlModel {
  value: string
  choices: PageSourceChoice[]
}

/**
 * The sources a page can be pointed at, with the one it holds selected.
 *
 * Same prohibition as `bindingChoices`: a source naming an engine that is not
 * on this host keeps its own option, marked absent and selected, rather than
 * being quietly shown as something else.
 */
export function pageSourceChoices(
  source: PageSource | undefined,
  engines: readonly EngineSnapshot[],
): PageSourceControlModel {
  const choices: PageSourceChoice[] = [
    { value: AUTO_CHOICE, label: 'Automatic — first serving model' },
    { value: ALL_CHOICE, label: 'All models — combined' },
    ...engines.map(engineChoice),
  ]

  const value =
    source === undefined ? AUTO_CHOICE : source.kind === 'all' ? ALL_CHOICE : choiceOf(source.endpoint)

  const missing =
    source?.kind === 'engine' && !engines.some((engine) => engine.endpoint === source.endpoint)
      ? { value, label: `${source.endpoint} (not on this host)`, absent: true }
      : null

  return { value, choices: missing ? [...choices, missing] : choices }
}

/**
 * The source a chosen option means. Null is automatic — the caller removes the
 * field rather than storing a sentinel. Anything not in this module's own
 * grammar reads as automatic too; the values come from `pageSourceChoices`, so
 * there is no legitimate third case.
 */
export function pageSourceFromChoice(value: string): PageSource | null {
  if (value === ALL_CHOICE) return ALL_MODELS

  const separator = value.indexOf(':')
  if (value.slice(0, separator) === 'engine') {
    const endpoint = value.slice(separator + 1)
    if (endpoint.length > 0) return { kind: 'engine', endpoint }
  }

  return null
}

/**
 * An engine as the control names it: the model first, because choosing a model
 * is what an operator opens this control to do; the engine after it, because
 * two engines can serve the same model.
 */
function engineChoice(engine: EngineSnapshot): PageSourceChoice {
  const model = engine.model?.name ? shortModelName(engine.model.name) : 'No model loaded'
  return { value: choiceOf(engine.endpoint), label: `${model} — ${engineDescription(engine)}` }
}

/** The one place an endpoint becomes an option value, mirroring `bindingChoices`. */
function choiceOf(endpoint: string): string {
  return `engine:${endpoint}`
}
