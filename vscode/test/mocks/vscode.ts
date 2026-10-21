// Minimal stand-in for the `vscode` module in unit tests (aliased in vitest.config.ts).
// Tests set `configValues` to control what getConfiguration() returns.

export const configValues: Record<string, unknown> = {};

export const workspace = {
  getConfiguration(section?: string) {
    const prefix = section ? `${section}.` : "";
    return {
      get<T>(key: string, defaultValue?: T): T | undefined {
        const full = prefix + key;
        return full in configValues ? (configValues[full] as T) : defaultValue;
      },
    };
  },
};
