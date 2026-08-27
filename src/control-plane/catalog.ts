import type { CatalogStore, RuntimeProviderDefinition } from "../catalog-store.ts";
import type { CatalogTier } from "./types.ts";

export interface EnablementEntry {
  service: string;
  tier: CatalogTier;
  connectorDefinitionVersion: string;
  owner: string;
  evidenceRef?: string;
}

export class CatalogEnablement {
  private readonly entries: Map<string, EnablementEntry>;
  private readonly catalog: CatalogStore;

  constructor(catalog: CatalogStore, entries: EnablementEntry[] = []) {
    this.catalog = catalog;
    this.entries = new Map(entries.map((entry) => [entry.service, entry]));
  }

  list(): Array<EnablementEntry & { displayName: string; actionIds: string[] }> {
    return this.catalog.providers
      .map((provider) => this.toEntry(provider))
      .filter((entry): entry is EnablementEntry & { displayName: string; actionIds: string[] } => entry !== undefined);
  }

  get(service: string): (EnablementEntry & { displayName: string; actionIds: string[] }) | undefined {
    const provider = this.catalog.providers.find((candidate) => candidate.service === service);
    return provider ? this.toEntry(provider) : undefined;
  }

  private toEntry(provider: RuntimeProviderDefinition) {
    const configured = this.entries.get(provider.service);
    if (!configured) {
      return undefined;
    }
    return {
      ...configured,
      displayName: provider.displayName,
      actionIds: provider.actions.map((action) => action.id),
    };
  }
}
