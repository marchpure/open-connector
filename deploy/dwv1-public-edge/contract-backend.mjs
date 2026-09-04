import { createServer } from "node:http";

const port = 3100;

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function headerFacts(request) {
  const authorization = request.headers.authorization ?? "";
  return {
    authorizationPresent: authorization.length > 0,
    authorizationScheme: authorization.split(/\s+/, 1)[0] || null,
    mcpSessionIdPresent: Boolean(request.headers["mcp-session-id"]),
    lastEventIdPresent: Boolean(request.headers["last-event-id"]),
  };
}

createServer((request, response) => {
  if (request.method === "GET" && (request.url === "/health" || request.url === "/ready")) {
    return json(response, 200, {
      ok: true,
      backend: "contract",
      status: "DEPLOYED",
    });
  }

  if (request.method === "GET" && request.url === "/evidence") {
    return json(response, 200, {
      status: "DEPLOYED",
      sourceSha: "20b966a0bdcbbcef55d8cba33ef5c380b2502efe",
      realMcpPath: "/mcp",
      contractProbePath: "/edge-contract/mcp",
      authorizationValueRecorded: false,
      identityStatus: "reported separately; contract probes are not OAuth evidence",
    });
  }

  if (request.method !== "POST" || request.url !== "/mcp") {
    return json(response, 404, { error: "not_found" });
  }

  const facts = headerFacts(request);
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-dwv1-contract": "header-and-stream-probe-only",
  });
  response.write(`event: edge-contract\n`);
  response.write(`data: ${JSON.stringify({ ...facts, chunk: 1 })}\n\n`);
  setTimeout(() => {
    response.end(`event: edge-contract\ndata: ${JSON.stringify({ ...facts, chunk: 2, complete: true })}\n\n`);
  }, 150);
}).listen(port, "0.0.0.0");
