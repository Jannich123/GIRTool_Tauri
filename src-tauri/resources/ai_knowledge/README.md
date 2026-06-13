# AI assistant knowledge base

Drop reference documents here that the in-app AI assistant should be able to
search and cite — e.g. database schema notes, connection/lookup tables, codes,
internal guides. Supported: **.pdf, .md, .markdown, .txt, .csv**.

## How it works

The assistant uses Retrieval-Augmented Generation (RAG): the documents are
chunked into a searchable index at **build time**, and at runtime the assistant
embeds the chunks once, finds the most relevant ones for each question, and
feeds them to the model as context.

## Building / updating the index

After adding or changing files here, run (from the repo root):

```
python scripts/index_knowledge.py
```

**PDF extraction needs `pip install pypdf`** (one-time). Without it, PDFs are
skipped with a warning and the index is left without them — the usual reason
"stored PDFs aren't being searched".

This writes `../ai_rag_index.json` (bundled into builds) **and** copies it to the
running app's override at `%APPDATA%/GIRTool/ai_rag_index.json`, clearing the
embeddings cache — so the **running app picks up the new knowledge on the next
question, no rebuild**. It is **incremental** — only new or changed files are
re-processed, and deleted files are dropped.

## ⚠ Confidentiality

`ai_rag_index.json` contains the **extracted text** of whatever you put here.
If these documents are confidential, do **not** commit the populated index to
git. Two safe options:

1. Keep the populated index out of the repo and place it at
   `%APPDATA%/GIRTool/ai_rag_index.json` — the app prefers that override over
   the bundled (empty) one.
2. Or run the indexer as a local build step and `git update-index
   --skip-worktree src-tauri/resources/ai_rag_index.json` so your local
   populated copy is never committed.

The files in this folder are git-ignored by default (see `.gitignore`); only
this README is tracked.
