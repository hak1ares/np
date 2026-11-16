export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const target = "https://gpurouter.io" + new URL(request.url).pathname;

    // Чистые заголовки без конфликтующего Content-Length и Host
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    const auth = request.headers.get("Authorization");
    if (auth) headers.set("Authorization", auth);

    if (request.method !== "POST") {
      const res = await fetch(target, { method: request.method, headers });
      const out = new Response(res.body, res);
      out.headers.set("Access-Control-Allow-Origin", "*");
      return out;
    }

    const json = await request.json();

    // 1. Включаем размышления строго по документации GPURouter
    json.reasoning = { effort: "high" };

    // 2. Убираем прошлые <think> из истории, чтобы 2-е сообщение не падало
    if (Array.isArray(json.messages)) {
      json.messages.forEach((m) => {
        if (m.role === "assistant" && typeof m.content === "string") {
          m.content = m.content.replace(/<think>[\s\S]*?<\/think>\s*/gi, "").trim();
        }
      });
    }

    const res = await fetch(target, {
      method: "POST",
      headers,
      body: JSON.stringify(json),
    });

    // Если не стрим или пришла ошибка — отдаём как есть
    if (!res.ok || !json.stream || !res.body) {
      const out = new Response(res.body, res);
      out.headers.set("Access-Control-Allow-Origin", "*");
      return out;
    }

    // 3. Перекладываем delta.reasoning (формат GPURouter) в delta.content (для Janitor AI)
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    (async () => {
      let buf = "";
      let thinking = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";

          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith("data:") || t === "data: [DONE]") {
              await writer.write(encoder.encode(line + "\n"));
              continue;
            }
            try {
              const data = JSON.parse(t.slice(5));
              const d = data?.choices?.[0]?.delta;
              if (d) {
                const r = d.reasoning ?? d.reasoning_content;
                let text = "";
                if (r) {
                  if (!thinking) { text += "<think>\n"; thinking = true; }
                  text += r;
                  delete d.reasoning;
                  delete d.reasoning_content;
                }
                if (d.content) {
                  if (thinking) { text += "\n</think>\n\n"; thinking = false; }
                  text += d.content;
                }
                if (text) d.content = text;
              }
              await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            } catch {
              await writer.write(encoder.encode(line + "\n"));
            }
          }
        }
        if (buf) await writer.write(encoder.encode(buf));
      } finally {
        await writer.close();
      }
    })();

    const outHeaders = new Headers(res.headers);
    outHeaders.set("Access-Control-Allow-Origin", "*");
    return new Response(readable, { status: res.status, headers: outHeaders });
  },
};
