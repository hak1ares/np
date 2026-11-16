/**
 * Cloudflare Worker — прокси для Janitor AI → GPU Router
 *
 * Что делает:
 *  1. Принимает запрос от Janitor AI (формат OpenAI /v1/chat/completions)
 *  2. Добавляет нужные заголовки для GPU Router (Authorization + x-gpu-billing)
 *  3. Вставляет include_thoughts: true в extra_body, чтобы мышление было видно
 *  4. Пересылает запрос на https://gpurouter.io/v1/chat/completions
 *  5. Возвращает ответ обратно в Janitor AI
 *
 * Настройка:
 *  - Добавь секрет GPU_ROUTER_API_KEY через Cloudflare Dashboard
 *    (Workers → Settings → Variables → Secrets)
 *  - Или замени process.env на env.GPU_ROUTER_API_KEY (уже так и написано ниже)
 */

export default {
  async fetch(request, env) {

    // ── Разрешаем CORS (нужно для браузерных запросов от Janitor AI) ──────────
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    // Preflight-запрос
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ── Принимаем только POST на /v1/chat/completions ─────────────────────────
    const url = new URL(request.url);
    if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      return new Response(
        JSON.stringify({ error: "Используй POST /v1/chat/completions" }),
        { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // ── Читаем тело запроса от Janitor ────────────────────────────────────────
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Не удалось прочитать тело запроса" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // ── Добавляем include_thoughts для видимого мышления Gemini ───────────────
    // Это работает для моделей gemini-* через extra_body
    // Если модель не Gemini — поле просто проигнорируется
    const modelName = (body.model || "").toLowerCase();
    if (modelName.includes("gemini")) {
      body.extra_body = {
        ...(body.extra_body || {}),
        google: {
          ...(body.extra_body?.google || {}),
          thinking_config: {
            include_thoughts: true,
            // thinking_level: "medium",  // раскомментируй если хочешь
                                          // задать уровень (low/medium/high)
          },
        },
      };
    }

    // ── API-ключ из секрета Cloudflare ────────────────────────────────────────
    const apiKey = env.GPU_ROUTER_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "GPU_ROUTER_API_KEY не задан в настройках Worker" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // ── Пересылаем запрос в GPU Router ────────────────────────────────────────
    const upstream = "https://gpurouter.io/v1/chat/completions";

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstream, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          // Биллинг через предоплаченные кредиты
          "x-gpu-billing": JSON.stringify({ version: 1, source: "prepaid" }),
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Не удалось подключиться к GPU Router", detail: err.message }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // ── Возвращаем ответ Janitor AI ───────────────────────────────────────────
    // Поддерживается и стриминг (stream: true) и обычный режим
    const responseHeaders = {
      ...corsHeaders,
      "Content-Type": upstreamResponse.headers.get("Content-Type") || "application/json",
    };

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  },
};
