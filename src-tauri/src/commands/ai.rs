// AI assistant (tier 1, issue #300).
//
// A provider-agnostic chat helper.  It talks to any OpenAI-compatible
// `/chat/completions` endpoint, so the user can point it at OpenAI, Together,
// Groq, OpenRouter, Azure-OpenAI, a local Ollama (`http://localhost:11434/v1`),
// etc. — base URL, API key and model are all editable in-app and persisted
// globally in `%APPDATA%/GIRTool/ai_config.json`.
//
// The system preprompt is authored in AGENTS.md (a bundled resource, or an
// override dropped at `%APPDATA%/GIRTool/AGENTS.md`) plus an optional in-app
// `system_prompt` field — deliberately NOT CLAUDE.md.
//
// The `embeddings` endpoint is stored here too but only used by the RAG
// follow-up; this module just keeps it in the config shape.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

// ── Config ─────────────────────────────────────────────────────────────────────

/// One OpenAI-compatible endpoint (chat or embeddings).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ApiEndpoint {
    /// e.g. "https://api.openai.com/v1" — the part before /chat/completions.
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AiConfig {
    #[serde(default)]
    pub chat: ApiEndpoint,
    /// Used by the RAG follow-up (document search); stored here from the start.
    #[serde(default)]
    pub embeddings: ApiEndpoint,
    /// Optional extra preprompt appended to AGENTS.md.
    #[serde(default)]
    pub system_prompt: String,
}

fn ai_dir() -> Result<PathBuf, String> {
    let appdata = std::env::var("APPDATA").map_err(|_| "APPDATA is not set".to_string())?;
    let dir = PathBuf::from(appdata).join("GIRTool");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn ai_config_path() -> Result<PathBuf, String> {
    Ok(ai_dir()?.join("ai_config.json"))
}

pub(crate) fn read_config() -> AiConfig {
    ai_config_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn get_ai_config() -> Result<AiConfig, String> {
    Ok(read_config())
}

#[tauri::command]
pub async fn save_ai_config(config: AiConfig) -> Result<(), String> {
    let path = ai_config_path()?;
    let json = serde_json::to_string_pretty(&config).map_err(|e| format!("Serialise error: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

/// System preprompt: a user override at `%APPDATA%/GIRTool/AGENTS.md` wins,
/// otherwise the bundled resource; empty when neither exists.
pub(crate) fn read_agents_md(app: &AppHandle) -> String {
    if let Ok(dir) = ai_dir() {
        if let Ok(s) = std::fs::read_to_string(dir.join("AGENTS.md")) {
            if !s.trim().is_empty() {
                return s;
            }
        }
    }
    if let Ok(p) = app
        .path()
        .resolve("resources/AGENTS.md", tauri::path::BaseDirectory::Resource)
    {
        if let Ok(s) = std::fs::read_to_string(p) {
            return s;
        }
    }
    String::new()
}

#[tauri::command]
pub async fn get_agents_md(app: AppHandle) -> Result<String, String> {
    Ok(read_agents_md(&app))
}

// ── Chat ───────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

fn join_url(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

/// Build the system prompt for a turn (AGENTS.md + the optional extra prompt).
/// `extra_context` is appended too — the RAG follow-up passes retrieved
/// document snippets here.
pub(crate) fn build_system_prompt(app: &AppHandle, cfg: &AiConfig, extra_context: &str) -> String {
    let mut sys = read_agents_md(app);
    if !cfg.system_prompt.trim().is_empty() {
        if !sys.is_empty() {
            sys.push_str("\n\n");
        }
        sys.push_str(cfg.system_prompt.trim());
    }
    if !extra_context.trim().is_empty() {
        if !sys.is_empty() {
            sys.push_str("\n\n");
        }
        sys.push_str(extra_context.trim());
    }
    sys
}

/// Send the conversation to the configured chat endpoint and return the
/// assistant's reply text.  OpenAI-compatible request/response shape.
#[tauri::command]
pub async fn ai_chat(app: AppHandle, messages: Vec<ChatMessage>) -> Result<String, String> {
    let cfg = read_config();
    if cfg.chat.base_url.trim().is_empty() || cfg.chat.model.trim().is_empty() {
        return Err("AI is not configured — set the chat API URL and model in the ⚙ Connection panel.".into());
    }

    let sys = build_system_prompt(&app, &cfg, "");
    let mut out_msgs: Vec<Value> = Vec::new();
    if !sys.trim().is_empty() {
        out_msgs.push(json!({ "role": "system", "content": sys }));
    }
    for m in &messages {
        out_msgs.push(json!({ "role": m.role, "content": m.content }));
    }

    let url = join_url(&cfg.chat.base_url, "chat/completions");
    let body = json!({ "model": cfg.chat.model, "messages": out_msgs, "stream": false });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;
    let mut req = client.post(&url).json(&body);
    if !cfg.chat.api_key.trim().is_empty() {
        req = req.bearer_auth(cfg.chat.api_key.trim());
    }

    let resp = req.send().await.map_err(|e| format!("Request failed: {e}"))?;
    let status = resp.status();
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("Bad response from the API: {e}"))?;

    if !status.is_success() {
        let msg = v
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .or_else(|| v.get("message").and_then(|m| m.as_str()))
            .unwrap_or("the API returned an error");
        return Err(format!("AI error ({}): {msg}", status.as_u16()));
    }

    let content = v
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();

    if content.trim().is_empty() {
        return Err("The model returned an empty reply.".into());
    }
    Ok(content)
}

// ── File attach ────────────────────────────────────────────────────────────────

const ATTACH_MAX_CHARS: usize = 100_000;

/// Pick a text file and return its contents to include as chat context.
/// (PDF support arrives with the RAG follow-up, which adds the PDF reader.)
#[tauri::command]
pub async fn ai_pick_file(app: AppHandle) -> Result<Option<Value>, String> {
    tokio::task::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_title("Attach a file to the chat")
            .add_filter(
                "Text files",
                &["txt", "md", "markdown", "csv", "tsv", "json", "log", "rs", "py", "js", "ts", "yaml", "yml", "toml", "xml", "sql"],
            )
            .blocking_pick_file();
        let Some(fp) = picked else { return Ok(None) };
        let path = fp.into_path().map_err(|e| format!("{e}"))?;
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let bytes = std::fs::read(&path).map_err(|e| format!("Cannot read file: {e}"))?;
        let mut text = match std::str::from_utf8(&bytes) {
            Ok(s) => s.to_string(),
            Err(_) => encoding_rs::WINDOWS_1252.decode(&bytes).0.into_owned(),
        };
        let truncated = text.chars().count() > ATTACH_MAX_CHARS;
        if truncated {
            text = text.chars().take(ATTACH_MAX_CHARS).collect();
        }
        Ok(Some(json!({ "name": name, "text": text, "truncated": truncated })))
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?
}
