// jest via @jupyterlab/testing (jsdom environment, ts-jest). @jupyterlab/*
// ship ES modules, hence the transformIgnorePatterns allow-list.
// @localpilot/rpc-client is a symlink to ../rpc-client (TypeScript source);
// jest resolves it to its real path, outside node_modules, so ts-jest
// transforms it like our own sources.
const jestJupyterLab = require('@jupyterlab/testing/lib/jest-config');

const esModules = [
  '@codemirror',
  '@jupyter/ydoc',
  '@jupyterlab/',
  '@lumino/',
  'lib0',
  'nanoid',
  'vscode-ws-jsonrpc',
  'y-protocols',
  'y-websocket',
  'yjs'
].join('|');

const baseConfig = jestJupyterLab(__dirname);

module.exports = {
  ...baseConfig,
  automock: false,
  // The built labextension has its own package.json named like ours.
  modulePathIgnorePatterns: ['<rootDir>/localpilot_jupyter/', '<rootDir>/lib/'],
  reporters: ['default'],
  testRegex: 'test/.*\\.test\\.ts$',
  transformIgnorePatterns: [`/node_modules/(?!${esModules}).+`]
};
