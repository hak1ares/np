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
      const effort = json.reasoning?.effort || json.reasoning_effort || "high";
      json.reasoning_effort = effort;
      json.reasoning = { ...(typeof json.reasoning === "object" ? json.reasoning : {}), effort, exclude: false };
      body = JSON.stringify(json);
    }

    const headers = new Headers(request.headers);
    headers.set("Content-Type", "application/json");
    const response = await fetch(target, { method: request.method, headers, body });
    const ct = response.headers.get("content-type") || "";

    // Если ответ без стриминга
    if (ct.includes("application/json")) {
      const data = await response.json();
      const msg = data.choices?.[0]?.message;
      const t = msg?.reasoning_content || msg?.reasoning || msg?.thinking || msg?.thought;
      if (t && !msg.content?.includes("<think>")) {
        msg.content = `<think>\n${t}\n</think>\n\n${msg.content || ""}`;
      }
      const res = new Response(JSON.stringify(data), response);
      res.headers.set("Access-Control-Allow-Origin", "*");
      return res;
    }

    // Если включен стриминг
    if (ct.includes("text/event-stream") && response.body) {
      let thinking = false;
      const reader = response.body.getReader();
      const dec = new TextDecoder();
      const enc = new TextEncoder();

      const stream = new ReadableStream({
        async start(ctrl) {
          let buf = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() || "";

            for (const line of lines) {
              if (!line.startsWith("data: ") || line === "data: [DONE]") {
                ctrl.enqueue(enc.encode(line + "\n"));
                continue;
              }
              try {
                const chunk = JSON.parse(line.slice(6));
                const d = chunk.choices?.[0]?.delta;
                if (d) {
                  const t = d.reasoning_content || d.reasoning || d.thinking || d.thought;
                  if (t) {
                    d.content = (!thinking ? "<think>\n" : "") + t + (d.content ? "\n</think>\n\n" + d.content : "");
                    thinking = !d.content.includes("</think>");
                  } else if (d.content && thinking) {
                    d.content = "\n</think>\n\n" + d.content;
                    thinking = false;
                  }
                }
                ctrl.enqueue(enc.encode("data: " + JSON.stringify(chunk) + "\n"));
              } catch {
                ctrl.enqueue(enc.encode(line + "\n"));
              }
            }
          }
          if (buf) ctrl.enqueue(enc.encode(buf));
          ctrl.close();
        },
      });
      const res = new Response(stream, response);
      res.headers.set("Access-Control-Allow-Origin", "*");
      return res;
    }

    const res = new Response(response.body, response);
    res.headers.set("Access-Control-Allow-Origin", "*");
    return res;
  },
};
