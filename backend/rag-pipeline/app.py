import os, textwrap
from typing import List, Optional
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from dotenv import load_dotenv
import requests
from apify_client import ApifyClient

load_dotenv()

APIFY_TOKEN = os.environ["APIFY_TOKEN"]
SENSO_KEY = os.environ["SENSO_API_KEY"]
SENSO_BASE = os.environ.get("SENSO_BASE_URL", "https://sdk.senso.ai/api/v1")

app = FastAPI(title="RAG backend", version="1.0.0")

# -------- Data models --------
class IngestBody(BaseModel):
    startUrls: Optional[List[str]] = None        # URLs to crawl
    actor_id: str = "aYG0l9s7dbB7j3gbS"         # your Apify actor id
    maxResults: int = 100

class SearchBody(BaseModel):
    q: str
    max_results: int = 5
    category_id: Optional[str] = None
    topic_id: Optional[str] = None

# -------- Helpers --------
def chunk_markdown(md: str, chunk_chars: int = 4000, overlap: int = 300):
    md = (md or "").strip()
    if not md: return []
    chunks, i = [], 0
    while i < len(md):
        end = min(i + chunk_chars, len(md))
        chunks.append(md[i:end])
        if end == len(md): break
        i = end - overlap
    return chunks

def senso_post(path: str, payload: dict):
    url = f"{SENSO_BASE}{path}"
    resp = requests.post(url, json=payload, headers={
        "Content-Type": "application/json",
        "X-API-Key": SENSO_KEY
    }, timeout=60)
    if not resp.ok:
        raise HTTPException(status_code=resp.status_code, detail=f"Senso error: {resp.text}")
    return resp.json()

# -------- Endpoints --------
@app.post("/ingest/apify")
def ingest_from_apify(body: IngestBody):
    """
    Run an Apify actor with your URLs, pull markdown results, and ingest into Senso /content/raw.
    """
    client = ApifyClient(APIFY_TOKEN)
    run_input = {
        "startUrls": [{"url": u} for u in (body.startUrls or [])],
        "respectRobotsTxtFile": True,
        "crawlerType": "playwright:adaptive",
        "removeElementsCssSelector": """nav, footer, script, style, noscript, svg, img[src^='data:'],
[role="alert"], [role="banner"], [role="dialog"], [role="alertdialog"],
[role="region"][aria-label*="skip" i], [aria-modal="true"]""",
        "blockMedia": True,
        "expandIframes": True,
        "htmlTransformer": "readableText",
        "saveMarkdown": True,
        "maxResults": body.maxResults,
    }
    run = client.actor(body.actor_id).call(run_input=run_input)
    dataset = client.dataset(run["defaultDatasetId"])

    ingested, content_ids = 0, []
    for item in dataset.iterate_items():
        url = item.get("url") or item.get("metadata", {}).get("url")
        title = (item.get("metadata") or {}).get("title") or url or "Untitled"
        markdown = item.get("markdown") or item.get("text") or ""
        if not markdown.strip():
            continue
        md = f"**Source:** {url}\n\n{markdown}"
        for idx, chunk in enumerate(chunk_markdown(md)):
            summary = textwrap.shorten(chunk.replace("\n", " "), width=280, placeholder="…")
            payload = {"title": f"{title} [part {idx+1}]", "summary": summary, "text": chunk}
            res = senso_post("/content/raw", payload)
            content_ids.append(res.get("id") or res.get("content_id"))
            ingested += 1

    return {"ingested_chunks": ingested, "content_ids": content_ids}

@app.post("/rag/search")
def rag_search(body: SearchBody):
    payload = {"query": body.q, "max_results": body.max_results}
    if body.category_id: payload["category_id"] = body.category_id
    if body.topic_id: payload["topic_id"] = body.topic_id
    res = senso_post("/search", payload)
    results = [{
        "content_id": r.get("content_id"),
        "title": r.get("title"),
        "score": r.get("score"),
        "chunk": r.get("chunk_text"),
    } for r in res.get("results", [])]
    return {
        "answer": res.get("answer"),
        "results": results,
        "meta": {
            "total_results": res.get("total_results"),
            "processing_time_ms": res.get("processing_time_ms"),
        },
    }
