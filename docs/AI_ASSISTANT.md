# AI assistant — developer setup

The in-app assistant is configured entirely by the developer (tokens, model,
preprompt, knowledge). The end user's window shows only the chat, a list of past
chats, and file insertion — nothing to configure.

## 1. API tokens + model — `src-tauri/resources/ai_config.json`

Fill in an **OpenAI-compatible** chat endpoint (and, for RAG, an embeddings
endpoint). Works with OpenAI, Groq, Together, OpenRouter, Azure-OpenAI, a local
Ollama (`http://localhost:11434/v1`), etc.

```json
{
  "chat":       { "base_url": "https://api.openai.com/v1", "api_key": "sk-…", "model": "gpt-4o-mini" },
  "embeddings": { "base_url": "https://api.openai.com/v1", "api_key": "sk-…", "model": "text-embedding-3-small" },
  "system_prompt": ""
}
```

This file is **bundled into the installer**, so the token ships to the users you
distribute to (that is the intent — they don't enter anything). The end user
cannot see or change it.

> ⚠ The committed copy is **empty**. After filling it in locally, keep your
> token out of git with:
> `git update-index --skip-worktree src-tauri/resources/ai_config.json`
> Or, for local testing only, put a populated copy at
> `%APPDATA%/GIRTool/ai_config.json` — it overrides the bundled one.

## 2. Preprompt — `src-tauri/resources/AGENTS.md`

The system prompt. Edit it (bundled), or drop an override at
`%APPDATA%/GIRTool/AGENTS.md` (no rebuild). `system_prompt` in the config is
appended after it.

## 3. Knowledge (RAG) — `src-tauri/resources/ai_knowledge/`

Drop reference docs (PDF/MD/TXT/CSV) there and run
`python scripts/index_knowledge.py` (incremental). See that folder's README.
Embeddings are built lazily on the first question and cached in `%APPDATA%`.

## 4. Where chats are saved

Each conversation is saved as a JSON file under the app data root,
`%APPDATA%/GIRTool/ai_chats/`. The window lists them on the left (most recent
first) with a New-chat button — ChatGPT-style.
