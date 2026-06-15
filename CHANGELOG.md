# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Reshaped into a cube-platform `lib`-family element (Archetype B): bare package
  name, `cube.family`, platform `tsconfig`, `src/index.ts` as the sole public
  surface, `bun:test`, AGENTS.md capsule, hero + README. No build step (run from
  source on Bun). Dropped `tsup`/`vitest`/`prettier`/CI/lockfile tooling.

### Fixed (behavioural)
- **Parsers now throw on malformed/truncated payloads.** `openAIText` and
  `anthropicText` previously caught JSON parse errors and silently returned
  `null` (documented as a "caveat"). They now throw `SSEPayloadError` when a
  fully-framed, non-`[DONE]` payload is not valid JSON — so a truncated stream
  surfaces as an error instead of a silent empty result. In-flight partials are
  still buffered by `SSEParser` (unchanged); `[DONE]` and textless control
  events still return `null`. New exported error: `SSEPayloadError`.

## [0.2.1] - 2026-05-19

### Changed
- Expanded README with Why, Recipes, Caveats sections (no code changes).

## [0.2.0] - 2026-05-19

### Added
- Dual ESM + CJS build via `tsup` for broader Node compatibility.
- Coverage thresholds enforced in CI (80% lines/functions, 75% branches).
- `CONTRIBUTING.md`, issue templates, PR template.
- npm `sideEffects: false` for better tree-shaking.

### Changed
- Minimum Node version raised to >=20.
- Switched build pipeline from raw `tsc` emit to `tsup` (`tsc` retained for typecheck only).

## [0.1.0] - 2026-05-19

### Added
- Initial release.
