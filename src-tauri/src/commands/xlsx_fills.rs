// Extract cell-background fill colours from an xlsx file.
//
// calamine reads the *values* of cells but doesn't expose their formatting,
// so when we want to know "what colour did the user paint cell B5?" we have
// to crack the xlsx zip ourselves and parse two XML files:
//
//   xl/styles.xml          — list of <fill> definitions and <cellXfs> entries
//                            that point at them.
//   xl/worksheets/sheetN.xml — each cell carries an `s="N"` attribute that
//                            indexes into <cellXfs>.
//   xl/workbook.xml + the matching .rels file are used to translate a
//   user-facing sheet *name* into the right `sheetN.xml` path.
//
// Returned format: a HashMap keyed by 0-based `(row, col)` of the cells that
// have a solid background fill — value is the 6-digit lowercase hex string
// prefixed with `#`, e.g. `"#ee5733"`.  Cells with no fill (or with a fill
// of patternType="none" / "gray125") are omitted from the map.
//
// Used as a fallback by colors.rs and boundaries.rs when a colour cell's
// text is blank — letting users assign a colour by painting the cell in
// Excel without having to type the hex code as text too.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;

/// Extract the (row, col) → "#rrggbb" map of solid-fill cell colours for a
/// given sheet inside an xlsx file.  Returns an empty map on any failure
/// (file not found, malformed xml, sheet not found, etc) — callers treat
/// "no fill data" the same as "cell had no fill".
pub fn extract_cell_fills(
    xlsx_path: &Path,
    sheet_name: &str,
) -> HashMap<(u32, u32), String> {
    let empty = HashMap::new();
    let file = match std::fs::File::open(xlsx_path) {
        Ok(f) => f,
        Err(_) => return empty,
    };
    let mut archive = match zip::ZipArchive::new(file) {
        Ok(a) => a,
        Err(_) => return empty,
    };

    // ── Load the three XML files we need ─────────────────────────────────────
    let styles_xml   = match read_zip_entry(&mut archive, "xl/styles.xml")          { Some(s) => s, None => return empty };
    let workbook_xml = match read_zip_entry(&mut archive, "xl/workbook.xml")        { Some(s) => s, None => return empty };
    let rels_xml     = match read_zip_entry(&mut archive, "xl/_rels/workbook.xml.rels") { Some(s) => s, None => return empty };

    // styles.xml → (cellXf_index → fillId) and (fillId → "#rrggbb")
    let (cell_xfs, fills) = parse_styles(&styles_xml);

    // workbook.xml: <sheet name="..." r:id="rIdN"/>
    let sheet_rid = match find_sheet_rid(&workbook_xml, sheet_name) {
        Some(r) => r,
        None    => return empty,
    };
    // .rels: rIdN → "worksheets/sheetK.xml"
    let target = match find_rid_target(&rels_xml, &sheet_rid) {
        Some(t) => t,
        None    => return empty,
    };
    // Targets in workbook.xml.rels are relative to xl/
    let sheet_path = format!("xl/{}", target.trim_start_matches('/'));
    let sheet_xml = match read_zip_entry(&mut archive, &sheet_path) {
        Some(s) => s,
        None    => return empty,
    };

    // Walk the sheet XML and resolve each cell's style to a fill colour.
    parse_sheet_fills(&sheet_xml, &cell_xfs, &fills)
}

// ── helpers ─────────────────────────────────────────────────────────────────

fn read_zip_entry<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    name:    &str,
) -> Option<String> {
    let mut f = archive.by_name(name).ok()?;
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    Some(s)
}

