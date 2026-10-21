const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    ignores: [
      'node_modules/',
      'lib/',
      'localpilot_jupyter/',
      'coverage/',
      'scripts/',
      '.venv/',
      '*.js'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended
);
