#!/usr/bin/env python3
"""Build the AI assistant's RAG index from src-tauri/resources/ai_knowledge/.

Extracts text from PDF / MD / TXT / CSV, chunks it, and writes
src-tauri/resources/ai_rag_index.json. Incremental: only new or changed files
are re-processed (sha256 manifest); deleted files are dropped.

Run from the repo root:  python scripts/index_knowledge.py
PDF support needs:        pip install pypdf
"""
import os
import sys
import json
import glob
import hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
KNOWLEDGE_DIR = os.path.join(ROOT, "src-tauri", "resources", "ai_knowledge")
OUT = os.path.join(ROOT, "src-tauri", "resources", "ai_rag_index.json")

EXTS = ("pdf", "md", "markdown", "txt", "csv")
CHUNK = 1000      # characters per chunk
OVERLAP = 150     # overlap between consecutive chunks


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(65536), b""):
            h.update(block)
    return h.hexdigest()


def extract(path):
    ext = path.lower().rsplit(".", 1)[-1]
    if ext in ("md", "markdown", "txt", "csv"):
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    if ext == "pdf":
        try:
            from pypdf import PdfReader
        except ImportError:
            sys.exit("PDF support needs pypdf — run: pip install pypdf")
        reader = PdfReader(path)
        return "\n".join((pg.extract_text() or "") for pg in reader.pages)
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

    manifest, chunks, rebuilt, reused = {}, [], 0, 0
    for f in files:
        rel = os.path.relpath(f, KNOWLEDGE_DIR).replace("\\", "/")
        digest = sha256(f)
        manifest[rel] = digest
        if prev_manifest.get(rel) == digest and rel in by_source:
            chunks.extend(by_source[rel])
            reused += 1
            continue
        text = extract(f)
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
    if chunks:
        print("NOTE: ai_rag_index.json now holds extracted text — do not commit it "
              "if the documents are confidential (see ai_knowledge/README.md).")


if __name__ == "__main__":
    main()
