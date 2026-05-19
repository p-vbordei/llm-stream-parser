# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
