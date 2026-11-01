// Production bundle for `nest build` (Nest CLI webpack mode, ADR 0075).
// The @bedbanks/* workspace packages export TypeScript source (`"exports": "./src/index.ts"`), so plain tsc output would still require .ts files at
// runtime. They are bundled into dist/main.js; every npm dependency stays external and is installed by `pnpm deploy --prod` in the image.
const nodeExternals = require('webpack-node-externals')

module.exports = (options) => ({
  ...options,
  externals: [nodeExternals({ allowlist: [/^@bedbanks\//] })],
})
