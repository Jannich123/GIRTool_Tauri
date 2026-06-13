import { createContext, useContext, useState } from 'react'

// Shared state for the on-map shape tools (#322): which mode is active and
// which addon shape is selected.  Provided once at the app root so the toolbar
// (ShapeDraw) and the addon layers (AddonLayers) — siblings inside each
// MapContainer — can coordinate without per-page wiring.

const ShapeToolsCtx = createContext(null)

export function ShapeToolsProvider({ children }) {
  const [mode, setMode] = useState(null)         // null | 'select'
  const [selected, setSelected] = useState(null) // { id, name, type, file } | null
  return (
    <ShapeToolsCtx.Provider value={{ mode, setMode, selected, setSelected }}>
      {children}
    </ShapeToolsCtx.Provider>
  )
}

export function useShapeTools() {
  return useContext(ShapeToolsCtx) || { mode: null, setMode: () => {}, selected: null, setSelected: () => {} }
}
