import { absPath, cellUri, concatUri, extForLanguage, fileUri, languageIdForPath } from '../src/cellUri';

describe('cellUri', () => {
  it('maps kernel languages to extensions like the VS Code client', () => {
    expect(extForLanguage('python')).toBe('py');
    expect(extForLanguage('Python')).toBe('py');
    expect(extForLanguage('javascript')).toBe('js');
    expect(extForLanguage('typescript')).toBe('ts');
    expect(extForLanguage('r')).toBe('r');
    expect(extForLanguage('julia')).toBe('jl');
    expect(extForLanguage('cobol')).toBe('txt');
    expect(extForLanguage('')).toBe('txt');
    expect(extForLanguage(undefined)).toBe('txt');
    expect(extForLanguage('constructor')).toBe('txt');
  });

  it('builds virtual cell and concat uris from the absolute notebook path', () => {
    const nb = absPath('/srv/root/', 'dir/a b.ipynb');
    expect(nb).toBe('/srv/root/dir/a b.ipynb');
    expect(cellUri(nb, 3, 'py')).toBe('file:///srv/root/dir/a%20b.ipynb.cell3.py');
    expect(concatUri(nb, 'py')).toBe('file:///srv/root/dir/a%20b.ipynb.cells.py');
  });

  it('encodes file uris the way vscode.Uri.file does', () => {
    expect(fileUri('/w/x#1/(a)!.py')).toBe('file:///w/x%231/%28a%29%21.py');
    expect(fileUri('/w/é.py')).toBe('file:///w/%C3%A9.py');
    expect(fileUri('C:\\Users\\me\\nb.ipynb')).toBe('file:///c%3A/Users/me/nb.ipynb');
    expect(absPath('C:\\Users\\me', 'nb.ipynb')).toBe('C:\\Users\\me/nb.ipynb');
    expect(absPath('/', 'a.py')).toBe('/a.py');
  });

  it('derives a language id from a file name', () => {
    expect(languageIdForPath('a/b.py')).toBe('python');
    expect(languageIdForPath('b.TS')).toBe('typescript');
    expect(languageIdForPath('README')).toBe('plaintext');
  });
});
