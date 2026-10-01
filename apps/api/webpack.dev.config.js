// Dev/runtime bundle for the API. Workspace packages (@bedbanks/*) ship as TypeScript source, so they must be
// compiled into the bundle (with decorator metadata via ts-loader) instead of being required at runtime.
// Everything else stays external. Output goes to dist-bundle/ so it never collides with `nest build`.
const path = require('node:path')
const webpack = require('webpack')
const nodeExternals = require('webpack-node-externals')

module.exports = (options) => ({
  ...options,
  entry: path.resolve(__dirname, 'src/main.ts'),
  output: { path: path.resolve(__dirname, 'dist-bundle'), filename: 'main.js' },
  externals: [nodeExternals({ allowlist: [/^@bedbanks\//], modulesDir: path.resolve(__dirname, 'node_modules') }), nodeExternals({ allowlist: [/^@bedbanks\//], modulesDir: path.resolve(__dirname, '../../node_modules') })],
  plugins: [...(options.plugins || []), new webpack.NormalModuleReplacementPlugin(/^@bedbanks\/domain\/search-offers$/, path.resolve(__dirname, '../../packages/domain/src/search-offers.cjs'))],
  resolve: { ...options.resolve, alias: { ...(options.resolve && options.resolve.alias), '@bedbanks/domain/search-offers$': path.resolve(__dirname, '../../packages/domain/src/search-offers.cjs') }, extensionAlias: { '.js': ['.ts', '.js'] } },
})
