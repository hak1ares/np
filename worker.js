export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    const url = new URL(request.url);
    const target = "https://gpurouter.io" + url.pathname;

    let body = request.body;
    if (request.method === "POST") {
      const json = await request.json();

      // 1. Убираем 0, если Джанитор прислал 0 (никаких 16000 не ставим)
      if (!json.max_tokens) {
        delete json.max_tokens;
      }

      // 2. Включаем размышления строго по стандарту GPURouter (БЕЗ тупого условия if)
      json.reasoning = { exclude: false };

      // 3. Вырезаем прошлые размышления из истории, чтобы 2-е сообщение не падало в ошибку
      if (Array.isArray(json.messages)) {
        json.messages.forEach((m) => {
          if (m.role === "assistant" && typeof m.content === "string") {
            m.content = m.content.replace(/<think>[\s\S]*?<\/think>\s*/gi, "").trim();
          }
        });
      }

      body = JSON.stringify(json);
    }

    const headers = new Headers(request.headers);
    headers.set("Content-Type", "application/json");

    const response = await fetch(target, {
      method: request.method,
      headers: headers,
      body: body,
    });

    const newResponse = new Response(response.body, response);
    newResponse.headers.set("Access-Control-Allow-Origin", "*");
    return newResponse;
  },
};
