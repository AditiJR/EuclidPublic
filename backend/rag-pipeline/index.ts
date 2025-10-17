// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

/**
 * Public endpoints (StackAI-friendly). Remove auth:"none" to require JWT.
 */
export const config = { auth: "none" };

const APIFY_TOKEN = Deno.env.get("APIFY_TOKEN")!;
const SENSO_KEY   = Deno.env.get("SENSO_API_KEY")!;
const SENSO_BASE  = Deno.env.get("SENSO_BASE_URL") ?? "https://sdk.senso.ai/api/v1";

/* -------------------------- helpers -------------------------- */

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
function bad(msg: string, status = 400) {
  return json({ error: msg }, status);
}

function chunkMarkdown(md: string, chunkChars = 4000, overlap = 300) {
  const chunks: string[] = [];
  md = (md || "").trim();
  let i = 0;
  while (i < md.length) {
    const end = Math.min(i + chunkChars, md.length);
    chunks.push(md.slice(i, end));
    if (end >= md.length) break;
    i = end - overlap;
  }
  return chunks;
}

async function sensoPost(path: string, payload: Record<string, unknown>) {
  const r = await fetch(`${SENSO_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": SENSO_KEY,
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Senso ${path} failed: ${r.status} ${t}`);
  }
  return await r.json();
}

/* -------------------------- handlers ------------------------- */

/** POST /ingest  — scrape with Apify standby and ingest to Senso */
async function handleIngest(req: Request) {
  const body = await req.json().catch(() => ({}));
  const startUrls: string[] = Array.isArray(body.startUrls) ? body.startUrls : [];
  const maxResults = Number(body.maxResults ?? 100);

  // Use Apify RAG Web Browser standby HTTP endpoint for speed
  const query = startUrls.join(" ");
  const qs = new URLSearchParams({
    token: APIFY_TOKEN,
    query,
    maxResults: String(maxResults),
  });
  const apifyUrl = `https://rag-web-browser.apify.actor/search?${qs.toString()}`;

  const apifyResp = await fetch(apifyUrl);
  if (!apifyResp.ok) return bad(`Apify error: ${apifyResp.status}`, apifyResp.status);
  const items: any[] = await apifyResp.json();

  let ingested = 0;
  const content_ids: (string | undefined)[] = [];

  for (const it of items) {
    const url = it?.metadata?.url ?? it?.url ?? "unknown";
    const title = it?.metadata?.title ?? url ?? "Untitled";
    const markdown = it?.markdown ?? it?.text ?? "";
    if (!markdown || !markdown.trim()) continue;

    const mdWithSrc = `**Source:** ${url}\n\n${markdown}`;
    const chunks = chunkMarkdown(mdWithSrc);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const summary = (chunk.replace(/\s+/g, " ").slice(0, 280) +
        (chunk.length > 280 ? "…" : ""));
      const payload = { title: `${title} [part ${i + 1}]`, summary, text: chunk };
      const res = await sensoPost("/content/raw", payload);
      content_ids.push((res as any).id ?? (res as any).content_id);
      ingested++;
    }
  }

  return json({ ingested_chunks: ingested, content_ids });
}

/** POST /search — proxy to Senso /search and normalize response */
async function handleSearch(req: Request) {
  const body = await req.json().catch(() => ({}));
  const q = body.q as string;
  if (!q) return bad("Missing field: q");

  const payload: Record<string, unknown> = {
    query: q,
    max_results: Number(body.max_results ?? 5),
  };
  if (body.category_id) payload.category_id = body.category_id;
  if (body.topic_id) payload.topic_id = body.topic_id;

  const res = await sensoPost("/search", payload);
  const results =
    (res as any).results?.map((r: any) => ({
      content_id: r.content_id,
      title: r.title,
      score: r.score,
      chunk: r.chunk_text,
    })) ?? [];

  return json({
    answer: (res as any).answer,
    results,
    meta: {
      total_results: (res as any).total_results,
      processing_time_ms: (res as any).processing_time_ms,
    },
  });
}

/** GET /openapi.json — spec for StackAI */
function handleOpenAPI() {
  const spec = {
    openapi: "3.0.3",
    info: {
      title: "RAG Gateway (Apify → Senso)",
      version: "1.0.0",
      description:
        "Edge Function: scrape via Apify, ingest to Senso, and query via RAG.",
    },
    paths: {
      "/ingest": {
        post: {
          summary: "Scrape web pages via Apify and ingest markdown into Senso.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    startUrls: {
                      type: "array",
                      items: { type: "string" },
                      description: "List of URLs to scrape.",
                    },
                    maxResults: { type: "integer", default: 100 },
                  },
                  required: ["startUrls"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Ingestion summary",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ingested_chunks: { type: "integer" },
                      content_ids: { type: "array", items: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/search": {
        post: {
          summary: "Query Senso's RAG index and return answer + citations.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    q: { type: "string", description: "Query text" },
                    max_results: { type: "integer", default: 5 },
                    category_id: { type: "string" },
                    topic_id: { type: "string" },
                  },
                  required: ["q"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "RAG answer and results",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      answer: { type: "string" },
                      results: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            content_id: { type: "string" },
                            title: { type: "string" },
                            score: { type: "number" },
                            chunk: { type: "string" },
                          },
                        },
                      },
                      meta: {
                        type: "object",
                        properties: {
                          total_results: { type: "integer" },
                          processing_time_ms: { type: "number" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  return json(spec);
}

/* --------------------------- router -------------------------- */

serve(async (req: Request) => {
  const url = new URL(req.url);
  // function base path is /rag-gateway; strip it for routing
  const path = url.pathname.toLowerCase().replace(/^\/rag-gateway/, "");

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      },
    });
  }

  if (req.method === "GET" && (path === "/openapi.json" || path === "/openapi")) {
    return handleOpenAPI();
  }
  if (req.method === "POST" && path === "/ingest") {
    try {
      return await handleIngest(req);
    } catch (e) {
      return bad(String(e), 500);
    }
  }
  if (req.method === "POST" && path === "/search") {
    try {
      return await handleSearch(req);
    } catch (e) {
      return bad(String(e), 500);
    }
  }

  return bad("Not found", 404);
});
