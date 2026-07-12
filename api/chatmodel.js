/**
 * SokAlike007 Hacking AI — Secure Proxy Endpoint
 * ------------------------------------------------------------
 * Endpoint: POST /api/chatmodel
 *
 * Responsibilities:
 *  1. Receive chat requests from the public frontend.
 *  2. Inject the DevX API authorization key from server-side env vars
 *     (NEVER exposed to the browser).
 *  3. Forward the request to the upstream DevX Chat Model API.
 *  4. Return clean AI responses (JSON or streaming SSE) to the client.
 *  5. Handle errors gracefully and apply CORS headers.
 *
 * Environment Variables (set in Vercel → Project → Settings → Environment Variables):
 *   - DEVX_API_KEY   (required)  Authorization token for the DevX API
 *
 * Upstream API:
 *   URL    : https://devx-free-api.onrender.com/api/chatmodel
 *   Method : POST
 *   Body   : multipart/form-data
 *   Fields : message, model, modelProvider, modelType, effort, stream, authorization
 */

const UPSTREAM_URL = "https://devx-free-api.onrender.com/api/chatmodel";

const DEFAULTS = {
  model: "deepseek-v4-flash",
  modelProvider: "auto",
  modelType: "chat",
  effort: "Medium",
  stream: "false",
};

const ALLOWED_PROVIDERS = ["auto", "openai", "anthropic", "google", "deepseek", "meta", "mistral", "xai"];
const ALLOWED_EFFORTS = ["Low", "Medium", "High"];

/**
 * Apply CORS + security headers.
 */
function setHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

/**
 * Build a multipart/form-data body using Node's FormData (Node 18+).
 * Returns { body, headers }.
 */
function buildFormData(fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) {
      form.append(key, String(value));
    }
  }
  return form;
}

/**
 * Validate + sanitize incoming request body.
 */
function parseBody(req) {
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  if (!body || typeof body !== "object") body = {};

  const message = (body.message ?? "").toString().trim();
  const model = (body.model ?? DEFAULTS.model).toString();
  const modelProvider = (body.modelProvider ?? DEFAULTS.modelProvider).toString();
  const modelType = (body.modelType ?? DEFAULTS.modelType).toString();
  const effort = (body.effort ?? DEFAULTS.effort).toString();
  const stream = body.stream === true || body.stream === "true" ? "true" : "false";
  const systemPrompt = (body.systemPrompt ?? "").toString().trim();

  return { message, model, modelProvider, modelType, effort, stream, systemPrompt };
}

export default async function handler(req, res) {
  setHeaders(res);

  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
      message: "This endpoint only accepts POST requests.",
    });
  }

  // Authorization from server-side env (never from client)
  const apiKey = process.env.DEVX_API_KEY;
  if (!apiKey) {
    console.error("[chatmodel] DEVX_API_KEY environment variable is not set.");
    return res.status(500).json({
      error: "Server misconfiguration",
      message: "API key is not configured. Set DEVX_API_KEY in Vercel environment variables.",
    });
  }

  const { message, model, modelProvider, modelType, effort, stream, systemPrompt } = parseBody(req);

  if (!message) {
    return res.status(400).json({
      error: "Bad request",
      message: "The 'message' field is required.",
    });
  }

  // Compose final message (prepend system prompt if provided)
  const finalMessage = systemPrompt
    ? `[SYSTEM]: ${systemPrompt}\n\n[USER]: ${message}`
    : message;

  const formFields = {
    message: finalMessage,
    model,
    modelProvider,
    modelType,
    effort,
    stream,
    authorization: apiKey,
  };

  try {
    const form = buildFormData(formFields);

    const upstream = await fetch(UPSTREAM_URL, {
      method: "POST",
      headers: form.getHeaders ? form.getHeaders() : undefined,
      body: form,
    });

    // Handle non-OK responses from upstream
    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      console.error(`[chatmodel] Upstream error ${upstream.status}:`, errText.slice(0, 500));
      return res.status(upstream.status).json({
        error: "Upstream API error",
        status: upstream.status,
        message: errText || upstream.statusText,
      });
    }

    // ----- STREAMING RESPONSE -----
    if (stream === "true") {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      // Pipe the upstream stream directly to the client
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          res.write(chunk);
        }
      } catch (streamErr) {
        console.error("[chatmodel] Stream error:", streamErr.message);
        res.write(`\n[event: error]\n[data: ${JSON.stringify({ error: streamErr.message })}]\n`);
      } finally {
        res.end();
      }
      return;
    }

    // ----- NON-STREAMING RESPONSE -----
    const contentType = upstream.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const data = await upstream.json();
      return res.status(200).json(data);
    }

    // Plain text response
    const text = await upstream.text();
    return res.status(200).setHeader("Content-Type", "text/plain; charset=utf-8").send(text);
  } catch (err) {
    console.error("[chatmodel] Unexpected error:", err);
    return res.status(500).json({
      error: "Internal server error",
      message: err.message || "An unexpected error occurred while contacting the AI provider.",
    });
  }
}
