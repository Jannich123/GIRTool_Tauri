// Shared helpers for group systems.
//
// "Unknown" is a reserved group: every group system always has one. It is the
// implicit assignment for any point not explicitly placed in another group, so
// charts/map can colour and symbolise it like a normal group. The user may
// drag points into it manually, edit its colour/symbol, etc., but cannot
// rename or delete it.

export const UNKNOWN_GROUP_NAME = 'Unknown'

/**
 * Ensure every group system contains an "Unknown" group (last entry, drawn
 * behind everything else). Returns a new array — does not mutate.
 */
export function withUnknownGroup(systems) {
  if (!Array.isArray(systems)) return systems
  return systems.map(gs => {
    if (gs.groups?.some(g => g.name === UNKNOWN_GROUP_NAME)) return gs
    return {
      ...gs,
      groups: [
        ...(gs.groups || []),
        makeUnknownGroup(gs.id),
      ],
    }
  })
}

/**
 * Build a fresh Unknown group definition, anchored to its parent system id.
 */
export function makeUnknownGroup(systemId) {
  return {
    id:            `grp_unknown_${systemId || Date.now()}`,
    name:          UNKNOWN_GROUP_NAME,
    color:         '#9ca3af',    // neutral gray
    symbol:        'circle',
    markerSize:    6,
    lineType:      'solid',
    lineThickness: 1,
    isUnknown:     true,
  }
}

export function isUnknownGroup(g) {
  return !!g && g.name === UNKNOWN_GROUP_NAME
}
