#!/usr/bin/env python3
"""Build the AI assistant's RAG index from src-tauri/resources/ai_knowledge/.

Extracts text from PDF / MD / TXT / CSV, chunks it, and writes
src-tauri/resources/ai_rag_index.json (bundled into builds). Incremental: only
new or changed files are re-processed (sha256 manifest); deleted files dropped.

It also copies the index to the app's runtime override at
%APPDATA%/GIRTool/ai_rag_index.json (when that folder exists) so the *running*
app picks the new knowledge up immediately — no rebuild — and clears the stale
embeddings cache so it re-embeds.

Run from the repo root:  python scripts/index_knowledge.py
PDF support needs:        pip install pypdf
"""
import os
import sys
import json
import glob
import shutil
import hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
KNOWLEDGE_DIR = os.path.join(ROOT, "src-tauri", "resources", "ai_knowledge")
OUT = os.path.join(ROOT, "src-tauri", "resources", "ai_rag_index.json")

EXTS = ("pdf", "md", "markdown", "txt", "csv")
CHUNK = 1000      # characters per chunk
OVERLAP = 150     # overlap between consecutive chunks

try:
    from pypdf import PdfReader
    HAVE_PYPDF = True
except ImportError:
    HAVE_PYPDF = False


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(65536), b""):
            h.update(block)
    return h.hexdigest()


def extract(path):
    """Return the file's text, or None when it can't be read (e.g. a PDF with
    pypdf missing — the caller counts those as skipped)."""
    ext = path.lower().rsplit(".", 1)[-1]
    if ext in ("md", "markdown", "txt", "csv"):
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    if ext == "pdf":
        if not HAVE_PYPDF:
            return None
        try:
            reader = PdfReader(path)
            return "\n".join((pg.extract_text() or "") for pg in reader.pages)
        except Exception as e:
            print(f"  ! could not read {os.path.basename(path)}: {e}", file=sys.stderr)
            return None
    return None


def chunk_text(text):
    text = " ".join(text.split())  # normalise whitespace
    out, i, step = [], 0, max(1, CHUNK - OVERLAP)
    while i < len(text):
        piece = text[i:i + CHUNK].strip()
        if piece:
            out.append(piece)
        i += step
    return out


def deploy_to_appdata(index_path):
    """Copy the index to the app's runtime override and clear the embeddings
    cache, so the running app re-RAGs immediately. No-op off Windows / when the
    app data folder doesn't exist yet."""
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return
    gir = os.path.join(appdata, "GIRTool")
    if not os.path.isdir(gir):
        print(f"(skipped runtime deploy — {gir} doesn't exist yet; run the app once)")
        return
    shutil.copyfile(index_path, os.path.join(gir, "ai_rag_index.json"))
    cache = os.path.join(gir, "ai_rag_embeddings.json")
    if os.path.exists(cache):
        os.remove(cache)
    print(f"Deployed to runtime override -> {os.path.join(gir, 'ai_rag_index.json')} "
          "(embeddings will rebuild on the next question)")


def main():
    os.makedirs(KNOWLEDGE_DIR, exist_ok=True)

    prev = {}
    if os.path.exists(OUT):
        try:
            with open(OUT, encoding="utf-8") as f:
                prev = json.load(f)
        except Exception:
            prev = {}
    prev_manifest = prev.get("manifest", {})
    by_source = {}
    for c in prev.get("chunks", []):
        by_source.setdefault(c.get("source"), []).append(c)

    files = [
        f for f in sorted(glob.glob(os.path.join(KNOWLEDGE_DIR, "**", "*"), recursive=True))
        if os.path.isfile(f)
        and not os.path.basename(f).startswith((".", "~$"))
        and os.path.basename(f).lower() != "readme.md"
        and f.lower().rsplit(".", 1)[-1] in EXTS
    ]

    manifest, chunks, rebuilt, reused, skipped_pdf = {}, [], 0, 0, 0
    for f in files:
        rel = os.path.relpath(f, KNOWLEDGE_DIR).replace("\\", "/")
        digest = sha256(f)
        manifest[rel] = digest
        if prev_manifest.get(rel) == digest and rel in by_source:
            chunks.extend(by_source[rel])
            reused += 1
            continue
        text = extract(f)
        if text is None and f.lower().endswith(".pdf") and not HAVE_PYPDF:
            skipped_pdf += 1
            del manifest[rel]  # don't record it as indexed — retry next run
            continue
        if not text or not text.strip():
            continue
        for j, piece in enumerate(chunk_text(text)):
            chunks.append({"id": f"{rel}#{j}", "source": rel, "text": piece})
        rebuilt += 1

    removed = [s for s in by_source if s and s not in manifest]
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"chunks": chunks, "manifest": manifest}, f, ensure_ascii=False)

    print(f"Indexed {len(files)} file(s): {rebuilt} (re)built, {reused} unchanged, "
          f"{len(removed)} removed -> {len(chunks)} chunks -> {os.path.relpath(OUT, ROOT)}")
    if skipped_pdf:
        print(f"\n!!  {skipped_pdf} PDF(s) SKIPPED — pypdf is not installed. "
              "Run:  pip install pypdf   then re-run this script.\n", file=sys.stderr)

    deploy_to_appdata(OUT)

    if chunks:
        print("NOTE: ai_rag_index.json now holds extracted text — do not commit it "
              "if the documents are confidential (see ai_knowledge/README.md).")


if __name__ == "__main__":
    main()
