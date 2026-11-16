# hyperlogger

## Files

| File                      | Purpose                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `index.js`                | Public API. Replace the module-level comment with the package's main exported class or function. |
| `lib/`                    | Internal implementation modules used by `index.js`.                                              |
| `test/basic.js`           | First brittle test file. Replace the guidance comment with real behaviour tests.                 |
| `test/all.js`             | Brittle runner that imports test files. Regenerate with `npm run test:generate`.                 |
| `test/helpers/`           | Shared test helpers such as `create`, `collect`, temporary storage, or replication setup.        |
| `examples/`               | Optional runnable examples. Do not rely on these as tests.                                       |
| `CONTRIBUTING.md`         | Checklist for keeping the package in mafintosh / Holepunch style.                                |
| `.vscode/extensions.json` | Recommends the Lunte VS Code extension for editor diagnostics.                                   |

# Testing On Node And Bare

`brittle` is the test framework. The runtime is chosen by the command you run:

```json
{
  "test": "npm run test:node && npm run test:bare",
  "test:node": "brittle-node test/all.js",
  "test:bare": "brittle-bare test/all.js"
}
```

`brittle-node` runs the same tests in Node.js. `brittle-bare` runs the same tests
in Bare, the JavaScript runtime used by Pear. Brittle itself does not magically
switch runtimes inside one process; the npm scripts invoke separate runners.

This catches cases where code accidentally relies on Node-only globals or core
modules. If a module must use runtime-specific packages, add an `imports` mapping
so Node gets the Node module and Bare gets the Bare-compatible package.

# Editor Setup

This repo includes `.vscode/extensions.json` recommending the Lunte extension:

```json
{
  "recommendations": ["holepunch.vscode-lunte"]
}
```

VS Code and Cursor can prompt contributors to install recommended extensions
when they open the folder. The extension is the VS Code client for Lunte's
language server; `npm run lint` still remains the source of truth in CI or local
terminal checks.

## Using This Template

1. Copy this directory and rename it to your package name.
2. Update `name`, `description`, `repository`, `bugs`, `homepage`, and `author` in `package.json`.
3. Replace the comment in `index.js` with the package's real public API.
4. Replace `lib/example-lib.js` with real internal modules.
5. Replace the guidance comment in `test/basic.js` with real tests.
6. Run `npm install`, then `npm test`.

## License

MIT
