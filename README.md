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

## Building a release installer

```powershell
# One-time: install the Tauri CLI
cargo install tauri-cli --locked

# Build both NSIS (.exe) and WiX MSI (.msi) installers
cargo tauri build
```

Output artefacts land in `src-tauri/target/release/bundle/`:
| Format | Path | Install location |
|---|---|---|
| NSIS `.exe` | `bundle/nsis/GIRTool_x.y.z_x64-setup.exe` | `C:\Program Files\GIRTool\` |
| WiX `.msi` | `bundle/msi/GIRTool_x.y.z_x64_en-US.msi` | `C:\Program Files\GIRTool\` |

### What the NSIS installer does
1. **ODBC check** — detects whether Microsoft ODBC Driver 17 for SQL Server is installed; if not, downloads and installs it silently from Microsoft (network required).
2. **Install files** — copies the app to `Program Files\GIRTool\` (requires elevation).
3. **Shortcuts** — creates a Desktop shortcut and a Start Menu entry under `GIRTool\`.
4. **Defender exclusion** — adds the install directory to Windows Defender exclusions so Excel file operations are not slowed by real-time AV scanning.
5. **Uninstall** — available via Add/Remove Programs; removes the Defender exclusion automatically.

### WiX MSI
The MSI installer uses upgrade code `F78BF8E8-87BB-4F94-8EB4-3D1429C0110D` so subsequent versions upgrade cleanly in-place without leaving orphaned entries in Add/Remove Programs.

### Automated releases
Pushing a version tag triggers the release workflow:
```powershell
git tag v1.0.0
git push --tags
```
GitHub Actions builds both installers and publishes them as a GitHub Release.

---

## Development status

See [GitHub Issues](https://github.com/Jannich123/GIRTool_Tauri/issues) for the full task list.
