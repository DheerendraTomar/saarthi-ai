/**
 * Notebook cells as virtual files, the same scheme as the VS Code client
 * (`vscode/src/notebookUris.ts`). The core keys its overlay by file path, so
 * each code cell of `<nb>.ipynb` is synced as `file://<nb>.ipynb.cell<i>.<ext>`
 * (`i` = the cell's index in the notebook, markdown cells included), plus one
 * `file://<nb>.ipynb.cells.<ext>` holding every code cell concatenated.
 * `<nb>` is absolute: the Jupyter server's `root_dir` (the core's workspace)
 * joined with the notebook's server path.
 */

const EXT_BY_LANGUAGE: Record<string, string> = {
  python: 'py',
  javascript: 'js',
  typescript: 'ts',
  r: 'r',
  julia: 'jl'
};

const LANGUAGE_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_LANGUAGE).map(([lang, ext]) => [ext, lang])
);

/** File extension of a cell's virtual document, from the kernel language; `txt` when unknown. */
export function extForLanguage(lang: string | undefined): string {
  const key = (lang ?? '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(EXT_BY_LANGUAGE, key) ? EXT_BY_LANGUAGE[key] : 'txt';
}

/** `languageId` for a file editor's document, from its extension (`plaintext` when unknown). */
export function languageIdForPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(LANGUAGE_BY_EXT, ext) ? LANGUAGE_BY_EXT[ext] : 'plaintext';
}

/** `<rootDir>/<localPath>` (a server path is `/`-separated and relative to the root). */
export function absPath(rootDir: string, localPath: string): string {
  return `${rootDir.replace(/[/\\]+$/, '')}/${localPath.replace(/^\/+/, '')}`;
}

/** Like `encodeURIComponent`, but also `!'()*` — what `vscode.Uri.toString()` leaves unescaped is only unreserved. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * `file://` URI of an absolute path, encoded as `vscode.Uri.file(p).toString()`
 * encodes it (a Windows `C:\x` becomes `file:///c%3A/x`).
 */
export function fileUri(path: string): string {
  let p = path.replace(/\\/g, '/');
  const drive = /^([A-Za-z]):/.exec(p);
  if (drive) p = `/${drive[1].toLowerCase()}${p.slice(1)}`;
  if (!p.startsWith('/')) p = `/${p}`;
  return `file://${p.split('/').map(encodeSegment).join('/')}`;
}

/** Virtual URI of the code cell at `index` of the notebook at absolute path `nbPath`. */
export function cellUri(nbPath: string, index: number, ext: string): string {
  return fileUri(`${nbPath}.cell${index}.${ext}`);
}

/** Virtual URI of the notebook's concatenated code cells. */
export function concatUri(nbPath: string, ext: string): string {
  return fileUri(`${nbPath}.cells.${ext}`);
}
