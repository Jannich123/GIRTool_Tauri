# GIRTool — Tauri Edition

> **Status: 🚧 In development**  
> This is a full rewrite of [GIRTool](https://github.com/Jannich123/GIRTool) as a native Windows desktop application using Tauri (Rust backend) + React frontend.

---

## Why Tauri?

| | GIRTool (current) | GIRTool Tauri |
|---|---|---|
| Startup time | 3–6 sec | < 1 sec |
| Bundle size | ~200 MB | ~15 MB |
| Memory usage | ~400 MB | ~100 MB |
| Backend | Python / FastAPI | Rust / Tauri commands |
| Frontend | React (in browser) | React (embedded WebView2) |
| Distribution | PyInstaller exe + Inno Setup | Tauri bundler (MSI / NSIS) |

---

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | [Tauri 2](https://tauri.app) |
| Backend logic | Rust |
| SQL Server | `odbc` crate (ODBC Driver 17) |
| Excel output | `rust_xlsxwriter` + `calamine` |
| SharePoint auth | Microsoft Graph REST API (device-code flow) |
| Frontend | React 18 + Vite (unchanged from original) |
| Charts | Plotly.js (unchanged) |

---

## Prerequisites (development)

| Tool | Where to get it |
|---|---|
| Rust (stable) | https://rustup.rs |
| Node.js 20+ | https://nodejs.org |
| ODBC Driver 17 | https://aka.ms/downloadmsodbcsql |
| WebView2 Runtime | Pre-installed on Windows 10/11 |
| Visual Studio C++ Build Tools | https://visualstudio.microsoft.com/visual-cpp-build-tools/ |

---

## Getting started

```powershell
# Install Tauri CLI
cargo install tauri-cli

# Install frontend dependencies
cd frontend
npm install
cd ..

# Run in development mode (hot reload)
cargo tauri dev

# Build release installer
cargo tauri build
```

---

## Project structure

```
GIRTool_Tauri/
  frontend/          ← React + Vite (same as original GIRTool)
    src/
      pages/         ← All page components
      components/    ← Shared UI components
  src-tauri/         ← Rust backend
    src/
      main.rs        ← Tauri app entry point
      commands/      ← One file per feature area (database, grouping, …)
      db.rs          ← SQL Server connection pool
      state.rs       ← App-wide shared state
    Cargo.toml
    tauri.conf.json
```

---

## Development status

See [GitHub Issues](https://github.com/Jannich123/GIRTool_Tauri/issues) for the full task list.
