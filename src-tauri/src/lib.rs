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
//   commands/charts.rs     — chart config persistence + query runner
//   commands/map.rs        — WFS proxy
//   commands/boundaries.rs — boundaries xlsx
//   commands/session.rs    — session persistence

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
            commands::database::list_recent_folders,
            commands::database::forget_recent_folder,
            commands::database::load_folder_db_config,
            // database — multi-DB (issue #46)
            commands::database::list_databases,
            commands::database::save_databases,
            commands::database::test_database,
            commands::database::connect_all_databases,
            commands::database::pick_access_file,
            // projects
            commands::projects::list_projects,
            // points
            commands::points::get_points,
            // queries
            commands::queries::list_queries,
            commands::queries::save_query,
            commands::queries::delete_query,
            // grouping
            commands::grouping::list_group_systems,
            commands::grouping::save_group_systems,
            commands::grouping::get_grouping,
            commands::grouping::save_grouping,
            commands::grouping::open_grouping_excel,
            commands::grouping::reload_from_excel,
            // strata
            commands::strata::ensure_strata_file,
            commands::strata::load_strata,
            commands::strata::update_strata,
            commands::strata::get_strata_types,
            commands::strata::get_strata_data,
            commands::strata::download_strata,
            commands::strata::transfer_strata,
            commands::strata::open_strata,
            commands::strata::get_strata_layers,
            commands::strata::get_strata_point_layers,
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
            commands::colors::load_colors,
            commands::colors::save_colors,
            // columns
            commands::columns::get_column_dictionary,
            // charts
            commands::charts::get_chart_config,
            commands::charts::save_chart_config,
            commands::charts::run_chart_query,
            commands::charts::save_statistics,
            commands::charts::open_statistics,
            commands::charts::open_datasheet,
            // map
            commands::map::wfs_proxy,
            // boundaries
            commands::boundaries::get_boundaries,
            commands::boundaries::save_boundaries,
            commands::boundaries::load_boundaries_from_excel,
            commands::boundaries::open_boundaries_excel,
            // session
            commands::session::get_session,
            commands::session::patch_session,
            commands::session::save_selection,
            commands::session::load_selection,
            // windows (multi-window pop-out)
            commands::windows::open_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GIRTool");
}
