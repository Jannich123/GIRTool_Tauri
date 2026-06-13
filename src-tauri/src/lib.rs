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
            commands::database::open_project_folder,
            commands::database::create_project,
            commands::database::copy_project,
            commands::database::set_output_folder,
            // database — multi-DB (issue #46)
            commands::database::list_databases,
            commands::database::save_databases,
            commands::database::test_database,
            commands::database::connect_all_databases,
            commands::database::pick_access_file,
            // projects
            commands::projects::list_projects,
            // projects xlsx persistence (issue #70)
            commands::projects_xlsx::save_projects_xlsx,
            commands::projects_xlsx::load_projects_xlsx,
            commands::projects_xlsx::open_projects_xlsx,
            // points
            commands::points::get_points,
            // points xlsx persistence (issue #77)
            commands::points_xlsx::save_points_xlsx,
            commands::points_xlsx::load_points_xlsx,
            commands::points_xlsx::open_points_xlsx,
            // data import wizard (issues #278, #280)
            commands::import::pick_import_path,
            commands::import::import_preview,
            commands::import::datasheet_columns,
            commands::import::import_data,
            // map address / place search (issue #294)
            commands::geocode::geocode_search,
            // AI assistant (issues #300, #302, #304)
            commands::ai::ai_status,
            commands::ai::ai_health,
            commands::ai::get_agents_md,
            commands::ai::ai_chat,
            commands::ai::ai_pick_file,
            commands::ai::ai_rag_status,
            commands::ai::ai_rebuild_embeddings,
            commands::ai::ai_list_chats,
            commands::ai::ai_load_chat,
            commands::ai::ai_save_chat,
            commands::ai::ai_delete_chat,
            // queries
            commands::queries::list_queries,
            commands::queries::save_query,
            commands::queries::delete_query,
            // query_configs — overrides for hardcoded SQL (issues #47, #52)
            commands::query_configs::get_query_configs,
            commands::query_configs::save_query_configs,
            commands::query_configs::reset_query_config,
            commands::query_configs::get_builtin_sql_templates,
            commands::query_configs::get_builtin_datasheet_queries,
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
            commands::download::append_data,
            commands::download::readd_strata,
            commands::download::reduce_cpt_data,
            // CPT calculations (M8)
            commands::cpt::get_cpt_catalog,
            commands::cpt::get_cpt_calc_config,
            commands::cpt::save_cpt_calc_config,
            commands::cpt::load_cpt_point_data,
            commands::cpt::save_cpt_point_data,
            commands::cpt::load_cpt_layer_data,
            commands::cpt::save_cpt_layer_data,
            commands::cpt::open_cpt_settings_xlsx,
            commands::cpt::run_cpt_calc,
            commands::download::list_datasheets,
            commands::download::read_datasheet,
            commands::download::downloaded_point_keys,
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
            commands::map::os_username,
            commands::map::open_url,
            commands::map::wms_capabilities,
            commands::map::wmts_capabilities,
            commands::map::cyklogram_summary,
            // map polygon-load (M4.3)
            commands::map_query::map_distinct_epsgs,
            commands::map_query::map_polygon_points,
            // map addons — local-file → GeoJSON (M4.5b)
            commands::map_addons::pick_addon_file,
            commands::map_addons::addon_file_preview,
            commands::map_addons::import_addon_file,
            commands::map_addons::load_addon_geojson,
            commands::map_addons::delete_addon_file,
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
            // coordinate system (project-scoped target CRS + elevation offsets — #145)
            commands::session::get_coordinate_system,
            commands::session::save_coordinate_system,
            // map addons (project-scoped overlay layers — M4.5)
            commands::session::get_map_addons,
            commands::session::save_map_addons,
            // CPT reduction config (persisted + auto-apply — #196)
            commands::session::get_cpt_reduction_config,
            commands::session::save_cpt_reduction_config,
            // windows (multi-window pop-out)
            commands::windows::open_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GIRTool");
}
