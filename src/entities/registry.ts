import { config } from "../config.js";
import type { EntityExtractor } from "./types.js";

interface ProviderEntry {
  extractor: EntityExtractor;
}

const registry = new Map<string, ProviderEntry>();

export function registerProvider(extractor: EntityExtractor): void {
  registry.set(extractor.provider, { extractor });
}

export function getProvider(name: string): EntityExtractor | undefined {
  return registry.get(name)?.extractor;
}

export function getActiveProvider(): EntityExtractor | undefined {
  const name = config.entityExtractionProvider;
  if (!name || name === "none") return undefined;
  return registry.get(name)?.extractor;
}

export function clearRegistry(): void {
  registry.clear();
}

export async function listProviders(): Promise<
  Array<{ name: string; version: string; available: boolean }>
> {
  const results: Array<{ name: string; version: string; available: boolean }> = [];
  for (const [name, { extractor }] of registry.entries()) {
    let available = false;
    try {
      available = await extractor.available();
    } catch {
      available = false;
    }
    results.push({ name, version: extractor.version, available });
  }
  return results;
}
