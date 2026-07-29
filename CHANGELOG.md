# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [1.0.0]

Initial public release.

### Added
- Request indexing for a list of URLs by driving the logged-in Search Console UI.
- Persistent login via a saved browser profile (no API keys / OAuth).
- Ledger that records every submission and enforces a re-request cooldown.
- Auto-skip of URLs already on Google.
- Self-cleaning queue: indexed URLs are dropped from the list and archived.
- Flags: `--headed`, `--limit`, `--cooldown`, `--urls`, `--sitemap`, `--force`,
  `--dry`, `--validate`, `--status`, `--prune`.
- Configuration via `config.json`, `GSC_PROPERTY` env var, or CLI flag.
- Per-URL screenshots and JSON run logs for auditing.
