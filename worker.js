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

      // лимит, если Janitor не прислал или прислал 0
      if (!(json.max_tokens > 0)) json.max_tokens = 16000;

      // показывать размышления
      if (json.reasoning || json.reasoning_effort) {
        json.reasoning = { ...(json.reasoning || {}), exclude: false };
        if (json.reasoning_effort && !json.reasoning.effort) {
          json.reasoning.effort = json.reasoning_effort;
        }
        delete json.reasoning_effort;
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
