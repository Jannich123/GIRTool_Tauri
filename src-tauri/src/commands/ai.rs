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

    // RAG (#302): when the embeddings endpoint is configured and there's a
    // knowledge index, retrieve excerpts for the latest question and inject
    // them as context.  Best-effort — a retrieval failure never blocks chat.
    let last_user = messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default();
    let rag = if !cfg.embeddings.base_url.trim().is_empty()
        && !cfg.embeddings.model.trim().is_empty()
        && !last_user.trim().is_empty()
    {
        retrieve_context(&app, &cfg, &last_user, 5).await.unwrap_or_default()
    } else {
        String::new()
    };

    let sys = build_system_prompt(&app, &cfg, &rag);
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

// ── RAG: bundled knowledge index + runtime embeddings (issue #302) ──────────────
//
// `resources/ai_rag_index.json` is produced at build time by
// scripts/index_knowledge.py (chunked PDF/MD/TXT text).  It can be overridden
// at `%APPDATA%/GIRTool/ai_rag_index.json` so confidential extracted text need
// not live in the repo.  Embeddings are computed lazily at runtime and cached
// (keyed by the embeddings model + an index signature) so they are only redone
// when the documents or the model change.

use std::hash::{Hash, Hasher};

#[derive(Clone, Serialize, Deserialize)]
struct RagChunk {
    #[serde(default)]
    id: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    text: String,
}

#[derive(Default, Deserialize)]
struct RagIndex {
    #[serde(default)]
    chunks: Vec<RagChunk>,
}

#[derive(Default, Serialize, Deserialize)]
struct EmbedCache {
    #[serde(default)]
    model: String,
    #[serde(default)]
    sig: String,
    #[serde(default)]
    vectors: Vec<Vec<f32>>,
}

/// Load the knowledge chunks: an `%APPDATA%/GIRTool/ai_rag_index.json` override
/// wins, otherwise the bundled resource; empty when neither has chunks.
fn load_rag_index(app: &AppHandle) -> Vec<RagChunk> {
    if let Ok(dir) = ai_dir() {
        if let Ok(s) = std::fs::read_to_string(dir.join("ai_rag_index.json")) {
            if let Ok(ix) = serde_json::from_str::<RagIndex>(&s) {
                if !ix.chunks.is_empty() {
                    return ix.chunks;
                }
            }
        }
    }
    if let Ok(p) = app
        .path()
        .resolve("resources/ai_rag_index.json", tauri::path::BaseDirectory::Resource)
    {
        if let Ok(s) = std::fs::read_to_string(p) {
            if let Ok(ix) = serde_json::from_str::<RagIndex>(&s) {
                return ix.chunks;
            }
        }
    }
    Vec::new()
}

fn embed_cache_path() -> Result<PathBuf, String> {
    Ok(ai_dir()?.join("ai_rag_embeddings.json"))
}

/// Stable signature of the index content — changes when chunks are added,
/// removed, or edited, invalidating the embeddings cache.
fn index_signature(chunks: &[RagChunk]) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    chunks.len().hash(&mut h);
    for c in chunks {
        c.id.hash(&mut h);
        c.text.len().hash(&mut h);
    }
    format!("{:x}", h.finish())
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let (mut dot, mut na, mut nb) = (0.0f32, 0.0f32, 0.0f32);
    for i in 0..n {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na.sqrt() * nb.sqrt())
    }
}

