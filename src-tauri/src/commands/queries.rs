// Saved queries CRUD — mirrors backend/routers/queries.py.
//
// Queries are stored as a single JSON file in the output folder:
//   <output_folder>/queries.json
//
// Each entry is a JSON object with:
//   fname        — display name / identifier
//   SQLScript    — the raw SQL with #projectid# / #pointid# placeholders
//   pointfilter  — the point-level WHERE fragment
//   apply_strata — "Yes" | "No"
//
// When the file is absent, list_queries returns the built-in DEFAULT_QUERIES
// (same query set the Python build ships with).
//
// As of issue #62 each builtin SQL is stored as a multi-line raw string
// (one `pub(crate) const ...` per query) instead of being squashed into a
// single line inside one JSON blob.  The Query Config UI shows these
// formatted strings directly, so the textarea reads like any SQL viewer.
//
// API surface:
//   list_queries(project_id)            → Vec<Query>
//   save_query(project_id, query)       → ()   (full replace of all queries)
//   delete_query(project_id, fname)     → ()   (remove one query by fname)

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::AppState;

// ── Query type ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Query {
    pub fname:        String,
    #[serde(rename = "SQLScript")]
    pub sql_script:   String,
    #[serde(default)]
    pub pointfilter:  String,
    #[serde(default = "default_no")]
    pub apply_strata: String,
}

fn default_no() -> String {
    "No".to_string()
}

// ── Default query set (matches backend/routers/queries.py DEFAULT_QUERIES) ───
//
// Each query lives in its own `pub(crate) const NAME_SQL: &str = r#"..."#;`
// block.  Format conventions:
//   * SQL keywords UPPERCASE
//   * One column per line under SELECT, two-space indent
//   * Each JOIN on its own line, alias-aligned
//   * WHERE clause and ORDER BY each on their own line
//   * `#DB#`, `#projectid#`, `#pointfilter#`, `#pointid#` are runtime
//     placeholders the download pipeline replaces just before execution.

pub(crate) const POINTS_SQL: &str = r#"
SELECT
  A.[ProjectId],
  A.[PointId],
  CAST(A.[PointNo] AS VARCHAR(MAX)) AS [PointNo],
  B.[ProjectNo],
  A.PointType,
  round(A.[X1], 2)     AS [X1],
  round(A.[Y1], 2)     AS [Y1],
  round(A.[Z1], 2)     AS [Z1],
  round(A.[Top], 2)    AS [Top],
  round(A.[Bottom], 2) AS [Bottom],
  A.[Projection1],
  A.[VerticalRefId1] AS [Level Reference],
  C.[Projection]    AS [Coordinate System]
