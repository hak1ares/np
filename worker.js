export default {
  async fetch(request) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const target = "https://gpurouter.io" + url.pathname;

    let body = request.body;
    let isStream = false;

    if (request.method === "POST") {
      const json = await request.json();
      isStream = Boolean(json.stream);

      // 1. Убираем 16к. Если в Janitor случайно стоит 0, просто удаляем поле,
      // чтобы провайдер использовал свой нормальный стандартный лимит.
      if (json.max_tokens === 0) {
        delete json.max_tokens;
      }

      // 2. Очищаем историю чата от прошлых блоков <think>...</think>,
      // чтобы на 2-м и следующих сообщениях не вылетала ошибка upstream!
      if (Array.isArray(json.messages)) {
        json.messages = json.messages.map((msg) => {
          if (msg.role === "assistant" && typeof msg.content === "string") {
            return {
              ...msg,
              content: msg.content.replace(/<think>[\s\S]*?<\/think>\s*/gi, "").trim(),
            };
          }
          return msg;
        });
      }

      // 3. Принудительно запрашиваем размышления у GPURouter
      json.include_reasoning = true;
      json.reasoning = { exclude: false };

      body = JSON.stringify(json);
    }

    // Копируем только нужные заголовки (без конфликтующего Host и Content-Length)
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    if (request.headers.get("Authorization")) {
      headers.set("Authorization", request.headers.get("Authorization"));
    }

    const response = await fetch(target, {
      method: request.method,
      headers: headers,
      body: body,
    });

    // Если это ошибка или НЕ потоковый ответ — возвращаем как есть (но склеиваем мысли, если они есть)
    if (!response.ok || !isStream || !response.body) {
      if (response.ok && !isStream && request.method === "POST") {
        try {
          const data = await response.json();
          const msg = data?.choices?.[0]?.message;
          const r = msg?.reasoning_content || msg?.reasoning;
          if (r && msg && !msg.content?.includes("<think>")) {
            msg.content = `<think>\n${r}\n</think>\n\n` + (msg.content || "");
          }
          return new Response(JSON.stringify(data), {
            status: response.status,
            headers: { ...Object.fromEntries(response.headers), ...corsHeaders },
          });
        } catch (e) {}
      }
      const newResponse = new Response(response.body, response);
      newResponse.headers.set("Access-Control-Allow-Origin", "*");
      return newResponse;
    }

    // 4. Перехватываем поток (Stream) и перекладываем размышления в обычный текст для Janitor AI
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    (async () => {
      let buffer = "";
      let isThinking = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) {
              await writer.write(encoder.encode(line + "\n"));
              continue;
            }

            const dataStr = trimmed.slice(5).trim();
            if (dataStr === "[DONE]") {
              await writer.write(encoder.encode("data: [DONE]\n\n"));
              continue;
            }

            try {
              const parsed = JSON.parse(dataStr);
              const delta = parsed?.choices?.[0]?.delta;

              if (delta) {
                const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
                const content = delta.content;

                let newContent = "";

                // Если пришли мысли в отдельном поле
                if (reasoning) {
                  if (!isThinking) {
                    newContent += "<think>\n";
                    isThinking = true;
                  }
                  newContent += reasoning;
                  delete delta.reasoning_content;
                  delete delta.reasoning;
                  delete delta.thinking;
                }

                // Если пошел основной текст ответа — закрываем тег мыслей
                if (content) {
                  if (isThinking) {
                    newContent += "\n</think>\n\n";
                    isThinking = false;
                  }
                  newContent += content;
                }

                if (newContent !== "") {
                  delta.content = newContent;
                }
              }

              await writer.write(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
            } catch (e) {
              // Если чанк не распарсился, отдаем как есть
              await writer.write(encoder.encode(line + "\n"));
            }
          }
        }

        if (buffer) {
          await writer.write(encoder.encode(buffer));
        }
      } catch (err) {
        // Игнорируем обрывы со стороны клиента
      } finally {
        await writer.close();
      }
    })();

    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");

    return new Response(readable, {
      status: response.status,
      headers: responseHeaders,
    });
  },
};