/// Parse `xl/styles.xml` and return:
///   * `cell_xfs[i]` = fillId for the i-th `<xf>` in `<cellXfs>`
///   * `fills[i]`    = "#rrggbb" for the i-th `<fill>`, or None if not solid
fn parse_styles(xml: &str) -> (Vec<usize>, Vec<Option<String>>) {
    let mut fills:    Vec<Option<String>> = Vec::new();
    let mut cell_xfs: Vec<usize>          = Vec::new();

    let mut reader = Reader::from_str(xml);
    reader.trim_text(true);
    let mut buf = Vec::new();

    // State machine: which <list> are we currently inside?
    #[derive(Copy, Clone, PartialEq)]
    enum InList { None, Fills, CellXfs }
    let mut in_list = InList::None;
    // Within a <fill>, we look for the first <fgColor rgb="..."/>.
    let mut current_fill_color: Option<String> = None;
    let mut current_fill_solid = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = e.name();
                let name = std::str::from_utf8(name.as_ref()).unwrap_or("");
                match name {
                    "fills"   => in_list = InList::Fills,
                    "cellXfs" => in_list = InList::CellXfs,
                    "fill" if in_list == InList::Fills => {
                        current_fill_color = None;
                        current_fill_solid = false;
                    }
                    "patternFill" if in_list == InList::Fills => {
                        // <patternFill patternType="solid">
                        for a in e.attributes().flatten() {
                            if a.key.as_ref() == b"patternType" {
                                if let Ok(v) = std::str::from_utf8(&a.value) {
                                    current_fill_solid = v == "solid";
                                }
                            }
                        }
                    }
                    "fgColor" if in_list == InList::Fills => {
                        for a in e.attributes().flatten() {
                            if a.key.as_ref() == b"rgb" {
                                if let Ok(v) = std::str::from_utf8(&a.value) {
                                    current_fill_color = Some(normalise_rgb(v));
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let name = e.name();
                let name = std::str::from_utf8(name.as_ref()).unwrap_or("");
                match name {
                    "patternFill" if in_list == InList::Fills => {
                        for a in e.attributes().flatten() {
                            if a.key.as_ref() == b"patternType" {
                                if let Ok(v) = std::str::from_utf8(&a.value) {
                                    current_fill_solid = v == "solid";
                                }
                            }
                        }
                    }
                    "fgColor" if in_list == InList::Fills => {
                        for a in e.attributes().flatten() {
                            if a.key.as_ref() == b"rgb" {
                                if let Ok(v) = std::str::from_utf8(&a.value) {
                                    current_fill_color = Some(normalise_rgb(v));
                                }
                            }
                        }
                    }
                    "xf" if in_list == InList::CellXfs => {
                        let mut fill_id: usize = 0;
                        for a in e.attributes().flatten() {
                            if a.key.as_ref() == b"fillId" {
                                if let Ok(v) = std::str::from_utf8(&a.value) {
                                    fill_id = v.parse().unwrap_or(0);
                                }
                            }
                        }
                        cell_xfs.push(fill_id);
                    }
                    _ => {}
                }
            }
            Ok(Event::End(e)) => {
                let name = e.name();
                let name = std::str::from_utf8(name.as_ref()).unwrap_or("");
                match name {
                    "fill" if in_list == InList::Fills => {
                        // Commit the finished fill.
                        let entry = if current_fill_solid { current_fill_color.clone() } else { None };
                        fills.push(entry);
                    }
                    "fills"   => in_list = InList::None,
                    "cellXfs" => in_list = InList::None,
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(_)         => break,
            _              => {}
        }
        buf.clear();
    }

    (cell_xfs, fills)
}

/// Find the r:id of the sheet with the given user-facing name in workbook.xml.
fn find_sheet_rid(xml: &str, sheet_name: &str) -> Option<String> {
    let mut reader = Reader::from_str(xml);
    reader.trim_text(true);
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                let name = e.name();
                if std::str::from_utf8(name.as_ref()).unwrap_or("") == "sheet" {
                    let mut name_val = String::new();
                    let mut rid_val  = String::new();
                    for a in e.attributes().flatten() {
                        let key = a.key.as_ref();
                        let val = std::str::from_utf8(&a.value).unwrap_or("").to_string();
                        if key == b"name" { name_val = val; }
                        else if key.ends_with(b":id") || key == b"id" { rid_val = val; }
                    }
                    if name_val == sheet_name && !rid_val.is_empty() {
                        return Some(rid_val);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_)         => break,
            _              => {}
        }
        buf.clear();
    }
    None
}

/// Look up the Target path for a given rId in workbook.xml.rels.
fn find_rid_target(xml: &str, rid: &str) -> Option<String> {
    let mut reader = Reader::from_str(xml);
    reader.trim_text(true);
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                let name = e.name();
                if std::str::from_utf8(name.as_ref()).unwrap_or("") == "Relationship" {
                    let mut id_val:     String = String::new();
                    let mut target_val: String = String::new();
                    for a in e.attributes().flatten() {
                        let key = a.key.as_ref();
                        let val = std::str::from_utf8(&a.value).unwrap_or("").to_string();
                        if key == b"Id"     { id_val = val.clone(); }
                        if key == b"Target" { target_val = val; }
                    }
                    if id_val == rid {
                        return Some(target_val);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_)         => break,
            _              => {}
        }
        buf.clear();
    }
    None
}

/// Walk the worksheet XML; for each `<c r="A1" s="N">`, look up `cell_xfs[N]
/// → fills[fillId]` and record the colour if non-empty.
fn parse_sheet_fills(
    xml:      &str,
    cell_xfs: &[usize],
    fills:    &[Option<String>],
) -> HashMap<(u32, u32), String> {
    let mut out = HashMap::new();
    let mut reader = Reader::from_str(xml);
    reader.trim_text(true);
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                let name = e.name();
                if std::str::from_utf8(name.as_ref()).unwrap_or("") == "c" {
                    let mut r_attr: Option<String> = None;
                    let mut s_attr: Option<usize>  = None;
                    for a in e.attributes().flatten() {
                        let key = a.key.as_ref();
                        let val = std::str::from_utf8(&a.value).unwrap_or("");
                        if key == b"r" { r_attr = Some(val.to_string()); }
                        else if key == b"s" { s_attr = val.parse().ok(); }
                    }
                    if let (Some(cell_ref), Some(xf_idx)) = (r_attr, s_attr) {
                        if let Some(fill_id) = cell_xfs.get(xf_idx) {
                            if let Some(Some(color)) = fills.get(*fill_id) {
                                if let Some((row, col)) = parse_cell_ref(&cell_ref) {
                                    out.insert((row, col), color.clone());
                                }
                            }
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_)         => break,
            _              => {}
        }
        buf.clear();
    }
    out
}

/// "B5" → Some((4, 1)) — 0-based row, 0-based column.
fn parse_cell_ref(s: &str) -> Option<(u32, u32)> {
    let mut col: u32 = 0;
    let mut chars = s.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_ascii_uppercase() {
            col = col * 26 + (c as u32 - 'A' as u32 + 1);
            chars.next();
        } else { break; }
    }
    let row_str: String = chars.collect();
    let row: u32 = row_str.parse().ok()?;
    if col == 0 || row == 0 { return None; }
    Some((row - 1, col - 1))
}

/// Office stores fill colours as `AARRGGBB` (8 hex digits with alpha first).
/// Strip the alpha (or any leading "FF") and prefix with `#`.  Lower-cases
/// for consistency with the rest of the codebase.
fn normalise_rgb(raw: &str) -> String {
    let t = raw.trim();
    let hex = if t.len() == 8 { &t[2..] } else { t };
    format!("#{}", hex.to_ascii_lowercase())
}
