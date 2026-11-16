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
    const nimUrl = "https://gpurouter.io" + url.pathname;

    let body = request.body;
    if (request.method === "POST") {
      const json = await request.json();

      // Добавляем включение размышлений в чистый исходный формат
      json.include_reasoning = true;
      json.reasoning = { exclude: false };

      body = JSON.stringify(json);
    }

    const headers = new Headers(request.headers);
    headers.set("Content-Type", "application/json");
    headers.delete("content-length"); // чтобы Cloudflare не рубил запрос по размеру

    const response = await fetch(nimUrl, {
      method: request.method,
      headers: headers,
      body: body,
    });

    const newResponse = new Response(response.body, response);
    newResponse.headers.set("Access-Control-Allow-Origin", "*");
    return newResponse;
  },
};
