/**
 * JupyterLab theme → chat-ui. The chat bundle styles itself from VS Code's
 * `--vscode-*` custom properties (chat-ui/src/styles.css). Its iframe has an
 * opaque origin, so JupyterLab's `--jp-*` variables cannot cascade into it:
 * their computed values are copied under the `--vscode-*` names instead
 * (injected into the srcdoc, then sent as `ui/theme` when the theme changes).
 * The diff backgrounds have no JupyterLab counterpart and keep the bundle's
 * translucent defaults, which read on light and dark alike.
 */
export const THEME_MAP: Readonly<Record<string, string>> = {
  '--vscode-foreground': '--jp-ui-font-color1',
  '--vscode-descriptionForeground': '--jp-ui-font-color2',
  '--vscode-sideBar-background': '--jp-layout-color1',
  '--vscode-editor-background': '--jp-layout-color0',
  '--vscode-panel-border': '--jp-border-color1',
  '--vscode-widget-border': '--jp-border-color2',
  '--vscode-input-background': '--jp-input-background',
  '--vscode-input-foreground': '--jp-ui-font-color1',
  '--vscode-input-border': '--jp-input-border-color',
  '--vscode-focusBorder': '--jp-brand-color1',
  '--vscode-button-background': '--jp-brand-color1',
  '--vscode-button-foreground': '--jp-ui-inverse-font-color1',
  '--vscode-button-hoverBackground': '--jp-brand-color0',
  '--vscode-button-secondaryBackground': '--jp-layout-color2',
  '--vscode-button-secondaryForeground': '--jp-ui-font-color1',
  '--vscode-button-secondaryHoverBackground': '--jp-layout-color3',
  '--vscode-textBlockQuote-background': '--jp-layout-color2',
  '--vscode-textCodeBlock-background': '--jp-cell-editor-background',
  '--vscode-textLink-foreground': '--jp-content-link-color',
  '--vscode-textPreformat-foreground': '--jp-mirror-editor-keyword-color',
  '--vscode-errorForeground': '--jp-error-color1',
  '--vscode-editorWarning-foreground': '--jp-warn-color1',
  '--vscode-testing-iconPassed': '--jp-success-color1',
  '--vscode-dropdown-background': '--jp-layout-color1',
  '--vscode-dropdown-foreground': '--jp-ui-font-color1',
  '--vscode-dropdown-border': '--jp-border-color1',
  '--vscode-gitDecoration-addedResourceForeground': '--jp-success-color1',
  '--vscode-gitDecoration-deletedResourceForeground': '--jp-error-color1',
  '--vscode-editorWidget-background': '--jp-layout-color0',
  '--vscode-font-family': '--jp-ui-font-family',
  '--vscode-font-size': '--jp-ui-font-size1',
  '--vscode-editor-font-family': '--jp-code-font-family'
};

/**
 * The `--vscode-*` values for the current JupyterLab theme, read through
 * `get` (e.g. `getComputedStyle(document.body).getPropertyValue`). Unset
 * JupyterLab variables are left out, so the bundle's fallback applies.
 */
export function jupyterThemeVars(get: (name: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [vscodeName, jpName] of Object.entries(THEME_MAP)) {
    const value = (get(jpName) ?? '').trim();
    if (value) out[vscodeName] = value;
  }
  return out;
}

/** A CSS value safe to place inside `<style>:root{…}</style>`. */
export function isSafeCssValue(value: string): boolean {
  return value.length <= 500 && !/[<>;{}\\]/.test(value);
}
