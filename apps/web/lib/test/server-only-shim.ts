// Vitest runs outside Next's build system, which is the only place
// `server-only` and `client-only`'s real module bodies are meant to
// execute (they intentionally throw to enforce the boundary at build
// time). Vitest resolves `server-only` to this no-op instead, via
// vitest.config.ts's `resolve.alias`, so unit tests can import
// server-only modules (the DAL, Server Actions) without tripping that
// guard — the actual Next build still enforces the real boundary.
export {};
