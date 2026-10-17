// Builds the installable bundle into dist-package/ (no node_modules there, so
// every @deepseek-ai/* import resolves to the Harness runtime's own copy).
import { build } from 'esbuild'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const out = `${root}dist-package/`
const PACKAGE = 'dsh-mcp-bridge'
const VERSION = '0.2.1'

// Shell-shared browser modules (dsh-client-web platform.ts); everything else is inlined.
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual', '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
]

await rm(out, { recursive: true, force: true })
await mkdir(`${out}lib`, { recursive: true })

await build({
  entryPoints: [`${root}src/index.ts`],
  outfile: `${out}lib/index.js`,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@deepseek-ai/*'],
  // Bundled CJS deps (MCP SDK) may call require() on node builtins.
  banner: { js: "import { createRequire as __dmbCreateRequire } from 'node:module'; const require = __dmbCreateRequire(import.meta.url);" },
  logLevel: 'warning',
})

await build({
  entryPoints: [`${root}src/client/index.tsx`],
  outfile: `${out}lib/client.js`,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: PLATFORM_MODULES,
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'warning',
})

await writeFile(`${out}package.json`, JSON.stringify({
  name: PACKAGE,
  version: VERSION,
  description: 'Expose DeepSeek Harness agents to Claude Code over MCP, with a bottom-right toolbar for model / provider / workspace control',
  type: 'module',
  main: 'lib/index.js',
  exports: {
    '.': './lib/index.js',
    './client': './lib/client.js',
    './package.json': './package.json',
  },
  engines: { dsh: '0.2.1-rc.2' },
  dsh: {
    bundle: { patch: './cordis.patch.yml' },
    client: {
      platform: 'web',
      inject: [
        '@deepseek-ai/dsh-api-remotes',
        '@deepseek-ai/dsh-client-ui-layout',
        '@deepseek-ai/dsh-client-ui-workspace',
      ],
    },
  },
  peerDependencies: {
    '@deepseek-ai/cordis': '*',
    '@deepseek-ai/schemastery': '*',
    '@deepseek-ai/dsh-agent': '0.2.1-rc.2',
    '@deepseek-ai/dsh-llm': '0.2.1-rc.2',
    '@deepseek-ai/dsh-session': '0.2.1-rc.2',
    '@deepseek-ai/dsh-user-approval': '0.2.1-rc.2',
  },
  license: 'MIT',
}, null, 2) + '\n')

await cp(`${root}cordis.patch.yml`, `${out}cordis.patch.yml`)
await cp(`${root}bin`, `${out}bin`, { recursive: true })
console.log(`built ${out}`)
