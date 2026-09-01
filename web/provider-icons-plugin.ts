import type { Plugin } from "vite";

const catalogUrl = "https://oomol.com/en/apps/catalog.json";
const publicModuleId = "virtual:oomol-provider-icons";
const resolvedModuleId = `\0${publicModuleId}`;

interface CatalogItem {
  iconUrl?: unknown;
  service?: unknown;
}

interface CatalogPayload {
  items?: unknown;
}

interface ProviderIconsPluginOptions {
  iconUrls?: Readonly<Record<string, string>>;
}

/** Bundles OOMOL's provider icon mapping and caches it for the lifetime of the Vite process. */
export function providerIconsPlugin(options: ProviderIconsPluginOptions = {}): Plugin {
  let cachedModule: Promise<string> | undefined;

  return {
    name: "oomol-provider-icons",
    resolveId(id): string | undefined {
      return id === publicModuleId ? resolvedModuleId : undefined;
    },
    load(id): Promise<string> | undefined {
      if (id !== resolvedModuleId) {
        return undefined;
      }
      cachedModule ??= options.iconUrls
        ? Promise.resolve(serializeProviderIcons(options.iconUrls))
        : loadProviderIconsModule();
      return cachedModule;
    },
  };
}

async function loadProviderIconsModule(): Promise<string> {
  try {
    const response = await fetch(catalogUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as CatalogPayload;
    if (!Array.isArray(payload.items)) {
      throw new Error("catalog.items is not an array");
    }

    const iconUrls: Record<string, string> = {};
    for (const item of payload.items as CatalogItem[]) {
      if (typeof item.service === "string" && typeof item.iconUrl === "string" && item.iconUrl.trim()) {
        iconUrls[item.service] = item.iconUrl;
      }
    }
    return serializeProviderIcons(iconUrls);
  } catch {
    // Provider icons are decorative; an unavailable catalog must not block a runtime build.
    return serializeProviderIcons({});
  }
}

function serializeProviderIcons(iconUrls: Readonly<Record<string, string>>): string {
  return `export default ${JSON.stringify(iconUrls)};`;
}
