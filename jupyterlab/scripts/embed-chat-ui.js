// Copies the chat-ui single-file bundle (../chat-ui/dist/index.html, built by
// `npm run build -w chat-ui` at the repo root) to lib/chat/chat-ui.txt, next to
// the compiled lib/index.js that imports it. The labextension build bundles
// it as a string (@jupyterlab/builder's `.txt` → `asset/source` rule; `.html`
// would be emitted as a separate file instead). Run after `tsc`.
const fs = require('fs');
const path = require('path');

const source = path.resolve(__dirname, '..', '..', 'chat-ui', 'dist', 'index.html');
const target = path.resolve(__dirname, '..', 'lib', 'chat', 'chat-ui.txt');

if (!fs.existsSync(source)) {
  console.error(`embed-chat-ui: ${source} is missing; build it first with \`npm run build -w chat-ui\` at the repo root.`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
console.log(`embed-chat-ui: ${path.relative(process.cwd(), target)} (${fs.statSync(target).size} bytes)`);
