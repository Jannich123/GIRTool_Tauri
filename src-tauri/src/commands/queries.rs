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

fn default_queries() -> Vec<Query> {
    serde_json::from_str(DEFAULT_QUERIES_JSON).unwrap_or_default()
}

const DEFAULT_QUERIES_JSON: &str = r#"[
  {"fname":"Points","SQLScript":"SELECT A.[ProjectId], A.[PointId], CAST(A.[PointNo] AS VARCHAR(MAX)) AS [PointNo], B.[ProjectNo], A.PointType, round(A.[X1],2) as [X1], round(A.[Y1],2) as [Y1], round(A.[Z1],2) as [Z1], round(A.[Top],2) as [Top], round(A.[Bottom],2) as [Bottom], A.[Projection1], A.[VerticalRefId1] as [Level Reference], C.[Projection] as [Coordinate System] FROM (#DB#[Points] A inner join #DB#[Projects] B on A.ProjectId = B.ProjectId) inner join #DB#[Projections] C on A.Projection1 = C.Epsg where A.ProjectID IN (#projectid#) #pointfilter# ORDER BY A.PointNo ASC","pointfilter":"A.PointId IN (#pointid#)","apply_strata":"No"},
  {"fname":"WaterLevels","SQLScript":"SELECT B.[PointId], A.[IntakeId], A.[ValueId], CAST(B.[PointNo] AS VARCHAR(MAX)) AS [PointNo], A.[Time], round(A.[Depth],3) as [Depth], round(B.[Z1] - A.[Depth],3) as [Level] FROM (#DB#[WaterLevels] A inner join #DB#[Intakes] C on A.IntakeId = C.IntakeId) inner join #DB#[Points] B on C.PointId = B.PointId where B.ProjectID IN (#projectid#) #pointfilter# ORDER BY B.PointId ASC, Depth ASC","pointfilter":"B.PointId IN (#pointid#)","apply_strata":"No"},
  {"fname":"SPTData","SQLScript":"SELECT A.[PointId], A.[TestId], A.[SampleId], A.[DataSourceId], CAST(B.[PointNo] AS VARCHAR(MAX)) AS [PointNo], round(B.[Z1] - A.[Depth],3) as [Level], round(A.[Depth],3) as [Depth], A.[TestType], round(A.[TestLength],2) as [TestLength], round(A.[TotalLength],2) as [TotalLength], A.[N], A.[NReport], A.[HammerNo] FROM #DB#[SPTData] A inner join #DB#[Points] B on A.PointId = B.PointId where B.ProjectID IN (#projectid#) #pointfilter# ORDER BY A.PointId ASC, Depth ASC","pointfilter":"A.PointId IN (#pointid#)","apply_strata":"Yes"},
  {"fname":"Samples","SQLScript":"SELECT A.[PointId], A.[SampleId], A.[LayerId], CAST(B.[PointNo] AS VARCHAR(MAX)) AS [PointNo], A.[SampleNo], round(A.[Depth1],2) as [Depth], round(B.[Z1] - A.[Depth1],3) as [Level], round(A.[Depth1],3) as [Depth1], round(A.[Depth2],2) as [Depth2], A.[Recovery], A.[RQD], A.[Description], A.[Description2], round(A.[EDepth1],2) as [EDepth1], round(A.[EDepth2],2) as [EDepth2], A.[SampleType] FROM #DB#[Samples] A inner join #DB#[Points] B on A.PointId = B.PointId where B.ProjectID IN (#projectid#) #pointfilter# ORDER BY A.PointId ASC, Depth1 ASC","pointfilter":"A.PointId IN (#pointid#)","apply_strata":"Yes"},
  {"fname":"GrainSizeValues","SQLScript":"SELECT D.[PointId], C.[SampleId], A.[TestId], A.[ValueId], CAST(E.[PointNo] AS VARCHAR(MAX)) AS [PointNo], D.[SampleNo], round(D.[Depth1],3) as [Depth], round(E.[Z1] - D.[Depth1],3) as [Level], round(A.[Diameter],4) as [Diameter], round(A.[WPercent],2) as [WPercent], round(A.[Fpercent],2) as [Fpercent], round(C.[Distance],2) as [Distance] FROM (((#DB#[GrainSizeValues] A inner join #DB#[GrainSizeTests] B on A.TestId = B.TestId) inner join #DB#[GrainSizes] C on B.GrainSizeId = C.GrainSizeId) inner join #DB#[Samples] D on C.SampleId = D.SampleId) inner join #DB#[Points] E on D.PointId = E.PointId where E.ProjectID IN (#projectid#) #pointfilter# ORDER BY PointNo ASC, SampleNo ASC, Depth1 ASC, Distance ASC, A.Diameter ASC","pointfilter":"D.PointId IN (#pointid#)","apply_strata":"Yes"},
  {"fname":"CPTData","SQLScript":"SELECT B.[PointId], A.[TestId], CAST(C.[PointNo] AS VARCHAR(MAX)) AS [PointNo], round(A.[Depth],3) as [Depth], round(A.[DepthC],3) as [DepthC], round(C.[Z1] - A.[Depth],3) as [Level], round(A.[qc],4) as [qc], round(D.[ConeAreaRatio],2) as [ConeAreaRatio], round(A.[fs]*1000,2) as [fs], round(A.[u1]*1000,2) as [u1], round(A.[u2]*1000,2) as [u2], round(A.[u3]*1000,2) as [u3], round(A.[Slope1],2) as [Slope1], round(A.[Slope2],2) as [Slope2], round(A.[QNET],4) as [QNET], round(A.[HPT],2) as [HPT], round(A.[UndrainedShearStrengthBE],2) as [Su] FROM ((#DB#[CPTData] A inner join #DB#[CPTPush] B on A.TestId = B.TestId) inner join #DB#[Points] C on B.PointId = C.PointId) inner join #DB#[CPTPush] D on A.TestId = D.TestId where C.ProjectID IN (#projectid#) #pointfilter# ORDER BY A.TestId ASC, Depth ASC","pointfilter":"B.PointId IN (#pointid#)","apply_strata":"Yes"},
  {"fname":"Classification","SQLScript":"SELECT B.[PointID] as [PointId], A.[SampleId], A.[TestId], A.[DataSourceId], CAST(C.[PointNo] AS VARCHAR(MAX)) AS [PointNo], round(B.[Depth1],3) as [Depth], round(C.[Z1] - B.[Depth1],3) as [Level], round(A.[Distance],3) as [Distance], round(A.[MC],2) as [MC], round(A.[UW],2) as [UW], round(A.[UWD],2) as [UWD], round(A.[BDen],2) as [BDen], round(A.[BDenD],2) as [BDenD], round(A.[E],2) as [E], round(A.[ECalc],2) as [ECalc], round(A.[CA],2) as [CA], round(A.[N],2) as [N], round(A.[WL],2) as [WL], round(A.[WP],2) as [WP], round(A.[IP],2) as [IP], round(A.[IL],2) as [IL], round(A.[CR],2) as [CR], round(A.[DS],2) as [DS], round(A.[DSEstim],2) as [DSEstim], A.[Pycnometer], round(A.[ORGC],2) as [ORGC], round(A.[ORGCR],2) as [ORGCR], round(A.[EMin],2) as [EMin], round(A.[EMax],2) as [EMax], round(A.[NMin],2) as [NMin], round(A.[NMax],2) as [NMax], B.[Description] FROM (#DB#[ClassificationTests] A inner join #DB#[Samples] B on A.SampleId = B.SampleId) inner join #DB#[Points] C on B.PointId = C.PointId where C.ProjectID IN (#projectid#) #pointfilter# ORDER BY B.PointId ASC, Depth1 ASC","pointfilter":"B.PointId IN (#pointid#)","apply_strata":"Yes"},
  {"fname":"InsituVaneTests","SQLScript":"SELECT A.[PointId], A.[TestId], CAST(B.[PointNo] AS VARCHAR(MAX)) AS [PointNo], round(B.[Z1] - A.[Depth],3) as [Level], round(A.[Depth],3) as [Depth], A.[Vane], A.[CFVCode], round(A.[CFV],3) as [CFV], A.[CRVCode], round(A.[CRV],2) as [CRV], A.[Description] FROM #DB#[InsituVaneTests] A inner join #DB#[Points] B on A.PointId = B.PointId where B.ProjectID IN (#projectid#) #pointfilter# ORDER BY A.PointId ASC, Depth ASC","pointfilter":"A.PointId IN (#pointid#)","apply_strata":"Yes"},
  {"fname":"UCTData","SQLScript":"SELECT B.[PointID] as [PointId], A.[SampleId], A.[TestId], CAST(C.[PointNo] AS VARCHAR(MAX)) AS [PointNo], round(B.[Depth1],3) as [Depth], round(C.[Z1] - B.[Depth1],3) as [Level], round(A.[Distance],2) as [Distance], round(B.[RQD],2) as [RQD], round(A.[MC],2) as [MC], A.[Condition], A.[Duration], round(A.[CU],2) as [CU], round(A.[QU],2) as [QU], round(A.[ES],2) as [ES], round(A.[MU],2) as [MU], round(A.[EpsFail],2) as [EpsFail], A.[Failure], A.[Description] FROM (#DB#[UCTData] A inner join #DB#[Samples] B on A.SampleId = B.SampleId) inner join #DB#[Points] C on B.PointId = C.PointId where C.ProjectID IN (#projectid#) #pointfilter# ORDER BY B.PointId ASC, Depth1 ASC","pointfilter":"B.PointId IN (#pointid#)","apply_strata":"Yes"},
  {"fname":"Indurations","SQLScript":"SELECT A.[PointId], A.[SampleId], A.[LayerId], C.[ValueId], CAST(B.[PointNo] AS VARCHAR(MAX)) AS [PointNo], A.[SampleNo], A.[SampleType], round(A.[Depth1],3) as [Depth], round(B.[Z1] - A.[Depth1],3) as [Level], round(A.[Depth1],3) as [Depth1], round(A.[Depth2],3) as [Depth2], round(C.[Distance],2) as [Distance], round(C.[Length],2) as [Length], round(C.[V1],2) as [V1], round(C.[V2],2) as [V2], A.[Description], A.[Description2], round(A.[EDepth1],2) as [EDepth1], round(A.[EDepth2],2) as [EDepth2] FROM (#DB#[Samples] A inner join #DB#[Points] B on A.PointId = B.PointId) inner join #DB#[Indurations] C on A.SampleId = C.SampleId where B.ProjectID IN (#projectid#) #pointfilter# ORDER BY A.PointId ASC, Depth1 ASC","pointfilter":"A.PointId IN (#pointid#)","apply_strata":"Yes"},
  {"fname":"BrazilianTests","SQLScript":"SELECT A.[PointId], A.[SampleId], A.[LayerId], CAST(B.[PointNo] AS VARCHAR(MAX)) AS [PointNo], A.[SampleNo], round(A.[Depth1],3) as [Depth], round(B.[Z1] - A.[Depth1],3) as [Level], round(C.[Distance],2) as [Distance], round(A.[Depth1],3) as [Depth1], round(A.[Depth2],3) as [Depth2], C.[Duration], round(C.[StressRate],2) as [StressRate], round(C.[MC],2) as [MC], round(C.[TS],2) as [TS], C.[Failure] FROM (#DB#[Samples] A inner join #DB#[Points] B on A.PointId = B.PointId) inner join #DB#[BrazilianTests] C on A.SampleId = C.SampleId where B.ProjectID IN (#projectid#) #pointfilter# ORDER BY A.PointId ASC, Depth1 ASC","pointfilter":"A.PointId IN (#pointid#)","apply_strata":"Yes"},
  {"fname":"GrainSizes","SQLScript":"SELECT B.[PointId], A.[SampleId], CAST(C.[PointNo] AS VARCHAR(MAX)) AS [PointNo], B.[SampleNo], round(B.[Depth1],3) as [Depth], round(C.[Z1] - B.[Depth1],3) as [Level], round(A.[Distance],2) as [Distance], A.[D10], A.[D15], A.[D20], A.[D25], A.[D30], A.[D50], A.[D60], A.[D75], A.[D90], A.[UC], A.[UCc], A.[Clayf], A.[Siltf], A.[Sandf], A.[Gravelf], A.[Cobblesf] FROM (#DB#[GrainSizes] A inner join #DB#[Samples] B on A.SampleId = B.SampleId) inner join #DB#[Points] C on B.PointId = C.PointId where C.ProjectID IN (#projectid#) #pointfilter# ORDER BY PointNo ASC, SampleNo ASC, Depth1 ASC, Distance ASC","pointfilter":"B.PointId IN (#pointid#)","apply_strata":"Yes"}
]"#;

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
