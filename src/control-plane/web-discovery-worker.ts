import type { WebObservation } from "./web-discovery.ts";
import type { BrowserContext, Page } from "playwright-core";

import { chromium } from "playwright-core";

export interface WebDiscoveryCaptureOptions {
  pageUrl: string;
  approvedOrigin: string;
  executablePath?: string;
  storageStatePath?: string;
  durationMs?: number;
  submitObservation(observation: WebObservation): Promise<void>;
  interact?: (page: Page) => Promise<void>;
}

export async function runWebDiscoveryCapture(
  options: WebDiscoveryCaptureOptions,
): Promise<{ observationsSubmitted: number; crossOriginNavigationsBlocked: number }> {
  const approvedOrigin = normalizeOrigin(options.approvedOrigin);
  const pageUrl = new URL(options.pageUrl);
  if (pageUrl.origin !== approvedOrigin) throw new Error("Discovery page must use the approved origin.");

  const browser = await chromium.launch({
    executablePath: options.executablePath,
    headless: true,
    args: ["--disable-background-networking", "--disable-sync"],
  });
  let context: BrowserContext | undefined;
  let observationsSubmitted = 0;
  let crossOriginNavigationsBlocked = 0;
  try {
    context = await browser.newContext({
      serviceWorkers: "block",
      ...(options.storageStatePath ? { storageState: options.storageStatePath } : {}),
    });
    await context.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.protocol !== "https:" || requestUrl.origin !== approvedOrigin) {
        crossOriginNavigationsBlocked += 1;
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    const pending = new Set<Promise<void>>();
    page.on("response", (response) => {
      const task = observeResponse(response, approvedOrigin, options.submitObservation).then((submitted) => {
        if (submitted) observationsSubmitted += 1;
      });
      pending.add(task);
      void task.finally(() => pending.delete(task));
    });
    if (options.interact) await options.interact(page);
    await page.goto(pageUrl.href, { waitUntil: "networkidle" });
    if (options.durationMs) await page.waitForTimeout(options.durationMs);
    await Promise.all(pending);
    return { observationsSubmitted, crossOriginNavigationsBlocked };
  } finally {
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

async function observeResponse(
  response: import("playwright-core").Response,
  approvedOrigin: string,
  submit: (observation: WebObservation) => Promise<void>,
): Promise<boolean> {
  const request = response.request();
  const url = new URL(response.url());
  const contentType = response.headers()["content-type"] ?? "";
  const redirectedFrom = request.redirectedFrom();
  if (
    url.origin !== approvedOrigin ||
    redirectedFrom ||
    !contentType.toLowerCase().includes("json") ||
    !["xhr", "fetch"].includes(request.resourceType())
  ) {
    return false;
  }
  const requestHeaders = sanitizeHeaders(await request.allHeaders());
  const requestSample = sanitizeValue(parseJson(request.postData()));
  const requestQuerySample = sanitizeQuery(url.searchParams);
  const body = await response.body().catch(() => undefined);
  if (!body || body.byteLength > 1024 * 1024) return false;
  const responseSample = sanitizeValue(parseJson(new TextDecoder().decode(body)));
  await submit({
    url: `${url.origin}${url.pathname}`,
    method: request.method(),
    requestHeaders,
    ...(requestSample === undefined ? {} : { requestSample }),
    ...(Object.keys(requestQuerySample).length ? { requestQuerySample } : {}),
    responseStatus: response.status(),
    responseContentType: contentType,
    ...(responseSample === undefined ? {} : { responseSample }),
  });
  return true;
}

function sanitizeQuery(params: URLSearchParams): Record<string, string> {
  return Object.fromEntries(
    [...params.entries()].filter(([key]) => !isSensitiveName(key)).map(([key, value]) => [key, value]),
  );
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => ["accept", "content-type"].includes(name.toLowerCase()) && !isSensitiveName(name),
    ),
  );
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isSensitiveName(key))
      .map(([key, child]) => [key, sanitizeValue(child)]),
  );
}

function parseJson(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isSensitiveName(name: string): boolean {
  return /password|secret|token|cookie|authorization|csrf|xsrf|email|phone|ssn|social.?security|date.?of.?birth/i.test(
    name,
  );
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Web discovery requires an HTTPS origin.");
  }
  return url.origin;
}
