import type { TenantPrincipal } from "./types.ts";

import { createHmac, timingSafeEqual } from "node:crypto";

const prefix = "cp1";

export function createPrincipalToken(principal: TenantPrincipal, secret: string): string {
  const payload = Buffer.from(JSON.stringify(principal), "utf8").toString("base64url");
  return `${prefix}.${payload}.${sign(payload, secret)}`;
}

export function verifyPrincipalToken(token: string | undefined, secret: string): TenantPrincipal | undefined {
  if (!token) {
    return undefined;
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== prefix) {
    return undefined;
  }
  const expected = sign(parts[1], secret);
  const actual = Buffer.from(parts[2], "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actual.length !== expectedBuffer.length || !timingSafeEqual(actual, expectedBuffer)) {
    return undefined;
  }
  try {
    const principal = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as TenantPrincipal;
    if (
      !principal.tenantId ||
      !principal.workspaceId ||
      !principal.subject ||
      !principal.ownerId ||
      !principal.audience
    ) {
      return undefined;
    }
    return principal;
  } catch {
    return undefined;
  }
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
