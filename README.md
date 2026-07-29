# gsc-index-bot

Automate **"Request indexing"** in Google Search Console.

Google's Search Console API has **no endpoint** for the "Request indexing" button (or "Validate fix") — they are UI-only. `gsc-index-bot` drives the real, logged-in GSC web interface with [Playwright](https://playwright.dev/), so you can push URLs into Google's crawl queue on a schedule instead of clicking them one by one.

- ✅ **No API keys, no service account, no OAuth setup.** It reuses your normal browser login.
- ✅ **Ledger** records everything it submits, so it never wastes your daily quota re-requesting the same URL.
- ✅ **Self-cleaning queue** — indexed URLs drop out automatically.
- ✅ **Cross-platform** (Windows / macOS / Linux) and scriptable for daily runs.

> ⚠️ **Read this first.** Automating the logged-in Search Console UI may violate Google's Terms of Service. This is intended for **light, personal use**. Google hard-caps "Request indexing" at roughly **10–12 URLs/day per property** — the bot respects that and stops cleanly when it hits the cap. Use at your own risk. See [DISCLAIMER](#disclaimer).

---

## How it works

1. You log into Google **once** in a visible browser window; the session is saved to a local `.gsc-profile/` folder.
2. On each run, the bot opens the GSC dashboard, types each URL into the **"Inspect any URL"** box, waits for the index verdict, and clicks **Request indexing** for URLs that aren't on Google yet.
3. Every submission is written to a **ledger** (`output/index-ledger.json`). URLs already indexed are skipped; URLs requested within the cooldown window are skipped; and once a URL is confirmed indexed it's dropped from your queue file.

No data ever leaves your machine except the actions you'd take by hand in GSC.

---

## Requirements

- [Node.js](https://nodejs.org/) **18 or newer**
- A Google account that has access to the Search Console property you want to manage

---

## Install

```bash
git clone https://github.com/ankur8007/gsc-index-bot.git
cd gsc-index-bot
npm install          # installs Playwright and downloads a Chromium build
```

## Configure

Tell the bot which property to manage (pick **one**):

```bash
# Option A — config file
cp config.example.json config.json      # then edit "property"

# Option B — environment variable
export GSC_PROPERTY="sc-domain:example.com"

# Option C — command-line flag
node gsc-index-bot.mjs --property="https://example.com/" --headed
```

`property` must match GSC exactly:
- **Domain property:** `sc-domain:example.com`
- **URL-prefix property:** `https://example.com/`

Then add the URLs you want indexed:

```bash
cp urls.example.txt urls.txt            # then edit — one URL per line, # = comment
```

## First run — log in

```bash
npm run login          # same as: node gsc-index-bot.mjs --headed
```

A Chrome window opens. Sign into the Google account that owns the property, land on the Search Console dashboard, then press **Enter** in the terminal. Your login is saved to `.gsc-profile/` and reused on later runs.

## Everyday use

```bash
npm start              # request indexing for URLs in urls.txt (headless)
npm run status         # print the ledger (what's submitted vs indexed) — no browser
npm run prune          # drop indexed URLs from urls.txt — no browser
```

---

## Flags

| Flag | Description |
|------|-------------|
| `--property=<res>` | GSC property (overrides `config.json` / `GSC_PROPERTY`) |
| `--headed` | Show the browser (needed for the first login / re-login) |
| `--limit=N` | Max URLs to process this run (default `10`) |
| `--cooldown=N` | Days before a URL may be re-requested (default `14`) |
| `--urls=<file>` | URL list file (default `urls.txt`) |
| `--sitemap=<path\|url>` | Fallback source of URLs when the list file is empty |
| `--force` | Request even URLs already on Google / within cooldown |
| `--dry` | Inspect and log only — never click Request indexing |
| `--validate` | Also click "Validate fix" on Page-indexing issues (best effort) |
| `--status` | Print the ledger and exit (no browser) |
| `--prune` | Drop indexed URLs from the queue file and exit (no browser) |

---

## Run it daily

The saved login lets later runs go headless, so any scheduler works.

### Windows (Task Scheduler)

```powershell
schtasks /Create /TN "gsc-index-bot" /TR "node C:\path\to\gsc-index-bot\gsc-index-bot.mjs" /SC DAILY /ST 09:00
```

### macOS / Linux (cron)

```cron
# every day at 09:00
0 9 * * * cd /path/to/gsc-index-bot && /usr/bin/node gsc-index-bot.mjs >> output/daily.log 2>&1
```

If a scheduled run prints **"Not logged in"**, your Google session expired — run `npm run login` once to refresh it.

---

## Output

Everything lands in `output/` (gitignored):

- `run-<timestamp>.json` — full result of each run
- `index-ledger.json` — persistent record: first/last request date, times requested, indexed yes/no
- `indexed-archive.txt` — URLs dropped from the queue once indexed
- `*.png` — a screenshot per URL, for auditing

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Not logged in and running headless` | Run `npm run login` once to refresh the session. |
| `no-omnibox` | GSC UI changed or wasn't fully loaded; check the screenshot in `output/`. |
| `no-request-button` | URL may already be indexed, or the button label changed; see the screenshot. |
| `quota-exceeded` | You hit Google's daily cap. Remaining URLs run tomorrow. This is expected. |
| CAPTCHA on login | Complete it manually in the headed window, then press Enter. |

---

## FAQ

**Does this use the Search Console API?** No. The API can't request indexing. This drives the web UI.

**Do I need API keys or a service account?** No. It uses your saved browser login only.

**Will re-requesting the same URL daily help?** No — Google says it doesn't speed anything up. That's why the ledger enforces a cooldown.

**Is this safe for my account?** It automates the logged-in UI, which is against Google's ToS. Keep to the daily cap and light personal use. See the disclaimer.

---

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Good first areas: locale support for non-English GSC UI, more robust selectors, and a notification hook for logout/quota events.

## Disclaimer

This tool automates the logged-in Google Search Console interface. Automating Google's UI may violate the Google Terms of Service. It is provided for light, personal use only, with no warranty. You are solely responsible for how you use it, including respecting Google's daily request-indexing limits. See [LICENSE](LICENSE).

## License

[MIT](LICENSE)
