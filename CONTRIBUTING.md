# Contributing to gsc-index-bot

Thanks for your interest in improving this project! Contributions of all sizes are welcome.

## Ground rules

- Be respectful — see the [Code of Conduct](CODE_OF_CONDUCT.md).
- Keep the tool honest about its limits: it automates the GSC UI, respects Google's daily cap, and uses no API keys. Please don't add features that hammer Google or try to evade rate limits.
- No secrets, credentials, or personal data in commits. The `.gsc-profile/`, `output/`, `config.json`, and `urls.txt` are gitignored for this reason — keep them that way.

## Getting started

```bash
git clone https://github.com/ankur8007/gsc-index-bot.git
cd gsc-index-bot
npm install
cp config.example.json config.json     # set your test property
cp urls.example.txt urls.txt           # add a couple of test URLs
npm run login                          # log in once
npm run start
```

## Making a change

1. Fork the repo and create a branch: `git checkout -b feature/short-description`.
2. Make your change. Keep the code style consistent with the existing file (plain ES modules, clear comments explaining *why*).
3. Run `npm run check` to confirm the script still parses.
4. If you touched UI-driving logic, test it against a real property in `--headed` mode and confirm a screenshot in `output/` shows the expected page.
5. Commit with a clear message and open a pull request using the PR template.

## Good first issues

- **Localization:** the selectors assume an English GSC UI. Adding locale-aware text matches (e.g. verdict strings, button labels) would help a lot.
- **Selector resilience:** GSC's DOM changes over time. More robust omnibox / Request-indexing locators are always welcome.
- **Notifications:** a hook to alert (desktop / webhook) when a run detects logout or hits quota.
- **Docs:** clearer setup guides, screenshots, or platform-specific scheduling tips.

## Reporting bugs

Open an issue using the bug report template. Include your OS, Node version, the command you ran, and — with any personal URLs removed — the relevant terminal output and the screenshot from `output/`.