FROM (
  #DB#[Points] A
  INNER JOIN #DB#[Projects] B ON A.ProjectId = B.ProjectId
)
INNER JOIN #DB#[Projections] C ON A.Projection1 = C.Epsg
WHERE A.ProjectID IN (#projectid#)
  #pointfilter#
ORDER BY A.PointNo ASC
"#;

pub(crate) const WATER_LEVELS_SQL: &str = r#"
SELECT
  B.[PointId],
  A.[IntakeId],
  A.[ValueId],
  CAST(B.[PointNo] AS VARCHAR(MAX)) AS [PointNo],
  A.[Time],
  round(A.[Depth], 3)             AS [Depth],
  round(B.[Z1] - A.[Depth], 3)    AS [Level]
FROM (
  #DB#[WaterLevels] A
  INNER JOIN #DB#[Intakes] C ON A.IntakeId = C.IntakeId
)
INNER JOIN #DB#[Points] B ON C.PointId = B.PointId
WHERE B.ProjectID IN (#projectid#)
  #pointfilter#
ORDER BY B.PointId ASC, Depth ASC
"#;

pub(crate) const SPT_DATA_SQL: &str = r#"
SELECT
  A.[PointId],
  A.[TestId],
  A.[SampleId],
  A.[DataSourceId],
  CAST(B.[PointNo] AS VARCHAR(MAX)) AS [PointNo],
  round(B.[Z1] - A.[Depth], 3)    AS [Level],
  round(A.[Depth], 3)             AS [Depth],
  A.[TestType],
  round(A.[TestLength], 2)        AS [TestLength],
  round(A.[TotalLength], 2)       AS [TotalLength],
  A.[N],
  A.[NReport],
  A.[HammerNo]
FROM #DB#[SPTData] A
INNER JOIN #DB#[Points] B ON A.PointId = B.PointId
WHERE B.ProjectID IN (#projectid#)
  #pointfilter#
ORDER BY A.PointId ASC, Depth ASC
"#;

pub(crate) const SAMPLES_SQL: &str = r#"
SELECT
  A.[PointId],
  A.[SampleId],
  A.[LayerId],
  CAST(B.[PointNo] AS VARCHAR(MAX)) AS [PointNo],
  A.[SampleNo],
  round(A.[Depth1], 2)            AS [Depth],
  round(B.[Z1] - A.[Depth1], 3)   AS [Level],
  round(A.[Depth1], 3)            AS [Depth1],
  round(A.[Depth2], 2)            AS [Depth2],
  A.[Recovery],
  A.[RQD],
  A.[Description],
  A.[Description2],
  round(A.[EDepth1], 2)           AS [EDepth1],
  round(A.[EDepth2], 2)           AS [EDepth2],
  A.[SampleType]
FROM #DB#[Samples] A
INNER JOIN #DB#[Points] B ON A.PointId = B.PointId
WHERE B.ProjectID IN (#projectid#)
  #pointfilter#
ORDER BY A.PointId ASC, Depth1 ASC
"#;

pub(crate) const GRAIN_SIZE_VALUES_SQL: &str = r#"
SELECT
  D.[PointId],
  C.[SampleId],
  A.[TestId],
  A.[ValueId],
  CAST(E.[PointNo] AS VARCHAR(MAX)) AS [PointNo],
  D.[SampleNo],
  round(D.[Depth1], 3)            AS [Depth],
  round(E.[Z1] - D.[Depth1], 3)   AS [Level],
  round(A.[Diameter], 4)          AS [Diameter],
  round(A.[WPercent], 2)          AS [WPercent],
  round(A.[Fpercent], 2)          AS [Fpercent],
  round(C.[Distance], 2)          AS [Distance]
FROM (((
  #DB#[GrainSizeValues] A
  INNER JOIN #DB#[GrainSizeTests] B ON A.TestId      = B.TestId
) INNER JOIN #DB#[GrainSizes]      C ON B.GrainSizeId = C.GrainSizeId
)   INNER JOIN #DB#[Samples]       D ON C.SampleId    = D.SampleId
)
INNER JOIN #DB#[Points] E ON D.PointId = E.PointId
WHERE E.ProjectID IN (#projectid#)
  #pointfilter#
ORDER BY PointNo ASC, SampleNo ASC, Depth1 ASC, Distance ASC, A.Diameter ASC
"#;

pub(crate) const CPT_DATA_SQL: &str = r#"
SELECT
  B.[PointId],
  A.[TestId],
  CAST(C.[PointNo] AS VARCHAR(MAX)) AS [PointNo],
  round(A.[Depth], 3)             AS [Depth],
  round(A.[DepthC], 3)            AS [DepthC],
  round(C.[Z1] - A.[Depth], 3)    AS [Level],
  round(A.[qc], 4)                AS [qc],
  round(D.[ConeAreaRatio], 2)     AS [ConeAreaRatio],
  round(A.[fs] * 1000, 2)         AS [fs],
  round(A.[u1] * 1000, 2)         AS [u1],
  round(A.[u2] * 1000, 2)         AS [u2],
  round(A.[u3] * 1000, 2)         AS [u3],
  round(A.[Slope1], 2)            AS [Slope1],
  round(A.[Slope2], 2)            AS [Slope2],
  round(A.[QNET], 4)              AS [QNET],
  round(A.[HPT], 2)               AS [HPT],
  round(A.[UndrainedShearStrengthBE], 2) AS [Su]
FROM ((
  #DB#[CPTData] A
  INNER JOIN #DB#[CPTPush] B ON A.TestId = B.TestId
) INNER JOIN #DB#[Points] C ON B.PointId = C.PointId)
INNER JOIN #DB#[CPTPush] D ON A.TestId = D.TestId
WHERE C.ProjectID IN (#projectid#)
  #pointfilter#
ORDER BY A.TestId ASC, Depth ASC
"#;

pub(crate) const CLASSIFICATION_SQL: &str = r#"
SELECT
  B.[PointID]   AS [PointId],
  A.[SampleId],
  A.[TestId],
  A.[DataSourceId],
  CAST(C.[PointNo] AS VARCHAR(MAX)) AS [PointNo],
  round(B.[Depth1], 3)            AS [Depth],
  round(C.[Z1] - B.[Depth1], 3)   AS [Level],
  round(A.[Distance], 3)          AS [Distance],
  round(A.[MC], 2)                AS [MC],
  round(A.[UW], 2)                AS [UW],
  round(A.[UWD], 2)               AS [UWD],
  round(A.[BDen], 2)              AS [BDen],
  round(A.[BDenD], 2)             AS [BDenD],
  round(A.[E], 2)                 AS [E],
  round(A.[ECalc], 2)             AS [ECalc],
  round(A.[CA], 2)                AS [CA],
  round(A.[N], 2)                 AS [N],
  round(A.[WL], 2)                AS [WL],
  round(A.[WP], 2)                AS [WP],
  round(A.[IP], 2)                AS [IP],
  round(A.[IL], 2)                AS [IL],
  round(A.[CR], 2)                AS [CR],
  round(A.[DS], 2)                AS [DS],
  round(A.[DSEstim], 2)           AS [DSEstim],
  A.[Pycnometer],
  round(A.[ORGC], 2)              AS [ORGC],
  round(A.[ORGCR], 2)             AS [ORGCR],
  round(A.[EMin], 2)              AS [EMin],
  round(A.[EMax], 2)              AS [EMax],
  round(A.[NMin], 2)              AS [NMin],
  round(A.[NMax], 2)              AS [NMax],
  B.[Description]
FROM (
  #DB#[ClassificationTests] A
  INNER JOIN #DB#[Samples] B ON A.SampleId = B.SampleId
)
INNER JOIN #DB#[Points] C ON B.PointId = C.PointId
WHERE C.ProjectID IN (#projectid#)
  #pointfilter#
ORDER BY B.PointId ASC, Depth1 ASC
"#;

pub(crate) const INSITU_VANE_TESTS_SQL: &str = r#"
SELECT
  A.[PointId],
  A.[TestId],
  CAST(B.[PointNo] AS VARCHAR(MAX)) AS [PointNo],
  round(B.[Z1] - A.[Depth], 3)    AS [Level],
  round(A.[Depth], 3)             AS [Depth],
  A.[Vane],
  A.[CFVCode],
  round(A.[CFV], 3)               AS [CFV],
  A.[CRVCode],
  round(A.[CRV], 2)               AS [CRV],
  A.[Description]
FROM #DB#[InsituVaneTests] A
INNER JOIN #DB#[Points] B ON A.PointId = B.PointId
WHERE B.ProjectID IN (#projectid#)
  #pointfilter#
ORDER BY A.PointId ASC, Depth ASC
"#;

pub(crate) const UCT_DATA_SQL: &str = r#"
SELECT
  B.[PointID]   AS [PointId],
  A.[SampleId],
  A.[TestId],
  CAST(C.[PointNo] AS VARCHAR(MAX)) AS [PointNo],
  round(B.[Depth1], 3)            AS [Depth],
  round(C.[Z1] - B.[Depth1], 3)   AS [Level],
  round(A.[Distance], 2)          AS [Distance],
  round(B.[RQD], 2)               AS [RQD],
  round(A.[MC], 2)                AS [MC],
  A.[Condition],
  A.[Duration],
  round(A.[CU], 2)                AS [CU],
  round(A.[QU], 2)                AS [QU],
  round(A.[ES], 2)                AS [ES],
  round(A.[MU], 2)                AS [MU],
  round(A.[EpsFail], 2)           AS [EpsFail],
  A.[Failure],
  A.[Description]
FROM (
  #DB#[UCTData] A
  INNER JOIN #DB#[Samples] B ON A.SampleId = B.SampleId
)
INNER JOIN #DB#[Points] C ON B.PointId = C.PointId
WHERE C.ProjectID IN (#projectid#)
  #pointfilter#
ORDER BY B.PointId ASC, Depth1 ASC
"#;

pub(crate) const INDURATIONS_SQL: &str = r#"
SELECT
  A.[PointId],
  A.[SampleId],
  A.[LayerId],
  C.[ValueId],
  CAST(B.[PointNo] AS VARCHAR(MAX)) AS [PointNo],
  A.[SampleNo],
  A.[SampleType],
  round(A.[Depth1], 3)            AS [Depth],
  round(B.[Z1] - A.[Depth1], 3)   AS [Level],
  round(A.[Depth1], 3)            AS [Depth1],
  round(A.[Depth2], 3)            AS [Depth2],
  round(C.[Distance], 2)          AS [Distance],
  round(C.[Length], 2)            AS [Length],
  round(C.[V1], 2)                AS [V1],
  round(C.[V2], 2)                AS [V2],
  A.[Description],
  A.[Description2],
  round(A.[EDepth1], 2)           AS [EDepth1],
  round(A.[EDepth2], 2)           AS [EDepth2]
FROM (
  #DB#[Samples] A
  INNER JOIN #DB#[Points] B ON A.PointId = B.PointId
)
INNER JOIN #DB#[Indurations] C ON A.SampleId = C.SampleId
WHERE B.ProjectID IN (#projectid#)
  #pointfilter#
ORDER BY A.PointId ASC, Depth1 ASC
"#;

pub(crate) const BRAZILIAN_TESTS_SQL: &str = r#"
SELECT
  A.[PointId],
  A.[SampleId],
  A.[LayerId],
  CAST(B.[PointNo] AS VARCHAR(MAX)) AS [PointNo],
  A.[SampleNo],
  round(A.[Depth1], 3)            AS [Depth],
  round(B.[Z1] - A.[Depth1], 3)   AS [Level],
  round(C.[Distance], 2)          AS [Distance],
  round(A.[Depth1], 3)            AS [Depth1],
  round(A.[Depth2], 3)            AS [Depth2],
  C.[Duration],
  round(C.[StressRate], 2)        AS [StressRate],
  round(C.[MC], 2)                AS [MC],
  round(C.[TS], 2)                AS [TS],
  C.[Failure]
FROM (
  #DB#[Samples] A
  INNER JOIN #DB#[Points] B ON A.PointId = B.PointId
)
INNER JOIN #DB#[BrazilianTests] C ON A.SampleId = C.SampleId
WHERE B.ProjectID IN (#projectid#)
  #pointfilter#
ORDER BY A.PointId ASC, Depth1 ASC
"#;

pub(crate) const GRAIN_SIZES_SQL: &str = r#"
SELECT
  B.[PointId],
  A.[SampleId],
  CAST(C.[PointNo] AS VARCHAR(MAX)) AS [PointNo],
  B.[SampleNo],
  round(B.[Depth1], 3)            AS [Depth],
  round(C.[Z1] - B.[Depth1], 3)   AS [Level],
  round(A.[Distance], 2)          AS [Distance],
  A.[D10], A.[D15], A.[D20], A.[D25], A.[D30],
  A.[D50], A.[D60], A.[D75], A.[D90],
  A.[UC],  A.[UCc],
  A.[Clayf], A.[Siltf], A.[Sandf], A.[Gravelf], A.[Cobblesf]
FROM (
  #DB#[GrainSizes] A
  INNER JOIN #DB#[Samples] B ON A.SampleId = B.SampleId
)
INNER JOIN #DB#[Points] C ON B.PointId = C.PointId
WHERE C.ProjectID IN (#projectid#)
  #pointfilter#
ORDER BY PointNo ASC, SampleNo ASC, Depth1 ASC, Distance ASC
"#;

/// Public to `commands/` so `query_configs::get_builtin_datasheet_queries`
/// can surface the names + SQL to the Query Config UI (issue #60).  Same set
/// the legacy Python build ships as `DEFAULT_QUERIES`.
pub(crate) fn default_queries() -> Vec<Query> {
    // Helper closure to keep per-query construction terse.
    let mk = |fname: &str, sql: &str, pointfilter: &str, apply_strata: &str| Query {
        fname:        fname.to_string(),
        // The raw strings above start with a leading `\n` (from the line after
        // `r#"`) — trim it so the SQL begins on its own first line cleanly.
        sql_script:   sql.trim_start_matches('\n').trim_end().to_string(),
        pointfilter:  pointfilter.to_string(),
        apply_strata: apply_strata.to_string(),
    };
    vec![
        mk("Points",          POINTS_SQL,             "A.PointId IN (#pointid#)", "No"),
        mk("WaterLevels",     WATER_LEVELS_SQL,       "B.PointId IN (#pointid#)", "No"),
        mk("SPTData",         SPT_DATA_SQL,           "A.PointId IN (#pointid#)", "Yes"),
        mk("Samples",         SAMPLES_SQL,            "A.PointId IN (#pointid#)", "Yes"),
        mk("GrainSizeValues", GRAIN_SIZE_VALUES_SQL,  "D.PointId IN (#pointid#)", "Yes"),
        mk("CPTData",         CPT_DATA_SQL,           "B.PointId IN (#pointid#)", "Yes"),
        mk("Classification",  CLASSIFICATION_SQL,     "B.PointId IN (#pointid#)", "Yes"),
        mk("InsituVaneTests", INSITU_VANE_TESTS_SQL,  "A.PointId IN (#pointid#)", "Yes"),
        mk("UCTData",         UCT_DATA_SQL,           "B.PointId IN (#pointid#)", "Yes"),
        mk("Indurations",     INDURATIONS_SQL,        "A.PointId IN (#pointid#)", "Yes"),
        mk("BrazilianTests",  BRAZILIAN_TESTS_SQL,    "A.PointId IN (#pointid#)", "Yes"),
        mk("GrainSizes",      GRAIN_SIZES_SQL,        "B.PointId IN (#pointid#)", "Yes"),
    ]
}

/// Public helper: load the query list for use by other command modules.
pub fn load_queries(state: &AppState) -> Vec<Query> {
    match queries_path(state) {
        Ok(p) => read_queries(&p),
        Err(_) => default_queries(),
    }
}

// ── File path ─────────────────────────────────────────────────────────────────

fn queries_path(state: &AppState) -> Result<PathBuf, String> {
    let folder = state
        .output_folder()
        .ok_or_else(|| "Output folder is not configured.".to_string())?;
    Ok(PathBuf::from(folder).join("queries.json"))
}

fn read_queries(path: &PathBuf) -> Vec<Query> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(default_queries)
}

fn write_queries(path: &PathBuf, queries: &[Query]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(queries)
        .map_err(|e| format!("Serialise error: {e}"))?;
    std::fs::write(path, json)
        .map_err(|e| format!("Write error: {e}"))
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Return the full query list.  Falls back to built-in defaults when
/// queries.json is absent (first-run or fresh output folder).
#[tauri::command]
pub async fn list_queries(
    _project_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<Query>, String> {
    let path = queries_path(&state)?;
    Ok(read_queries(&path))
}

/// Replace the entire query list.
/// `query` is the full updated array sent by the frontend after every
/// add / edit / delete / reorder operation.
#[tauri::command]
pub async fn save_query(
    _project_id: String,
    query: Vec<Query>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let path = queries_path(&state)?;
    write_queries(&path, &query)
}

/// Remove a single query by `fname`.  No-op if the name is not found.
#[tauri::command]
pub async fn delete_query(
    _project_id: String,
    fname: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let path = queries_path(&state)?;
    let mut queries = read_queries(&path);
    queries.retain(|q| q.fname != fname);
    write_queries(&path, &queries)
}
