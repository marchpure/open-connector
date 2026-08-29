import type { ChildProcess } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { createPrincipalToken } from "../src/control-plane/auth.ts";
import { createSecretCodec } from "../src/server/secrets/secret-codec.ts";

const evidenceDir = "/tmp/kp-rerun-20260829/w3";
const fixturePort = 38130;
const servicePort = 38131;
const fixtureOrigin = `https://127.0.0.1:${fixturePort}`;
const serviceOrigin = `http://127.0.0.1:${servicePort}`;
const authSecret = "w3-fixture-auth-secret";
const encryptionKey = "w3-fixture-encryption-key";
const principal = {
  tenantId: "w3-tenant",
  workspaceId: "w3-workspace",
  subject: "w3-subject",
  ownerId: "w3-subject",
  audience: "w3-runtime",
};
const auth = `Bearer ${createPrincipalToken(principal, authSecret)}`;
const invocationId = "w3-real-fixture-invocation";
const autoskillRoot = "/Users/bytedance/Research/autoskill-investigation-20260827/autoskill";
const autoskillPython = join(autoskillRoot, "backend/.venv/bin/python");
let fixtureApprovalCount = 0;
let fixtureRateCount = 0;

await mkdir(evidenceDir, { recursive: true });
const dataDir = join(evidenceDir, "service-data");
const certDir = join(evidenceDir, "fixture-cert");
await mkdir(certDir, { recursive: true });
await rm(dataDir, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
createCertificate(certDir);

const fixtureLog = join(evidenceDir, "fixture-requests.jsonl");
await writeFile(fixtureLog, "");
const fixture = await startFixture(fixtureLog);
let service: ChildProcess | undefined;
const serviceLog = join(evidenceDir, "connection-service.log");
const serviceOutput = createWriteStream(serviceLog);

try {
  service = startService(dataDir, serviceOutput);
  await waitFor(`${serviceOrigin}/health`);
  const pageEvidence = await browserDiscovery();
  await writeJson("browser-journey.json", pageEvidence);
  const controlPlaneBrowser = await browserControlPlaneJourney();
  await writeJson("browser-control-plane.json", controlPlaneBrowser);
  assert(controlPlaneBrowser.status === "passed", "browser control-plane discovery journey failed");

  const session = await post<{ session: { id: string } }>("/v1/web-discovery/sessions", {
    origin: fixtureOrigin,
  });
  const capture = await post<{ result: { observationsSubmitted: number } }>("/v1/web-discovery/capture", {
    sessionId: session.session.id,
    pageUrl: `${fixtureOrigin}/`,
    approvedOrigin: fixtureOrigin,
  });
  assert(capture.result.observationsSubmitted >= 3, "real capture did not observe fixture API traffic");
  const candidates = await get<{ items: Candidate[] }>(
    `/v1/web-discovery/sessions/${encodeURIComponent(session.session.id)}/candidates`,
  );
  const listCandidate = candidates.items.find((item) => item.path === "/api/items" && item.method === "GET");
  const detailCandidate = candidates.items.find((item) => item.path === "/api/items/{id}" && item.method === "GET");
  const writeCandidate = candidates.items.find((item) => item.path.includes("/approve") && item.method === "POST");
  assert(listCandidate && detailCandidate && writeCandidate, "fixture candidates did not include list/detail/write");

  const listAction = await confirm(session.session.id, listCandidate, "listItems", "list", true);
  const detailAction = await confirm(session.session.id, detailCandidate, "getItem", "detail", true);
  const writeDenied = await confirmStatus(session.session.id, writeCandidate, "approveItem", "write", false);
  assert(
    writeDenied.status === 400 && (writeDenied.body.error?.message ?? "").includes("confirmation"),
    "write confirmation was not required",
  );
  const writeAction = await confirm(session.session.id, writeCandidate, "approveItem", "write", true, true);
  await writeJson("actions.json", { listAction, detailAction, writeAction, candidateCount: candidates.items.length });

  const listLease = await issueLease(listAction.id, listAction.connectionId, `${invocationId}-list`, 300);
  const detailLease = await issueLease(detailAction.id, detailAction.connectionId, `${invocationId}-detail`, 300);
  const writeLease = await issueLease(writeAction.id, writeAction.connectionId, `${invocationId}-write`, 300);

  const mcp = await runNodeMcp(listAction, listLease);
  await writeJson("node-mcp.json", mcp);
  assert(
    Array.isArray(mcp.tools) && mcp.tools.includes("list_allowed_actions"),
    "Node MCP tools/list omitted list_allowed_actions",
  );
  assert(
    Array.isArray(mcp.tools) && mcp.tools.includes("get_action_guide"),
    "Node MCP tools/list omitted get_action_guide",
  );
  assert(
    Array.isArray((mcp.listAllowedActions as { data?: { actions?: unknown[] } } | undefined)?.data?.actions),
    "Node MCP list_allowed_actions did not return actions",
  );
  assert(
    (mcp.actionGuide as { data?: { id?: string } } | undefined)?.data?.id === listAction.id,
    "Node MCP get_action_guide did not return the selected action",
  );
  const autoskill = await runAutoSkill(listAction, listLease);
  await writeJson("autoskill.json", autoskill);
  assert(
    Array.isArray(autoskill.tools) &&
      autoskill.tools.includes("mcp__w3-fixture__list_allowed_actions") &&
      autoskill.tools.includes("mcp__w3-fixture__get_action_guide"),
    "AutoSkill tools/list omitted the lease discovery tools",
  );

  const results = {
    pagination: await callAction(listAction, listLease, { query: { page: "1" }, pagination: { maxPages: 2 } }),
    detail: await callAction(detailAction, detailLease, { pathParams: { id: "42" } }),
    writeWithoutConfirmation: await callAction(writeAction, writeLease, {
      pathParams: { id: "42" },
      body: { approved: true },
    }),
    writeWithoutIdempotency: await callAction(writeAction, writeLease, {
      pathParams: { id: "42" },
      confirmed: true,
    }),
    writeFirst: await callAction(writeAction, writeLease, {
      pathParams: { id: "42" },
      confirmed: true,
      idempotencyKey: "w3-approve-1",
      body: { approved: true },
    }),
    writeReplay: await callAction(writeAction, writeLease, {
      pathParams: { id: "42" },
      confirmed: true,
      idempotencyKey: "w3-approve-1",
      body: { approved: true },
    }),
    fourOhFour: await callAction(
      await confirmNegative("negative404", "/api/negative/404"),
      await issueNegativeLease("negative404"),
      {},
    ),
    fiveHundred: await callAction(
      await confirmNegative("negative500", "/api/negative/500"),
      await issueNegativeLease("negative500"),
      {},
    ),
  };
  await writeJson("runtime-results.json", results);
  assert(results.pagination.ok && results.pagination.data.pages === 2, "real pagination failed");
  assert(results.detail.ok && results.detail.data.data.id === "42", "real detail failed");
  assert(!results.writeWithoutConfirmation.ok, "side effect was not gated");
  assert(!results.writeWithoutIdempotency.ok, "idempotency was not gated");
  assert(results.writeFirst.ok && results.writeReplay.ok, "idempotent write failed");
  assert(
    results.writeFirst.data.data.approvedCount >= 1 &&
      results.writeReplay.data.data.approvedCount === results.writeFirst.data.data.approvedCount,
    `write replay duplicated side effect: ${JSON.stringify({
      writeFirst: results.writeFirst,
      writeReplay: results.writeReplay,
    })}`,
  );
  assert(!results.fourOhFour.ok && !results.fiveHundred.ok, "HTTP error fixture was treated as success");
  const negatives = await runNegativeChecks(listAction, listLease, candidates.items);
  await writeJson("security-negatives.json", negatives);
  assert(
    (negatives.concurrency as { passed?: boolean }).passed === true,
    "Web Action concurrency limit was not enforced",
  );

  const restarted = await restartService(service, serviceOutput, dataDir);
  service = restarted;
  const recovered = await get<{ items: Array<{ id: string; service: string; status: string }> }>("/v1/connections");
  const recoveredAction = await getAction(listAction.id);
  assert(recoveredAction.id === listAction.id, "Action did not recover after restart");
  const recoveredCall = await callAction(recoveredAction, listLease, {
    query: { page: "1" },
    pagination: { maxPages: 1 },
  });
  assert(recoveredCall.ok, "recovered credential/action could not execute");
  await writeJson("restart-recovery.json", {
    connections: recovered.items,
    action: recoveredAction,
    call: recoveredCall,
  });

  const revoked = await post<{ revoked: boolean }>(`/v1/leases/${writeLease.jti}/revoke`, {});
  const revokedCall = await callAction(writeAction, writeLease, {
    confirmed: true,
    idempotencyKey: "w3-revoked",
    body: {},
  });
  assert(revoked.revoked && !revokedCall.ok, "revoked lease still executed");
  const expiredLease = await issueLease(listAction.id, listAction.connectionId, `${invocationId}-expired`, 1);
  await delay(1_200);
  const expiredCall = await callAction(listAction, expiredLease, {});
  assert(!expiredCall.ok, "expired lease still executed");
  const crossTenant = await getAsOtherTenant<{ items: unknown }>("/v1/connections");
  assert(Array.isArray(crossTenant.items) && crossTenant.items.length === 0, "cross-tenant connection leak");
  await writeJson("lease-security.json", { revoked, revokedCall, expiredCall, crossTenant });
  const audit = readAuditEvidence();
  await writeJson("audit.json", audit);
  const auditEvents = new Set(audit.webAction.map((entry) => entry.event));
  for (const event of ["tools_list", "tools_call", "credential_use", "failure", "revoke"]) {
    assert(auditEvents.has(event), `missing redacted Web Action audit event: ${event}`);
  }
  assert(
    audit.webAction.every(
      (entry) =>
        entry.tenant_id === principal.tenantId &&
        entry.workspace_id === principal.workspaceId &&
        (entry.invocation_id === null || typeof entry.invocation_id === "string"),
    ),
    "Web Action audit scope is incomplete",
  );
  assert(!JSON.stringify(audit).includes("fixture_session-value"), "credential leaked into audit evidence");

  const summary = {
    status: "passed",
    fixtureUrl: `${fixtureOrigin}/`,
    actionIds: [listAction.id, detailAction.id, writeAction.id],
    autoskill: autoskill.status,
    restartRecovered: recoveredAction.id === listAction.id,
    evidenceDir,
  };
  await writeJson("runner-summary.json", summary);
  console.log(JSON.stringify(summary));
} finally {
  service?.kill("SIGTERM");
  await waitForExit(service);
  await fixture.close();
  serviceOutput.end();
}

type Candidate = {
  id: string;
  origin: string;
  method: string;
  path: string;
  readOnly: boolean;
  requestSchema?: Record<string, unknown>;
  querySchema?: Record<string, unknown>;
  responseSchema?: Record<string, unknown>;
};
type Action = { id: string; connectionId: string; name: string; method: string; path: string; readOnly: boolean };
type Lease = { token: string; jti: string; invocationId: string };

async function browserDiscovery(): Promise<Record<string, unknown>> {
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(`${request.method()} ${request.url()}`));
  try {
    await page.goto(`${fixtureOrigin}/`, { waitUntil: "networkidle" });
    await page.getByTestId("username").fill("fixture-user");
    await page.getByTestId("password").fill("fixture-password");
    await page.getByRole("button", { name: "Log in" }).click();
    await page.getByTestId("dashboard").waitFor();
    await page.getByRole("button", { name: "Load items" }).click();
    await page.getByRole("button", { name: "Load detail" }).click();
    await page.getByRole("button", { name: "Approve item" }).click();
    return {
      url: page.url(),
      title: await page.title(),
      dashboard: await page.getByTestId("dashboard").innerText(),
      requests,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function browserControlPlaneJourney(): Promise<Record<string, unknown>> {
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${serviceOrigin}/web-discovery`, { waitUntil: "networkidle" });
    await page.locator("#auth").fill(auth.replace(/^Bearer /, ""));
    await page.locator("#url").fill(`${fixtureOrigin}/`);
    await page.getByRole("button", { name: "Discover" }).click();
    const listCandidate = page.locator(".candidate").filter({ hasText: "GET /api/items" }).first();
    await listCandidate.waitFor();
    await listCandidate.getByRole("button", { name: "Review this candidate" }).click();
    await page.locator("#auth-type").selectOption("cookie");
    await page.getByRole("button", { name: "Add confirmed action to context" }).click();
    await page.getByRole("button", { name: "Call action" }).click();
    await page.waitForFunction(
      () => Boolean(document.querySelector("#result")?.textContent || document.querySelector("#error")?.textContent),
      undefined,
      { timeout: 15_000 },
    );
    const result = await page.locator("#result").innerText();
    const successResult = result;
    await page.getByRole("button", { name: "Call rejected input" }).click();
    await page.waitForFunction(
      () => Boolean(document.querySelector("#result")?.textContent?.includes("web_credential_invalid")),
      undefined,
      { timeout: 15_000 },
    );
    const errorResult = await page.locator("#result").innerText();
    await page.screenshot({ path: join(evidenceDir, "browser-control-plane.png"), fullPage: true });
    const error = await page.locator("#error").innerText();
    assert(
      successResult.includes("tools") && successResult.includes("execute_action"),
      `browser MCP result omitted tools/list: ${JSON.stringify({ result: successResult, error })}`,
    );
    assert(errorResult.includes("web_credential_invalid"), "browser error state did not reject sensitive input");
    return {
      status: "passed",
      url: page.url(),
      selectedCandidate: await listCandidate.locator("strong").innerText(),
      successResult,
      errorResult,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function runNodeMcp(action: Action, lease: Lease): Promise<Record<string, unknown>> {
  const url = new URL(`${serviceOrigin}/v1/runtime/mcp/sse`);
  url.searchParams.set("connectionId", action.connectionId);
  url.searchParams.set("invocationId", lease.invocationId);
  url.searchParams.set("audience", principal.audience);
  const client = new Client({ name: "w3-real-mcp", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { "x-connection-lease": lease.token } },
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const allowed = await client.callTool({ name: "list_allowed_actions", arguments: {} });
    const guide = await client.callTool({ name: "get_action_guide", arguments: { actionId: action.id } });
    const result = await client.callTool({ name: "execute_action", arguments: { actionId: action.id, input: {} } });
    return {
      tools: tools.tools.map((tool) => tool.name),
      listAllowedActions: allowed.structuredContent,
      actionGuide: guide.structuredContent,
      result,
    };
  } finally {
    await client.close();
  }
}

async function runAutoSkill(action: Action, lease: Lease): Promise<Record<string, unknown>> {
  const configDir = join(evidenceDir, "autoskill-agent");
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, "mcp_config.yaml");
  const config = `servers:
  w3-fixture:
    transport: http
    url: ${serviceOrigin}/v1/runtime/mcp/sse?connectionId=${action.connectionId}&invocationId=${lease.invocationId}&audience=${principal.audience}
    headers:
      X-Connection-Lease: ${lease.token}
`;
  await writeFile(configPath, config);
  const source = `
import json, os, tempfile
from src.mcp.mcp_manager import McpManager
manager = McpManager(agent_folder=os.environ["W3_CONFIG_DIR"], config_path=os.environ["W3_CONFIG_PATH"])
manager.start()
try:
    tools = sorted(tool["name"] for tool in manager.get_tool_definitions())
    allowed = manager.call_tool("mcp__w3-fixture__list_allowed_actions", {})
    guide = manager.call_tool("mcp__w3-fixture__get_action_guide", {"actionId": os.environ["W3_ACTION_ID"]})
    result = manager.call_tool("mcp__w3-fixture__execute_action", {"actionId": os.environ["W3_ACTION_ID"], "input": {}})
    print(json.dumps({"status": "passed", "tools": tools, "listAllowedActions": allowed, "actionGuide": guide, "result": result, "client": "AutoSkill McpManager"}))
finally:
    manager.stop()
`;
  const sourcePath = join(evidenceDir, "autoskill-run.py");
  await writeFile(sourcePath, source);
  const child = spawn(autoskillPython, [sourcePath], {
    cwd: join(autoskillRoot, "backend"),
    env: {
      ...process.env,
      PYTHONPATH: join(autoskillRoot, "backend"),
      W3_CONFIG_DIR: configDir,
      W3_CONFIG_PATH: configPath,
      W3_ACTION_ID: action.id,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = await collectChild(child);
  if (child.exitCode !== 0) throw new Error(`AutoSkill failed: ${output.stderr}`);
  return JSON.parse(output.stdout.trim()) as Record<string, unknown>;
}

async function confirm(
  sessionId: string,
  candidate: Candidate,
  operationId: string,
  connectionName: string,
  enabled: boolean,
  sideEffectConfirmed = false,
  authenticationType: "none" | "cookie" = "cookie",
  timeoutMs = 5_000,
  maxRequestsPerMinute = 60,
): Promise<Action> {
  const body = {
    candidateId: candidate.id,
    origin: candidate.origin,
    operationId,
    readOnly: candidate.readOnly,
    connectionName,
    authentication: { type: authenticationType },
    pagination: { supported: candidate.method === "GET", maxPages: 10 },
    rateLimit: { maxRequestsPerMinute },
    timeoutMs,
    enabled,
    sideEffectConfirmed,
  };
  const response = await fetch(`${serviceOrigin}/v1/web-discovery/sessions/${sessionId}/confirm`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as { action: Action; message?: string };
  if (!response.ok) throw new Error(`confirm failed: ${JSON.stringify(payload)}`);
  return payload.action;
}

async function confirmStatus(
  sessionId: string,
  candidate: Candidate,
  operationId: string,
  connectionName: string,
  enabled: boolean,
) {
  const response = await fetch(`${serviceOrigin}/v1/web-discovery/sessions/${sessionId}/confirm`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({
      candidateId: candidate.id,
      origin: candidate.origin,
      operationId,
      readOnly: false,
      connectionName,
      authentication: { type: "cookie" },
      enabled,
    }),
  });
  return {
    status: response.status,
    body: (await response.json()) as { error?: { message?: string } },
  };
}

async function issueLease(actionId: string, connectionId: string, id: string, ttlSeconds: number): Promise<Lease> {
  const body = await post<{ token: string; claims: { jti: string } }>(`/v1/connections/${connectionId}/lease`, {
    allowedActions: [actionId],
    invocationId: id,
    audience: principal.audience,
    ttlSeconds,
  });
  return { token: body.token, jti: body.claims.jti, invocationId: id };
}

async function callAction(action: Action, lease: Lease, input: Record<string, unknown>): Promise<any> {
  const url = new URL(`${serviceOrigin}/v1/runtime/mcp/sse`);
  url.searchParams.set("connectionId", action.connectionId);
  url.searchParams.set("invocationId", lease.invocationId);
  url.searchParams.set("audience", principal.audience);
  const client = new Client({ name: "w3-runtime-call", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { "x-connection-lease": lease.token } },
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "execute_action", arguments: { actionId: action.id, input } });
    const structured = result.structuredContent;
    if (structured && typeof structured === "object") return structured;
    const text = result.content?.find((part) => part.type === "text");
    return text?.type === "text" ? JSON.parse(text.text) : { ok: false, error: { code: "empty_mcp_result" } };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "mcp_transport_rejected",
        message: error instanceof Error ? error.message : "MCP transport rejected the request.",
      },
    };
  } finally {
    await client.close();
  }
}

async function getAction(id: string): Promise<Action> {
  const db = new DatabaseSync(join(dataDir, "control.sqlite"));
  const encrypted = db.prepare("select definition_ciphertext from web_actions where id=?").get(id) as {
    definition_ciphertext: string;
  };
  if (!encrypted) throw new Error("Persisted action not found after restart.");
  return JSON.parse(await createSecretCodec(encryptionKey).decode(encrypted.definition_ciphertext)) as Action;
}

async function issueNegativeLease(name: string): Promise<Lease> {
  const action = await confirmNegative(name, name === "negative404" ? "/api/negative/404" : "/api/negative/500");
  return issueLease(action.id, action.connectionId, `${invocationId}-${name}`, 300);
}

async function confirmNegative(
  name: string,
  path: string,
  options: { responseContentType?: string; timeoutMs?: number; rateLimit?: number } = {},
): Promise<Action> {
  const session = await post<{ session: { id: string; workerToken: string } }>("/v1/web-discovery/sessions", {
    origin: fixtureOrigin,
  });
  const response = await fetch(`${serviceOrigin}/v1/web-discovery/sessions/${session.session.id}/observations`, {
    method: "POST",
    headers: {
      authorization: auth,
      "x-web-discovery-token": session.session.workerToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      url: `${fixtureOrigin}${path}`,
      method: "GET",
      requestHeaders: { accept: "application/json" },
      responseStatus: 500,
      responseContentType: options.responseContentType ?? "application/json",
      responseSample: { error: name },
    }),
  });
  const observed = (await response.json()) as { candidate: Candidate; error?: { message?: string } };
  if (!response.ok) throw new Error(`negative observation failed (${response.status}): ${JSON.stringify(observed)}`);
  const candidate = (observed as { candidate: Candidate }).candidate;
  return confirm(session.session.id, candidate, name, name, true, false, "none", options.timeoutMs, options.rateLimit);
}

async function runNegativeChecks(
  action: Action,
  lease: Lease,
  candidates: Candidate[],
): Promise<Record<string, unknown>> {
  const html = await callAction(action, lease, { query: { page: "1" }, body: { password: "must-not-be-accepted" } });
  const htmlAction = await confirmNegative("negativeHtml", "/api/negative/html");
  const htmlLease = await issueLease(htmlAction.id, htmlAction.connectionId, `${invocationId}-html`, 300);
  const htmlResponse = await callAction(htmlAction, htmlLease, {});
  const redirectAction = await confirmNegative("negativeRedirect", "/api/negative/cross-redirect");
  const redirectLease = await issueLease(
    redirectAction.id,
    redirectAction.connectionId,
    `${invocationId}-redirect`,
    300,
  );
  const redirect = await callAction(redirectAction, redirectLease, {});
  const timeoutAction = await confirmNegative("negativeTimeout", "/api/negative/timeout", { timeoutMs: 100 });
  const timeoutLease = await issueLease(timeoutAction.id, timeoutAction.connectionId, `${invocationId}-timeout`, 300);
  const timeout = await callAction(timeoutAction, timeoutLease, {});
  const rateAction = await confirmNegative("negativeRate", "/api/rate", { rateLimit: 1 });
  const rateLease = await issueLease(rateAction.id, rateAction.connectionId, `${invocationId}-rate`, 300);
  const rateFirst = await callAction(rateAction, rateLease, { query: { page: "1" } });
  const rateSecond = await callAction(rateAction, rateLease, { query: { page: "1" } });
  const concurrency = await runConcurrencyCheck(timeoutAction, timeoutLease);
  const ssrfResponse = await fetch(`${serviceOrigin}/v1/web-discovery/sessions`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ origin: "https://127.0.0.1:38132" }),
  });
  const ssrf = { status: ssrfResponse.status, body: await ssrfResponse.json() };
  const nonJsonSession = await post<{ session: { id: string; workerToken: string } }>("/v1/web-discovery/sessions", {
    origin: fixtureOrigin,
  });
  const nonJsonResponse = await fetch(
    `${serviceOrigin}/v1/web-discovery/sessions/${nonJsonSession.session.id}/observations`,
    {
      method: "POST",
      headers: {
        authorization: auth,
        "x-web-discovery-token": nonJsonSession.session.workerToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: `${fixtureOrigin}/api/negative/html`,
        method: "GET",
        requestHeaders: { accept: "text/html" },
        responseStatus: 200,
        responseContentType: "text/html",
        responseSample: "<html>blocked</html>",
      }),
    },
  );
  return {
    sensitiveInputRejected: !html.ok,
    htmlResponse: { rejected: !htmlResponse.ok, result: htmlResponse },
    redirect: { rejected: !redirect.ok, result: redirect },
    timeout: { rejected: !timeout.ok, result: timeout },
    rateLimit: { firstOk: rateFirst.ok, secondRejected: !rateSecond.ok, second: rateSecond },
    concurrency,
    contentType: { rejected: !htmlResponse.ok },
    ssrf: { rejected: ssrf.status === 400, result: ssrf },
    nonJsonDiscovery: { rejected: nonJsonResponse.status === 400, status: nonJsonResponse.status },
    candidateCount: candidates.length,
  };
}

async function runConcurrencyCheck(action: Action, lease: Lease): Promise<Record<string, unknown>> {
  const results = await Promise.all(
    Array.from({ length: 5 }, () => callAction(action, lease, { query: { page: "1" } })),
  );
  const rejected = results.filter((result) => result?.error?.code === "concurrency_limit");
  return { total: results.length, rejected: rejected.length, passed: rejected.length >= 1 };
}

async function startFixture(logPath: string): Promise<{ close(): Promise<void> }> {
  const key = await readFile(join(certDir, "fixture-key.pem"));
  const cert = await readFile(join(certDir, "fixture-cert.pem"));
  const server = createHttpsServer({ key, cert }, (request, response) => void fixtureRoute(request, response, logPath));
  await listen(server, fixturePort);
  return { close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function fixtureRoute(request: IncomingMessage, response: ServerResponse, logPath: string): Promise<void> {
  const url = new URL(request.url ?? "/", fixtureOrigin);
  const cookie = String(request.headers.cookie ?? "");
  const log = {
    method: request.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    cookie: cookie ? "[REDACTED]" : undefined,
    at: new Date().toISOString(),
  };
  await appendFile(logPath, JSON.stringify(log) + "\n");
  if (url.pathname === "/" && request.method === "GET") return sendHtml(response, fixtureHtml());
  if (url.pathname === "/login" && request.method === "POST") {
    const body = JSON.parse(await readBody(request));
    if (body.username !== "fixture-user" || body.password !== "fixture-password")
      return sendJson(response, 401, { error: "invalid credentials" });
    response.setHeader(
      "set-cookie",
      "fixture_session=fixture-session-value; Secure; HttpOnly; SameSite=Strict; Path=/",
    );
    return sendJson(response, 200, { ok: true });
  }
  if (url.pathname === "/api/rate" && request.method === "GET") {
    fixtureRateCount += 1;
    if (fixtureRateCount > 1) return sendJson(response, 429, { error: "rate limited" });
    return sendJson(response, 200, { ok: true, rateCount: fixtureRateCount });
  }
  if (url.pathname === "/api/negative/html") return sendRaw(response, 200, "text/html", "<html>blocked</html>");
  if (url.pathname === "/api/negative/cross-redirect") {
    response.statusCode = 302;
    response.setHeader("location", "https://example.invalid/blocked");
    response.end();
    return;
  }
  if (url.pathname === "/api/negative/timeout") {
    await delay(7_000);
    return sendJson(response, 200, { late: true });
  }
  if (cookie !== "fixture_session=fixture-session-value") return sendJson(response, 401, { error: "login required" });
  if (url.pathname === "/api/items" && request.method === "GET") {
    const page = url.searchParams.get("page") ?? "1";
    response.setHeader("link", page === "1" ? `<${fixtureOrigin}/api/items?page=2>; rel="next"` : "");
    return sendJson(response, 200, {
      page: Number(page),
      items: page === "1" ? [{ id: "42", title: "Fixture item" }] : [{ id: "43", title: "Second page" }],
    });
  }
  if (url.pathname === "/api/items/42" && request.method === "GET")
    return sendJson(response, 200, { id: "42", title: "Fixture item", owner: "fixture-user" });
  if (url.pathname === "/api/items/42/approve" && request.method === "POST") {
    fixtureApprovalCount += 1;
    return sendJson(response, 200, { ok: true, approvedCount: fixtureApprovalCount });
  }
  if (url.pathname === "/api/negative/404") return sendJson(response, 404, { error: "not found" });
  if (url.pathname === "/api/negative/500") return sendJson(response, 500, { error: "server error" });
  if (url.pathname === "/api/negative/redirect") {
    response.statusCode = 302;
    response.setHeader("location", `${fixtureOrigin}/api/items`);
    response.end();
    return;
  }
  return sendJson(response, 404, { error: "unknown fixture route" });
}

function fixtureHtml(): string {
  return `<!doctype html><html><head><title>W3 Fixture</title></head><body>
<form id="login"><input data-testid="username"><input data-testid="password" type="password"><button>Log in</button></form>
<section data-testid="dashboard" hidden><button id="items">Load items</button><button id="detail">Load detail</button><button id="approve">Approve item</button><pre id="output"></pre></section>
<script>
const login=document.querySelector("#login"),dashboard=document.querySelector("[data-testid=dashboard]"),out=document.querySelector("#output");
login.addEventListener("submit",async e=>{e.preventDefault();const r=await fetch("/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:document.querySelector("[data-testid=username]").value,password:document.querySelector("[data-testid=password]").value})});if(r.ok){login.hidden=true;dashboard.hidden=false}});
document.querySelector("#items").addEventListener("click",async()=>{out.textContent=JSON.stringify(await (await fetch("/api/items?page=1")).json())});
document.querySelector("#detail").addEventListener("click",async()=>{out.textContent=JSON.stringify(await (await fetch("/api/items/42")).json())});
document.querySelector("#approve").addEventListener("click",async()=>{out.textContent=JSON.stringify(await (await fetch("/api/items/42/approve",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({approved:true})})).json())});
</script></body></html>`;
}

function startService(dir: string, output: NodeJS.WritableStream): ChildProcess {
  const child = spawn(process.execPath, ["src/control-plane/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CONNECTION_SERVICE_PORT: String(servicePort),
      CONNECTION_SERVICE_HOST: "127.0.0.1",
      CONNECTION_SERVICE_DATA_DIR: dir,
      CONNECTION_SERVICE_AUTH_SECRET: authSecret,
      CONNECTION_SERVICE_ENCRYPTION_KEY: encryptionKey,
      CONNECTION_SERVICE_WEB_ALLOW_LOCALHOST_DEV: "true",
      CONNECTION_SERVICE_WEB_LOCALHOST_PORTS: String(fixturePort),
      WEB_DISCOVERY_CHROME_PATH: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      WEB_DISCOVERY_INTERACTION: "w3-fixture",
      WEB_DISCOVERY_IGNORE_HTTPS_ERRORS: "true",
      NODE_EXTRA_CA_CERTS: join(certDir, "fixture-cert.pem"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(output);
  child.stderr?.pipe(output);
  return child;
}

async function restartService(child: ChildProcess, output: NodeJS.WritableStream, dir: string): Promise<ChildProcess> {
  child.kill("SIGTERM");
  await waitForExit(child);
  const next = startService(dir, output);
  await waitFor(`${serviceOrigin}/health`);
  return next;
}

async function waitFor(url: string): Promise<void> {
  for (let index = 0; index < 120; index += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Startup is still in progress.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function post<T = any>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${serviceOrigin}${path}`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload as T;
}

async function get<T = any>(path: string): Promise<T> {
  const response = await fetch(`${serviceOrigin}${path}`, { headers: { authorization: auth } });
  const payload = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload as T;
}

async function getAsOtherTenant<T = any>(path: string): Promise<T> {
  const other = `Bearer ${createPrincipalToken({ ...principal, tenantId: "other", workspaceId: "other", subject: "other", ownerId: "other" }, authSecret)}`;
  const response = await fetch(`${serviceOrigin}${path}`, { headers: { authorization: other } });
  return (await response.json()) as T;
}

async function appendFile(path: string, value: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(path, { flags: "a" });
    stream.on("error", reject);
    stream.end(value, resolve);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  sendRaw(response, status, "application/json", JSON.stringify(body));
}
function sendHtml(response: ServerResponse, body: string): void {
  sendRaw(response, 200, "text/html", body);
}
function sendRaw(response: ServerResponse, status: number, type: string, body: string): void {
  response.statusCode = status;
  response.setHeader("content-type", type);
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
function listen(server: ReturnType<typeof createHttpsServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}
function createCertificate(directory: string): void {
  execFileSync(
    "/opt/homebrew/bin/openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "fixture-key.pem"),
      "-out",
      join(directory, "fixture-cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
}
async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(join(evidenceDir, name), JSON.stringify(value, null, 2));
}

function readAuditEvidence(): {
  webAction: Array<Record<string, unknown>>;
  discovery: Array<Record<string, unknown>>;
} {
  const database = new DatabaseSync(join(dataDir, "control.sqlite"));
  try {
    return {
      webAction: database
        .prepare(
          `select event, tenant_id, workspace_id, subject, invocation_id, action_id, detail_json
             from web_action_audit order by created_at`,
        )
        .all() as Array<Record<string, unknown>>,
      discovery: database
        .prepare(
          `select event, tenant_id, workspace_id, subject, session_id, candidate_id, detail_json
             from web_discovery_audit order by created_at`,
        )
        .all() as Array<Record<string, unknown>>,
    };
  } finally {
    database.close();
  }
}
async function collectChild(child: ChildProcess): Promise<{ stdout: string; stderr: string }> {
  let stdout = "",
    stderr = "";
  child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  await waitForExit(child);
  return { stdout, stderr };
}
function waitForExit(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
