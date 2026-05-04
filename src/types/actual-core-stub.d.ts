// Stub for @actual-app/core. The package ships .ts source files (no .d.ts)
// and is referenced transitively by `@actual-app/api`'s type definitions.
// Without this stub, `tsc --noEmit` descends into upstream .ts files and
// reports unrelated errors (skipLibCheck only suppresses .d.ts checks).
// Resolved via the `paths` mapping in tsconfig.json. We don't import from
// `@actual-app/core` in src/, so resolving every subpath to `any` is safe.
declare const _stub: any
export = _stub
