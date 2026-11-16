// GPU Router -> Janitor AI прокси для Cloudflare Workers
// Всё, что можно менять, находится в блоке НАСТРОЙКИ ниже.

// ===================== НАСТРОЙКИ =====================
const UPSTREAM = "https://gpurouter.io/v1";

// Показывать размышления модели в чате (true) или скрыть (false)
const SHOW_REASONING = true;

// Сила размышлений, если Janitor её не указал: "low", "medium" или "high"
const DEFAULT_EFFORT = "medium";

// Если хочешь всегда использовать одну модель, впиши её ID сюда.
// Пусто = берётся модель, указанная в Janitor.
const FORCE_MODEL = "";

// Как оборачивать размышления в тексте ответа
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>\n\n";
// =====================================================

function corsHeaders(request) {
  const reqHeaders = request.headers.get("Access-Control-Request-Headers");
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": reqHeaders || "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

// Достаёт читаемый текст размышлений из message или delta
function extractReasoning(obj) {
  if (!obj) return "";
  if (typeof obj.reasoning === "string" && obj.reasoning) return obj.reasoning;
  if (typeof obj.reasoning_content === "string" && obj.reasoning_content) {
    return obj.reasoning_content;
  }
  if (Array.isArray(obj.reasoning_details)) {
    return obj.reasoning_details
      .map((d) => {
        if (!d) return "";
        if (d.type === "reasoning.summary") return d.summary || "";
        if (d.type === "reasoning.text") return d.text || "";
        return "";
      })
      .join("");
  }
  return "";
}

function stripReasoningFields(obj) {
  delete obj.reasoning;
  delete obj.reasoning_content;
  delete obj.reasoning_details;
}

// Обработка одного события потока (SSE)
function makeStreamTransformer() {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let inThink = false;

  function processPayload(payload) {
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      return payload;
    }
    if (!Array.isArray(obj.choices)) return payload;

    for (const choice of obj.choices) {
      const delta = choice.delta;
      if (!delta) continue;

      const reasoning = extractReasoning(delta);
      stripReasoningFields(delta);

      let out = "";
      if (SHOW_REASONING && reasoning) {
        if (!inThink) {
          out += THINK_OPEN;
          inThink = true;
        }
        out += reasoning;
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        if (inThink) {
          out += THINK_CLOSE;
          inThink = false;
        }
        out += delta.content;
      }
      if (choice.finish_reason && inThink) {
        out += THINK_CLOSE;
        inThink = false;
      }
      if (out) delta.content = out;
    }
    return JSON.stringify(obj);
  }

  function processEvent(event) {
    return event
      .split("\n")
      .map((line) => {
        if (!line.startsWith("data:")) return line;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return line;
        return "data: " + processPayload(payload);
      })
      .join("\n");
  }

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        controller.enqueue(encoder.encode(processEvent(event) + "\n\n"));
      }
    },
    flush(controller) {
      if (buffer.trim()) {
        controller.enqueue(encoder.encode(processEvent(buffer) + "\n\n"));
      }
    },
  });
}

export default {
  async fetch(request) {
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    // Убираем /v1 в начале, чтобы работали оба варианта адреса
    const path = url.pathname.replace(/^\/v1(?=\/|$)/, "");

    if (path === "" || path === "/") {
      return new Response("GPU Router proxy is running.", {
        headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const headers = new Headers();
    const auth = request.headers.get("Authorization");
    if (auth) headers.set("Authorization", auth);
    headers.set("Content-Type", "application/json");

    const isChat =
      request.method === "POST" && path.endsWith("/chat/completions");

    let body;
    if (request.method !== "GET" && request.method !== "HEAD") {
      body = await request.text();
      if (isChat) {
        try {
          const payload = JSON.parse(body);
          if (FORCE_MODEL) payload.model = FORCE_MODEL;

          const effort =
            (payload.reasoning && payload.reasoning.effort) ||
            payload.reasoning_effort ||
            DEFAULT_EFFORT;
          delete payload.reasoning_effort;
          payload.reasoning = {
            ...(payload.reasoning || {}),
            effort,
            exclude: !SHOW_REASONING,
          };
          body = JSON.stringify(payload);
        } catch {
          // Если тело не JSON, отправляем как есть
        }
      }
    }

    let upstream;
    try {
      upstream = await fetch(UPSTREAM + path + url.search, {
        method: request.method,
        headers,
        body,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: { message: "Proxy error: " + err.message } }),
        { status: 502, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const contentType = upstream.headers.get("Content-Type") || "application/json";
    const outHeaders = {
      ...cors,
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    };

    // Ошибки и не-чат запросы отдаём как есть
    if (!isChat || !upstream.ok) {
      return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
    }

    // Потоковый ответ
    if (contentType.includes("text/event-stream")) {
      return new Response(upstream.body.pipeThrough(makeStreamTransformer()), {
        status: upstream.status,
        headers: { ...outHeaders, "X-Accel-Buffering": "no" },
      });
    }

    // Обычный (не потоковый) ответ
    try {
      const data = await upstream.json();
      for (const choice of data.choices || []) {
        const msg = choice.message;
        if (!msg) continue;
        const reasoning = extractReasoning(msg);
        stripReasoningFields(msg);
        if (SHOW_REASONING && reasoning && typeof msg.content === "string") {
          msg.content = THINK_OPEN + reasoning + THINK_CLOSE + msg.content;
        }
      }
      return new Response(JSON.stringify(data), {
        status: upstream.status,
        headers: outHeaders,
      });
    } catch {
      return new Response("Bad response from upstream", { status: 502, headers: cors });
    }
  },
};
