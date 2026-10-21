// Merged into the @jupyterlab/builder webpack config (package.json
// "jupyterlab.webpackConfig"). The builder bundles tsc's lib/*.js and has no
// TypeScript loader, but @localpilot/rpc-client (../rpc-client, linked into
// node_modules) ships TypeScript source; transpile it here.
const path = require('path');

const rpcClient = path.resolve(__dirname, '..', 'rpc-client', 'src');

module.exports = {
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        include: [rpcClient],
        use: {
          loader: require.resolve('ts-loader'),
          options: {
            transpileOnly: true,
            onlyCompileBundledFiles: true,
            configFile: path.resolve(__dirname, 'tsconfig.rpc-client.json')
          }
        }
      }
    ]
  }
};