/// OpenAI-compatible `/embeddings` — batched, order-preserving.
async fn embed_texts(ep: &ApiEndpoint, inputs: &[String]) -> Result<Vec<Vec<f32>>, String> {
    if ep.base_url.trim().is_empty() || ep.model.trim().is_empty() {
        return Err("Embeddings API is not configured.".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;
    let url = join_url(&ep.base_url, "embeddings");

    let mut out: Vec<Vec<f32>> = Vec::with_capacity(inputs.len());
    for batch in inputs.chunks(96) {
        let body = json!({ "model": ep.model, "input": batch });
        let mut req = client.post(&url).json(&body);
        if !ep.api_key.trim().is_empty() {
            req = req.bearer_auth(ep.api_key.trim());
        }
        let resp = req.send().await.map_err(|e| format!("Embeddings request failed: {e}"))?;
        let status = resp.status();
        let v: Value = resp
            .json()
            .await
            .map_err(|e| format!("Bad embeddings response: {e}"))?;
        if !status.is_success() {
            let msg = v
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("the API returned an error");
            return Err(format!("Embeddings error ({}): {msg}", status.as_u16()));
        }
        let data = v
            .get("data")
            .and_then(|d| d.as_array())
            .ok_or("No embeddings in the response.")?;
        let mut items: Vec<&Value> = data.iter().collect();
        items.sort_by_key(|it| it.get("index").and_then(|i| i.as_u64()).unwrap_or(0));
        for it in items {
            let emb = it
                .get("embedding")
                .and_then(|e| e.as_array())
                .ok_or("Malformed embedding in the response.")?
                .iter()
                .map(|n| n.as_f64().unwrap_or(0.0) as f32)
                .collect();
            out.push(emb);
        }
    }
    Ok(out)
}

/// Chunks + their embeddings, reusing the cache when the model + index are
/// unchanged, otherwise (re)embedding and refreshing the cache.
async fn ensure_embeddings(
    app: &AppHandle,
    cfg: &AiConfig,
) -> Result<(Vec<RagChunk>, Vec<Vec<f32>>), String> {
    let chunks = load_rag_index(app);
    if chunks.is_empty() {
        return Ok((chunks, Vec::new()));
    }
    let sig = index_signature(&chunks);

    if let Ok(p) = embed_cache_path() {
        if let Ok(s) = std::fs::read_to_string(&p) {
            if let Ok(cache) = serde_json::from_str::<EmbedCache>(&s) {
                if cache.model == cfg.embeddings.model
                    && cache.sig == sig
                    && cache.vectors.len() == chunks.len()
                {
                    return Ok((chunks, cache.vectors));
                }
            }
        }
    }

    let texts: Vec<String> = chunks.iter().map(|c| c.text.clone()).collect();
    let vectors = embed_texts(&cfg.embeddings, &texts).await?;
    if let Ok(p) = embed_cache_path() {
        let cache = EmbedCache {
            model: cfg.embeddings.model.clone(),
            sig,
            vectors: vectors.clone(),
        };
        if let Ok(s) = serde_json::to_string(&cache) {
            let _ = std::fs::write(p, s);
        }
    }
    Ok((chunks, vectors))
}

/// Retrieve the top-`k` knowledge excerpts for `query`, formatted as a context
/// block for the system prompt.  Empty when there is no index / no good match.
async fn retrieve_context(
    app: &AppHandle,
    cfg: &AiConfig,
    query: &str,
    k: usize,
) -> Result<String, String> {
    let (chunks, vectors) = ensure_embeddings(app, cfg).await?;
    if chunks.is_empty() || vectors.len() != chunks.len() {
        return Ok(String::new());
    }
    let q_text: String = query.chars().take(2000).collect();
    let qv = embed_texts(&cfg.embeddings, &[q_text]).await?;
    let q = qv.first().ok_or("No query embedding.")?;

    let mut scored: Vec<(f32, usize)> = vectors
        .iter()
        .enumerate()
        .map(|(i, v)| (cosine(q, v), i))
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut ctx = String::from(
        "Reference excerpts from the project's documentation. Use them to answer when relevant and cite the source name; ignore them when they do not apply.\n",
    );
    let mut used = 0;
    for (score, i) in scored.into_iter().take(k) {
        if score < 0.2 {
            continue; // drop weak matches
        }
        let c = &chunks[i];
        ctx.push_str(&format!("\n[source: {}]\n{}\n", c.source, c.text));
        used += 1;
    }
    if used == 0 {
        return Ok(String::new());
    }
    Ok(ctx)
}

/// What the knowledge base looks like + whether embeddings are current.
#[tauri::command]
pub async fn ai_rag_status(app: AppHandle) -> Result<Value, String> {
    let chunks = load_rag_index(&app);
    let cfg = read_config();
    let mut sources: Vec<String> = chunks.iter().map(|c| c.source.clone()).collect();
    sources.sort();
    sources.dedup();
    let sig = index_signature(&chunks);
    let embedded = embed_cache_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<EmbedCache>(&s).ok())
        .map(|c| {
            !chunks.is_empty()
                && c.model == cfg.embeddings.model
                && c.sig == sig
                && c.vectors.len() == chunks.len()
        })
        .unwrap_or(false);
    Ok(json!({
        "chunk_count": chunks.len(),
        "sources": sources,
        "embedded": embedded,
        "model": cfg.embeddings.model,
    }))
}

/// Force a (re)embed of the knowledge base via the configured embeddings API.
#[tauri::command]
pub async fn ai_rebuild_embeddings(app: AppHandle) -> Result<Value, String> {
    let cfg = read_config();
    if cfg.embeddings.base_url.trim().is_empty() || cfg.embeddings.model.trim().is_empty() {
        return Err("Configure the embeddings API (base URL + model) first.".into());
    }
    if load_rag_index(&app).is_empty() {
        return Err("No knowledge index found — add documents to resources/ai_knowledge/ and run scripts/index_knowledge.py.".into());
    }
    if let Ok(p) = embed_cache_path() {
        let _ = std::fs::remove_file(p);
    }
    let (chunks, vectors) = ensure_embeddings(&app, &cfg).await?;
    Ok(json!({
        "chunk_count": chunks.len(),
        "embedded": !chunks.is_empty() && vectors.len() == chunks.len(),
    }))
}
