import type { CoreClient } from "./rpc/coreClient";
import type { Settings } from "./settings";

/** One installed model, as core `ollama/models` reports it. */
export interface ModelInfo {
  name: string;
  sizeBytes: number;
  family?: string;
  /** Fill-in-the-middle (`insert`): usable for inline completions. */
  supportsInsert: boolean;
  /** Tool calling: usable for agent chat. */
  supportsTools: boolean;
}

export type ModelKind = "chat" | "completion";

/** The setting each model kind writes. */
export const MODEL_SETTING: Readonly<Record<ModelKind, keyof Settings>> = Object.freeze({
  chat: "chatModel",
  completion: "completionModel",
});

export const isModelKind = (k: unknown): k is ModelKind => k === "chat" || k === "completion";

/**
 * Core `ollama/models` plus the last list that came back, shared by the
 * chat view and the palette pickers so either can fall back to it while
 * Ollama is down.
 */
export class ModelCatalog {
  /** The last successful answer (undefined until one arrives). */
  lastKnown?: ModelInfo[];

  constructor(private readonly client: Pick<CoreClient, "request">) {}

  /** Asks the core; throws (keeping `lastKnown`) when Ollama or the core is unreachable. */
  async fetch(): Promise<ModelInfo[]> {
    const { models } = await this.client.request<{ models: ModelInfo[] }>("ollama/models", {});
    this.lastKnown = models;
    return models;
  }
}

/** `986000000` → "986 MB", `17000000000` → "17.0 GB". */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
