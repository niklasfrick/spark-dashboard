import { describe, expect, it } from 'vitest'
import { implementedPanelTypes, renderPanelContent } from '../components/grid/panelRegistry'
import { PANEL_TYPE_IDS, defaultPanelTitle } from '../lib/dashboard/panels'
import { DEFAULT_TIME_WINDOW } from '../lib/dashboard/schema'

describe('the panel registry against the vocabulary', () => {
  it('renders every type the palette offers', () => {
    // The palette lists the whole vocabulary on purpose, so a type with no
    // component is a box an operator adds and finds empty (#110). This spec is
    // what stops that shipping again: a new type in `panels.ts` fails here
    // until something renders it.
    expect([...implementedPanelTypes()].sort()).toEqual([...PANEL_TYPE_IDS].sort())
  })

  it('has content for a panel of each type, not merely an entry', () => {
    for (const type of PANEL_TYPE_IDS) {
      const content = renderPanelContent({
        id: type,
        type,
        geometry: { x: 0, y: 0, w: 3, h: 3 },
        binding: { kind: 'follow' },
        window: DEFAULT_TIME_WINDOW,
      })
      expect(content, defaultPanelTitle(type)).not.toBeNull()
    }
  })

  it('still declines a type from a newer build', () => {
    // The placeholder is kept for exactly this: a document written by a
    // version that knows a panel this one does not.
    expect(
      renderPanelContent({
        id: 'future',
        type: 'gpu-voltage',
        geometry: { x: 0, y: 0, w: 3, h: 3 },
        binding: { kind: 'follow' },
        window: DEFAULT_TIME_WINDOW,
      }),
    ).toBeNull()
  })
})
