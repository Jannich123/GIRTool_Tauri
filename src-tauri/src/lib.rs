// GIRTool — Tauri backend entry point
//
// Commands are organised into modules, one per feature area:
//   commands/database.rs   — SQL Server connection & settings
//   commands/projects.rs   — project listing
//   commands/points.rs     — point data queries
//   commands/queries.rs    — saved query management
//   commands/grouping.rs   — group systems + point assignments
//   commands/strata.rs     — strata interpretation
//   commands/download.rs   — Excel export
//   commands/sharepoint.rs — SharePoint / Graph API auth & sync
//   commands/colors.rs     — Colors & Symbols workbook
//   commands/columns.rs    — column dictionary
//   commands/charts.rs     — chart config persistence
//   commands/map.rs        — map / WFS proxy

mod commands;
mod db;
mod state;

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "girtool=info".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            // database
            commands::database::connect,
            commands::database::disconnect,
            commands::database::db_status,
            commands::database::browse_folder,
            commands::database::test_folder,
            commands::database::refresh_project,
            // projects
            commands::projects::list_projects,
            // points
            commands::points::get_points,
            // queries
            commands::queries::list_queries,
            commands::queries::save_query,
            commands::queries::delete_query,
            // grouping
            commands::grouping::get_grouping,
            commands::grouping::save_grouping,
            commands::grouping::open_grouping_excel,
            commands::grouping::reload_from_excel,
            // strata
            commands::strata::ensure_strata_file,
            commands::strata::load_strata,
            commands::strata::update_strata,
            // download
            commands::download::download_data,
            commands::download::save_session,
            commands::download::restore_session,
            // sharepoint
            commands::sharepoint::sp_status,
            commands::sharepoint::sp_initiate,
            commands::sharepoint::sp_poll,
            commands::sharepoint::sp_disconnect,
            commands::sharepoint::sp_list,
            commands::sharepoint::sp_sync_down,
            commands::sharepoint::sp_sync_up,
            // colors
            commands::colors::open_colors_excel,
            // columns
            commands::columns::get_columns,
            // charts
            commands::charts::get_chart_config,
            commands::charts::save_chart_config,
            // map
            commands::map::wfs_proxy,
            // boundaries
            commands::boundaries::save_boundaries,
            commands::boundaries::load_boundaries_from_excel,
            commands::boundaries::open_boundaries_excel,
            // session
            commands::session::get_session,
            commands::session::patch_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GIRTool");
}
