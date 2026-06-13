import { createContext, useContext, useRef, useState } from 'react'

// Shared state for the on-map shape tools (#322, #328): the active mode, the
// selected addon shape, and the in-progress edit.  Provided once at the app
// root so the toolbar (ShapeDraw) and the addon layers (AddonLayers) — siblings
// inside each MapContainer — can coordinate without per-page wiring.

const ShapeToolsCtx = createContext(null)

export function ShapeToolsProvider({ children }) {
  // #330: selection is direct — clicking a shape selects it (no select mode).
  const [selected, setSelected] = useState(null) // { id, name, type, file, epsg } | null
  const [editing, setEditing] = useState(null)   // addon id currently being edited | null
  // Set by the GeoFileLayer being edited → the toolbar reads its edited GeoJSON.
  const editLayerRef = useRef(null)
  // Set by AddonLayers: reload(id, fromFile) — fromFile clears the cache + re-reads
  // the file (after Save); otherwise just remounts from cache (Cancel = discard).
  const reloadRef = useRef(null)
  // #332: a shape click sets this so the map-click that fires in the same event
  // doesn't immediately deselect the shape we just selected.
  const suppressDeselectRef = useRef(false)
  return (
    <ShapeToolsCtx.Provider value={{ selected, setSelected, editing, setEditing, editLayerRef, reloadRef, suppressDeselectRef }}>
      {children}
    </ShapeToolsCtx.Provider>
  )
}

export function useShapeTools() {
  return useContext(ShapeToolsCtx) || {
    selected: null, setSelected: () => {},
    editing: null, setEditing: () => {}, editLayerRef: { current: null }, reloadRef: { current: null },
    suppressDeselectRef: { current: false },
  }
}
