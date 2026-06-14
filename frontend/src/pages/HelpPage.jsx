import { useState } from 'react'

// Help window (issue #314) — opens in its own pop-out (App routes ?page=help
// here, no sidebar). A tab per left-menu page explains, in detail, what the
// user can do there. Content is plain data so it's easy to keep current.

// An item is a string, or { b, t } rendered as "**b** — t".
const HELP = [
  {
    key: 'start', icon: '🚀', label: 'Getting started',
    intro: 'GIRTool pulls borehole and CPT data from your GeoGIS / Jupiter databases and turns it into Excel datasheets, charts and maps. Here is the usual order of work.',
    sections: [
      {
        h: 'Typical workflow', ordered: true, items: [
          { b: 'Settings', t: 'connect a database and choose an output folder (where all the Excel files live).' },
          { b: 'Data Selection', t: 'pick the boreholes / points you want to work with, on the map or in the lists.' },
          { b: 'Strata', t: 'define and correct the soil layering for your points — normally done before downloading, so the layers can tag the downloaded data.' },
          { b: 'Data', t: 'download the selection into datasheets (CPTData, SPTData, …); import external CSV/Excel if needed.' },
          { b: 'CPT – Calculations (optional)', t: 'derive CPT parameters — only if you need them.' },
          { b: 'Grouping / Colors & Symbols', t: 'organise the points into groups and theme how they look.' },
          { b: 'Project map / Charts / Boundaries', t: 'visualise and plot the results.' },
        ],
      },
      {
        h: 'Good to know', items: [
          'Everything is saved as Excel files in your output folder — you can open and edit them in Excel at any time, then reload in the tool.',
          'Open a feature in a second window with the small arrows next to its menu item; all windows share the same live selection and update together.',
          'Every table has Excel-style column filters (the ▾ button in each header) that now narrow each other, plus sorting and search.',
          'The 🤖 AI assistant (above Settings) can answer "how do I…" questions in plain language, including Danish.',
        ],
      },
    ],
  },
  {
    key: 'dataSelection', icon: '🧭', label: 'Data Selection',
    intro: 'The starting point. Here you choose which database points to work with — everything else in the tool uses this selection. It needs a database connection and output folder from Settings first.',
    sections: [
      {
        h: 'The map', items: [
          'Pan and zoom freely; use the 🔍 search box (top-left) to fly to an address or place (Danish addresses + worldwide).',
          { b: 'Jupiter (GEUS) reference boreholes', t: 'toggle Geoteknik / Vand / Miljø in the bottom-left legend; hover one for its DGU number, owner, depth, year and cyklogram (lithology pie); click it to open the GEUS borerapport.' },
          { b: 'Your database points', t: '● = in a selected project, ○ = available (loaded), ⭕ = currently selected.' },
          { b: 'Load available data', t: 'use "Load in view" for the current map area, or draw a polygon and load inside it — this fetches the DB points and Jupiter boreholes for that area.' },
        ],
      },
      {
        h: 'Selecting points (this drives the whole tool)', items: [
          'Click a point to select or deselect it.',
          'Double-click a point to add its whole parent project (all of its points).',
          'Draw a polygon, then "Select inside" to select every visible point in it (or "Remove inside" to drop them).',
          'Click a polygon you imported under Settings → Map addons to use it as the selection boundary.',
        ],
      },
      {
        h: 'Projects & Points tabs', items: [
          'Lists of the selected projects and points; sort by any column and filter each column (▾) Excel-style.',
          'Selecting or removing here stays in sync with the map and with any other open windows.',
        ],
      },
    ],
  },
  {
    key: 'strata', icon: '🪨', label: 'Strata',
    intro: 'Define the soil / rock layering (strata) for your points and fix any gaps or overlaps, so the layers can correctly tag your datasheet rows (Primary / Secondary Layer) and feed the CPT layer calculations. This is normally done BEFORE downloading data, so the layers are applied to it.',
    sections: [
      {
        h: 'Download strata', items: [
          'The table lists the strata interpretations / series available for your selection (Interpretation, Series, Description, Points, Layers). Tick the ones you want — Select all / Clear help.',
          '"Download Strata" appends a sheet per interpretation+series to strata.xlsx in your output folder.',
          '"Copy selected into the Strata master sheet" gathers them into the single Strata sheet (it skips points already there). Open strata.xlsx in Excel to inspect.',
        ],
      },
      {
        h: 'Check & correct', items: [
          '"Load Strata" reads the Strata master sheet and flags issues per point: a gap (a layer starts below where the previous one ended), an overlap (layers overlap), or a negative thickness.',
          'Fix the From/To depths and the Primary / Secondary layer names directly in the table, then "Save Corrections" to write them back to the Strata sheet.',
          'Corrected strata are what stamp the Primary Layer column onto your downloaded datasheets.',
        ],
      },
    ],
  },
  {
    key: 'data', icon: '📊', label: 'Data',
    intro: 'Download your selected points into Excel datasheets, preview them, reduce CPT data, and import external data.',
    sections: [
      {
        h: 'Download menu', items: [
          'Tick the queries / datasheets to fetch (CPTData, SPTData, Classification, GrainSizes, …) and Download — one xlsx per query in the output folder’s Datasheets/ folder.',
          'Append adds newly selected points without refetching everything; Re-add strata re-stamps the Primary Layer column after a strata correction.',
        ],
      },
      {
        h: 'Data preview', items: [
          'One pill per datasheet (with its row count) — click to preview. Filter and search each column; "↻ Reload data" re-reads the files (and refreshes the counts and any open charts); "Open in Excel" opens the file.',
        ],
      },
      {
        h: 'CPT reduction', items: [
          'Average or median the CPT rows of a sheet into fixed depth windows (e.g. every 2 cm) to thin out dense CPT logs. Pick the sheet and window; optionally auto-apply it after each download.',
        ],
      },
      {
        h: 'Import', items: [
          'Bring in a CSV / Excel file or a whole folder of them. Preview the first file, choose the header row and first data row, and map the source columns to datasheet columns.',
          'Set each ID (DB / ProjectId / PointId / PointNo) from a column, the file name, or custom text; convert units per column (e.g. ft → m, psi → MPa).',
          'Points missing from points.xlsx are added; a missing Level is filled as Z1 − Depth.',
        ],
      },
    ],
  },
  {
    key: 'cpt', icon: '🧮', label: 'CPT – Calculations',
    intro: 'Optional — only needed if you want derived CPT parameters. Runs the CPT calculation pipeline on CPTData, with full control over which columns are produced.',
    sections: [
      {
        h: 'CPT calculations', items: [
          'Pick the datasheet (CPTData) and tick which derived columns to compute from the grouped catalogue — each shows a description, its rounding, and the calculation reference.',
          'Set γ_water, then Run to write the ticked, visible columns back into the datasheet. Hidden intermediate columns can be shown if you need them. Your column choice and rounding are remembered per project.',
        ],
      },
      {
        h: 'CPT point data', items: [
          'Per-point inputs the calculation needs, saved to cpt_point_data.xlsx (you can also edit it in Excel and re-read it).',
        ],
      },
      {
        h: 'CPT layer data', items: [
          'Per-strata inputs taken from your strata layers, saved to cpt_layer_data.xlsx, including the Nkt estimation-method selector. Add strata codes and re-read to pull the current layers.',
        ],
      },
    ],
  },
  {
    key: 'grouping', icon: '🏷️', label: 'Grouping',
    intro: 'Organise points into named groups (e.g. design zones or areas) that you can then colour and chart by.',
    sections: [
      {
        h: 'Group systems', items: [
          'Create one or more grouping systems, each holding several groups. Rename or delete systems, and add or remove groups.',
        ],
      },
      {
        h: 'Assign points', items: [
          'Search points by number, type or project, tick the ones you want, choose a group and Apply (Deselect all to start over).',
          'Or assign visually in the Project map’s grouping mode (click points, draw a polygon, or pick an imported polygon) — it writes the same assignments.',
        ],
      },
      {
        h: 'Storage', items: [
          'Assignments live in points.xlsx — open it in Excel; "Reload" re-reads it and fuzzy-matches any group names you renamed there.',
        ],
      },
    ],
  },
  {
    key: 'colors', icon: '🎨', label: 'Colors & Symbols',
    intro: 'Control how points and layers look on the maps and in charts.',
    sections: [
      {
        h: 'What you can theme', items: [
          { b: 'By point type', t: 'set Color, Symbol, Line type and Thickness for each Point Type.' },
          { b: 'By group', t: 'colour and symbolise the groups in your grouping systems; drag to reorder. An "unassigned" catch-all is reserved.' },
          { b: 'Strata layers', t: 'colours for the stratigraphic layers.' },
        ],
      },
      {
        h: 'Storage', items: [
          'Saved to Colors_&_Symbols.xlsx (Open / Reload). Changes apply live on the maps and in charts.',
        ],
      },
    ],
  },
  {
    key: 'map', icon: '🗺️', label: 'Project map',
    intro: 'A map focused on your project’s points — for visual checking, grouping and themed display.',
    sections: [
      {
        h: 'Viewing', items: [
          'Shows your downloaded points, themed by type / group / colour. Hover a point for its details. The layer panel (top-right) toggles base maps and your Map addons; the address search and pop-out windows work here too.',
        ],
      },
      {
        h: 'Grouping mode', items: [
          'When a grouping system is selected, enter grouping mode to assign a group by clicking individual points, drawing a polygon, or picking an imported addon polygon — only visible points are affected.',
          'Colours update live and the Grouping tab reflects the changes immediately.',
        ],
      },
    ],
  },
  {
    key: 'charts', icon: '📈', label: 'Charts',
    intro: 'Plot your data — scatter, line and more — reading directly from the downloaded datasheets (up to ~100,000 rows).',
    sections: [
      {
        h: 'Build a chart', items: [
          'Add a chart, pick the datasheet/query and the X / Y (and optional Z or colour) columns; axis titles auto-fill from the column dictionary, with units.',
          'Options: log or inverted axes, min/max limits, group / colour-by, marker size and line width. Keep several charts as tabs.',
        ],
      },
      {
        h: 'Overlays & statistics', items: [
          'Overlay reference lines, and Boundaries (the classification zones you define on the Boundaries tab).',
          'Each chart has a statistics table (auto-saved) and customisable hover columns. Charts and stats refresh automatically when the underlying datasheets change.',
        ],
      },
    ],
  },
  {
    key: 'boundaries', icon: '〰️', label: 'Boundaries',
    intro: 'Define named polygons from coordinates to overlay on charts — for example soil-classification zones.',
    sections: [
      {
        h: 'Creating boundaries', items: [
          'Create a boundary, give it a name, colour and line style, and enter its X/Y points by typing them or pasting rows from Excel (tab- or comma-separated; a header row is detected and skipped).',
          'Saved with the project (a {project}_boundaries.json plus an editable {project}_Boundaries.xlsx you can round-trip through Excel).',
        ],
      },
      {
        h: 'Using them', items: [
          'On the Charts tab, tick a chart’s Boundaries to draw the outlines over your data.',
          'Note: these are chart overlays — they are not drawn on the map. To put a shape on a map, import it under Settings → Map addons.',
        ],
      },
    ],
  },
  {
    key: 'settings', icon: '⚙️', label: 'Settings',
    intro: 'Connect to your data and configure the tool. Start here on a new machine or project.',
    sections: [
      {
        h: 'What you configure', items: [
          { b: 'Project selection', t: 'pick (or create / copy) the output folder where all the Excel files live; recent folders let you switch quickly.' },
          { b: 'Databases', t: 'add one or more GeoGIS / SQL Server connections (editable IDs, named defaults, copy a connection); tap a row to expand its details, then Save & connect all.' },
          { b: 'Query config', t: 'view or override the SQL behind each query type and datasheet.' },
          { b: 'Coordinate system', t: 'choose the target CRS; all maps and exports follow it.' },
          { b: 'Map addons', t: 'import shapefile / GeoJSON / CSV / Excel as styleable map layers (colour, opacity, draw order, which maps), and add WMS / WMTS / XYZ base layers.' },
        ],
      },
    ],
  },
  {
    key: 'ai', icon: '🤖', label: 'AI assistant',
    intro: 'A built-in chat helper that explains how to use GIRTool and can search reference documents bundled with the tool.',
    sections: [
      {
        h: 'Using it', items: [
          'Opens in its own window. Ask questions in plain language (Danish or English) — it knows the datasheet columns and their units, and the tool’s features.',
          'Start a New chat or pick a previous chat from the left; attach a text file to ask about it.',
          'The button is greyed out when no working AI key is configured (that is set up by whoever installed the tool).',
        ],
      },
    ],
  },
]

