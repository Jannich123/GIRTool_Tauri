// Map polygon-load queries (M4.3, plan §B1a).
//
// The selection map loads available points inside a drawn polygon, across every
// configured database, handling the fact that points within one DB can be
// stored in different coordinate systems:
//
//   1. `map_distinct_epsgs` — the distinct Projection1 EPSG codes per DB.
//   2. The frontend reprojects the drawn polygon into each of those EPSGs
//      (proj4) and builds a WKT per (db, epsg).
//   3. `map_polygon_points` — runs the spatial-intersect query for each
//      (db, epsg, wkt), filtering same-SRID points (Projection1 = @EPSG), and
//      concatenates the results (db_id prepended).
//
// Both SQL templates live in Query Config (sections map_distinct_epsg /
// map_polygon_points) so they're editable per query_type; the GeoGIS defaults
// are the constants below.  `#DB#`, `#EPSG#`, `#WKT#` are substituted at runtime.

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::State;

use crate::commands::multi_db::{active_databases, fan_out_query_per_db, find_database_by_id};
use crate::commands::query_configs::{lookup_sql, SECTION_MAP_DISTINCT_EPSG, SECTION_MAP_POLYGON_POINTS};
use crate::state::{AppState, DbConfig};

// ── Default SQL (GeoGIS) ────────────────────────────────────────────────────────

/// Distinct coordinate systems present in a DB's Points (§B1a step 1).
pub(crate) const MAP_DISTINCT_EPSG_SQL: &str = r#"
SELECT DISTINCT [Projection1]
FROM #DB#[Points]
WHERE [Projection1] IS NOT NULL
"#;

/// Spatial-intersect query (§B1a step 3).  `#EPSG#` is the integer SRID and
/// `#WKT#` the polygon (drawn polygon reprojected into that EPSG).  Only
/// same-SRID points are compared (Projection1 = @EPSG) so STIntersects is valid.
pub(crate) const MAP_POLYGON_POINTS_SQL: &str = r#"
DECLARE @EPSG INT = #EPSG#;
DECLARE @WKT  NVARCHAR(MAX) = '#WKT#';
DECLARE @Polygon GEOMETRY = geometry::STGeomFromText(@WKT, @EPSG);

SELECT
    A.[ProjectId],
    A.[PointId],
    CAST(A.[PointNo] AS VARCHAR(MAX)) AS [PointNo],
    A.[PointType],
    ROUND(A.[X1], 2)     AS [X1],
    ROUND(A.[Y1], 2)     AS [Y1],
    ROUND(A.[Z1], 2)     AS [Z1],
    A.[Projection1]
FROM #DB#[Points] A
WHERE A.[X1] IS NOT NULL AND A.[Y1] IS NOT NULL AND A.[Projection1] IS NOT NULL
  AND A.[Projection1] = @EPSG
  AND geometry::Point(A.[X1], A.[Y1], A.[Projection1]).STIntersects(@Polygon) = 1
"#;

// ── map_distinct_epsgs ──────────────────────────────────────────────────────────

/// Return the distinct Projection1 EPSG codes per active database, grouped:
///   [ { "db_id": "DB1", "epsgs": [25832, 23032] }, … ]
#[tauri::command]
pub async fn map_distinct_epsgs(state: State<'_, AppState>) -> Result<Value, String> {
    let databases = active_databases(&state);
    if databases.is_empty() {
        return Err("No database connection configured.".into());
    }

    let folder = state.output_folder().unwrap_or_default();
    let pairs: Vec<(DbConfig, String)> = databases
        .into_iter()
        .map(|d| {
            let sql = lookup_sql(&folder, SECTION_MAP_DISTINCT_EPSG, &d.query_type)
                .unwrap_or_else(|| MAP_DISTINCT_EPSG_SQL.to_string())
                .replace("#DB#", "");
            (d, sql)
        })
        .collect();

    let mut errors = Vec::new();
    let rows = fan_out_query_per_db(pairs, &mut errors).await;
    if rows.is_empty() && !errors.is_empty() {
        let first = errors
            .first()
            .and_then(|e| e.get("error"))
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| "All databases failed.".into());
        return Err(first);
    }

    // Group { db_id → distinct integer EPSGs }.  Projection1 may arrive as a
    // number or a numeric string; non-integer values are skipped.
    let mut grouped: BTreeMap<String, BTreeSet<i64>> = BTreeMap::new();
    for row in &rows {
        let db = row.get("db_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let epsg = row.get("Projection1").and_then(|p| {
            p.as_i64()
                .or_else(|| p.as_f64().map(|f| f as i64))
                .or_else(|| p.as_str().and_then(|s| s.trim().parse::<i64>().ok()))
        });
        if let Some(e) = epsg {
            grouped.entry(db).or_default().insert(e);
        }
    }

    let out: Vec<Value> = grouped
        .into_iter()
        .map(|(db, set)| json!({ "db_id": db, "epsgs": set.into_iter().collect::<Vec<_>>() }))
        .collect();
    Ok(json!(out))
}

// ── map_polygon_points ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct PolygonRequest {
    pub db_id: String,
    pub epsg: i64,
    /// Polygon WKT already reprojected into `epsg` (built on the frontend).
    pub wkt: String,
}

/// Run the spatial-intersect query for each (db, epsg, wkt) request and return
/// the matching points (db_id prepended).  One request per (DB, EPSG); the same
/// DB may appear multiple times (one per coordinate system it stores).
#[tauri::command]
pub async fn map_polygon_points(
    requests: Vec<PolygonRequest>,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    if requests.is_empty() {
        return Ok(Vec::new());
    }

    let folder = state.output_folder().unwrap_or_default();
    let mut pairs: Vec<(DbConfig, String)> = Vec::new();
    for req in &requests {
        let Some(db) = find_database_by_id(&state, &req.db_id) else { continue };
        let template = lookup_sql(&folder, SECTION_MAP_POLYGON_POINTS, &db.query_type)
            .unwrap_or_else(|| MAP_POLYGON_POINTS_SQL.to_string())
            .replace("#DB#", "");
        // WKT contains only numbers/commas/parens, but escape quotes defensively.
        let wkt_safe = req.wkt.replace('\'', "''");
        let sql = template
            .replace("#EPSG#", &req.epsg.to_string())
            .replace("#WKT#", &wkt_safe);
        pairs.push((db, sql));
    }
    if pairs.is_empty() {
        return Ok(Vec::new());
    }

    let mut errors = Vec::new();
    let rows = fan_out_query_per_db(pairs, &mut errors).await;

    // Surface failures: error only when nothing came back, else log + return
    // whatever succeeded (a broken DB/EPSG shouldn't hide working ones).
    if rows.is_empty() && !errors.is_empty() {
        let first = errors
            .first()
            .and_then(|e| e.get("error"))
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| "All databases failed.".into());
        return Err(first);
    }
    for e in &errors {
        tracing::warn!("map_polygon_points: a query failed: {e}");
    }
    Ok(rows)
}
