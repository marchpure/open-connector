import type { ProviderDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "web_action";

export const provider: ProviderDefinition = {
  service,
  displayName: "Web Action",
  description: "Run controlled read-only HTTP requests through the shared OpenConnector action runtime.",
  categories: ["Developer Tools"],
  authTypes: ["no_auth"],
  auth: [{ type: "no_auth" }],
  actions: [
    defineProviderAction(service, {
      name: "fetch_json",
      description: "Fetch JSON from an HTTP or HTTPS URL through the guarded provider egress layer.",
      inputSchema: s.object(
        "The web request to perform.",
        {
          url: s.url("The HTTP or HTTPS URL to fetch."),
          method: s.stringEnum("The read-only HTTP method to use.", ["GET", "HEAD"]),
          headers: s.object(
            "Optional request headers. Credential-bearing headers are not allowed.",
            {},
            { additionalProperties: true },
          ),
        },
        { optional: ["method", "headers"] },
      ),
      outputSchema: s.object("The fetched response.", {
        status: s.integer("HTTP status code."),
        headers: s.object("Response headers.", {}, { additionalProperties: true }),
        data: {},
      }),
    }),
  ],
};