function Item({ it }) {
  if (it && typeof it === 'object') {
    return <li><strong>{it.b}</strong> — {it.t}</li>
  }
  return <li>{it}</li>
}

export default function HelpPage() {
  const [activeKey, setActiveKey] = useState('start')
  const active = HELP.find(t => t.key === activeKey) || HELP[0]

  return (
    <div style={{ display: 'flex', height: '100vh', maxHeight: '100vh', background: 'var(--light)' }}>
      {/* Left: tab per menu page */}
      <aside style={{ width: 230, flex: '0 0 230px', borderRight: '1px solid var(--border)', background: 'var(--light)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '.7rem .8rem .4rem', fontWeight: 700, fontSize: '1rem' }}>❓ Help</div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 .4rem .6rem' }}>
          {HELP.map(t => (
            <button
              key={t.key}
              onClick={() => setActiveKey(t.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: '.5rem', width: '100%', textAlign: 'left',
                padding: '.45rem .55rem', marginBottom: '.15rem', borderRadius: 6, cursor: 'pointer',
                border: 'none', font: 'inherit',
                background: t.key === activeKey ? 'rgba(37, 99, 235, 0.12)' : 'transparent',
                fontWeight: t.key === activeKey ? 600 : 400,
                color: t.key === activeKey ? 'var(--navy)' : 'var(--text)',
              }}
            >
              <span style={{ width: '1.3em', textAlign: 'center' }}>{t.icon}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.label}</span>
            </button>
          ))}
        </div>
      </aside>

      {/* Right: detailed content */}
      <div style={{ flex: 1, overflowY: 'auto', minWidth: 0 }}>
        <div style={{ maxWidth: 760, padding: '1.4rem 1.6rem' }}>
          <h2 className="page-title" style={{ margin: '0 0 .4rem' }}>{active.icon} {active.label}</h2>
          {active.intro && <p style={{ margin: '0 0 1.1rem', color: 'var(--muted)', lineHeight: 1.55 }}>{active.intro}</p>}
          {active.sections.map((s, i) => (
            <section key={i} style={{ marginBottom: '1.1rem' }}>
              <h4 className="section-title" style={{ margin: '0 0 .35rem' }}>{s.h}</h4>
              {s.ordered
                ? <ol style={{ margin: 0, paddingLeft: '1.3rem', lineHeight: 1.6, color: 'var(--text)' }}>{s.items.map((it, j) => <Item key={j} it={it} />)}</ol>
                : <ul style={{ margin: 0, paddingLeft: '1.3rem', lineHeight: 1.6, color: 'var(--text)' }}>{s.items.map((it, j) => <Item key={j} it={it} />)}</ul>}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
