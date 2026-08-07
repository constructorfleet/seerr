/**
 * Generates this package's type declarations from Seerr's own components.
 *
 * Generated rather than hand-written, which is the whole design of this package.
 * The 25 components it publishes have large, mostly *unexported* prop types
 * (`Button` alone is a generic over `React.ElementType` with a merged-element-props
 * helper), so restating them here would be both a lot of code and a silent drift
 * surface: a prop the host renames would keep typechecking against a stale copy,
 * and an extension author would find out at runtime.
 *
 * `@constructorfleet/extension-sdk` faces the same problem and answers it differently — it
 * re-declares the host contract and pins the two together with a conformance
 * typecheck. That works there because the surface is small and stable. Here the
 * surface is React prop types, where re-declaration is impractical, so the
 * declarations are emitted from the host source instead and there is nothing to
 * keep in step.
 *
 * ## What it does
 *
 * 1. Runs `tsc --emitDeclarationOnly` over `src/components/ExtensionUi/index.ts`,
 *    which pulls in every component's declarations plus whatever they reference.
 * 2. Rewrites the emitted `@app/*` and `@server/*` specifiers to relative paths,
 *    so the published package resolves with no `paths` configuration in the
 *    consumer — an extension is built outside this repo and has no aliases.
 * 3. Writes `dist/index.d.ts` re-exporting the component barrel, and a runtime
 *    `dist/index.js` that reads components off the host global.
 *
 * The runtime file exists mostly for completeness: in a browser the host's import
 * map redirects `@constructorfleet/extension-ui` to a server-generated shim, so this file is
 * never fetched. It matters for anything that resolves the package normally — a
 * unit test, a bundler in a panel's own tooling — and reading the same global
 * keeps those honest rather than handing back a second, unstyled copy.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const repoRoot = path.resolve(packageDirectory, '..', '..');
const distDirectory = path.join(packageDirectory, 'dist');

/** The barrel the declarations are rooted at, relative to the repo. */
const ENTRY = 'src/components/ExtensionUi/index.ts';

fs.rmSync(distDirectory, { recursive: true, force: true });
fs.mkdirSync(distDirectory, { recursive: true });

// A throwaway project extending the host's, so the emit sees the same lib, jsx
// and strictness settings the components were written against. `src/types/custom.d.ts`
// is included explicitly because overriding `include` drops it, and without it
// `StatusBadgeMini`'s `import Spinner from '@app/assets/spinner.svg'` has no
// declaration.
const tsconfigPath = path.join(distDirectory, 'tsconfig.generate.json');
fs.writeFileSync(
  tsconfigPath,
  JSON.stringify(
    {
      extends: path.join(repoRoot, 'tsconfig.json'),
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        declarationMap: false,
        incremental: false,
        composite: false,
        outDir: distDirectory,
      },
      include: [
        path.join(repoRoot, ENTRY),
        path.join(repoRoot, 'src/types/custom.d.ts'),
      ],
    },
    null,
    2
  )
);

execFileSync(path.join(repoRoot, 'node_modules', '.bin', 'tsc'), [
  '--project',
  tsconfigPath,
]);

fs.rmSync(tsconfigPath, { force: true });

/** Every emitted declaration file, so the specifier rewrite can walk them. */
function declarationFiles(directory) {
  const found = [];

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      found.push(...declarationFiles(full));
    } else if (entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }

  return found;
}

/**
 * `@app/x` → `src/x`, `@server/x` → `server/x`. The emitted tree mirrors the
 * repo layout under `dist/`, so an alias maps to a path within it and the only
 * work is making that path relative to the importing file.
 */
const ALIASES = [
  ['@app/', 'src/'],
  ['@server/', 'server/'],
];

let rewritten = 0;

for (const file of declarationFiles(distDirectory)) {
  const original = fs.readFileSync(file, 'utf8');

  const updated = original.replace(
    /(from\s+|import\s*\()(['"])(@(?:app|server)\/[^'"]+)\2/g,
    (match, prefix, quote, specifier) => {
      const alias = ALIASES.find(([from]) => specifier.startsWith(from));
      if (!alias) {
        return match;
      }

      const target = path.join(
        distDirectory,
        specifier.replace(alias[0], alias[1])
      );
      let relative = path.relative(path.dirname(file), target);

      // A bare `foo/bar` would be read as a package name, so a same-directory or
      // descendant path needs the explicit `./`.
      if (!relative.startsWith('.')) {
        relative = `./${relative}`;
      }

      rewritten += 1;
      return `${prefix}${quote}${relative.split(path.sep).join('/')}${quote}`;
    }
  );

  if (updated !== original) {
    fs.writeFileSync(file, updated);
  }
}

// The barrel. Re-exported from the emitted tree rather than moved to the root, so
// the relative paths above stay valid.
fs.writeFileSync(
  path.join(distDirectory, 'index.d.ts'),
  [
    "// Generated by `pnpm build` from Seerr's own components. Do not edit.",
    "export * from './src/components/ExtensionUi';",
    "export { uiComponents as default } from './src/components/ExtensionUi';",
    '',
  ].join('\n')
);

// The runtime. Named exports cannot be generated from the global lazily in CJS
// without a getter per name, and the name list is exactly what the host declares.
//
// Read out of `uiComponents.ts` by regex rather than imported: that file is
// TypeScript, this is a plain `.mjs` run by node with no loader, and the list is a
// flat array of string literals with no computed members. If it ever stops being
// that shape this throws on the count check below rather than emitting a package
// that silently exports nothing.
const namesSource = fs.readFileSync(
  path.join(repoRoot, 'server/lib/extensions/uiComponents.ts'),
  'utf8'
);
const namesBlock = /UI_COMPONENT_NAMES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(
  namesSource
);

if (!namesBlock) {
  throw new Error(
    'could not find UI_COMPONENT_NAMES in server/lib/extensions/uiComponents.ts'
  );
}

const names = [...namesBlock[1].matchAll(/'([A-Za-z0-9_$]+)'/g)].map(
  (match) => match[1]
);

if (!names.length) {
  throw new Error('UI_COMPONENT_NAMES parsed to an empty list');
}

fs.writeFileSync(
  path.join(distDirectory, 'index.js'),
  [
    "// Generated by `pnpm build`. Reads the host's live components off the shared",
    '// global — the same object the browser import-map shim reads. Defining a',
    '// component here would give it no host CSS, which is the failure this package',
    '// exists to prevent.',
    "'use strict';",
    '',
    'function host() {',
    '  const shared = globalThis.__seerr_shared__;',
    "  const mod = shared && shared['@constructorfleet/extension-ui'];",
    '  if (!mod) {',
    '    throw new Error(',
    '      "[seerr] @constructorfleet/extension-ui was used before Seerr published its shared " +',
    '      "modules. A panel gets these through the host\'s import map; outside a " +',
    '      "Seerr page there is nothing to read."',
    '    );',
    '  }',
    '  return mod;',
    '}',
    '',
    ...names.map(
      (name) =>
        `Object.defineProperty(exports, ${JSON.stringify(name)}, { enumerable: true, get: () => host()[${JSON.stringify(name)}] });`
    ),
    'Object.defineProperty(exports, "default", { enumerable: true, get: host });',
    '',
  ].join('\n')
);

// eslint-disable-next-line no-console
console.log(
  `@constructorfleet/extension-ui: ${names.length} components, ${rewritten} alias specifiers rewritten`
);
