#!/usr/bin/env node
// gsc-index-bot — drives the Google Search Console web UI (logged in as you) to
// click "Request indexing" on a list of URLs, tracks what's been submitted in a
// persistent ledger, and keeps your queue clean.
//
// WHY a browser and not the API: Google's Search Console API has NO endpoint for
// "Request indexing" (or "Validate fix") — those buttons are UI-only. So this
// scripts the real UI via Playwright, reusing a saved login. Google hard-caps
// request-indexing at ~10-12 URLs/day per property; over that you get
// "Quota exceeded" and the bot stops cleanly.
//
// ⚠ Automating the logged-in GSC UI is against Google's Terms of Service. Use at
//   your own risk, for light personal use, and respect the daily cap. See README.
//
// Quick start:
//   1. npm install
//   2. Set your property (pick one):
//        - copy config.example.json -> config.json and edit "property"
//        - or:  export GSC_PROPERTY="sc-domain:example.com"
//        - or:  node gsc-index-bot.mjs --property="https://example.com/" --headed
//   3. node gsc-index-bot.mjs --headed     # first run: log in, press Enter
//   4. node gsc-index-bot.mjs              # daily headless run
//
// Property format: a Domain property "sc-domain:example.com" OR a URL-prefix
// property "https://example.com/" — exactly as it appears in Search Console.
//
// Flags:
//   --property=<res>   GSC property (overrides config.json / GSC_PROPERTY)
//   --headed           show the browser (needed for first login / re-login)
//   --limit=N          max URLs to process this run (default 10)
//   --cooldown=N       days before re-requesting a URL (default 14)
//   --urls=<file>      URL list file (default urls.txt; one per line, # = comment)
//   --sitemap=<path|url>  fallback source of URLs if the list file is empty
//   --discover         scan every URL read-only and write output/needs-indexing.txt
//                      (the pages Google is missing) — uses NO request-indexing quota
//   --force            request even URLs already "on Google" / within cooldown
//   --dry              inspect + log only, never click Request indexing
//   --validate         also click "Validate fix" on Page-indexing issues (best effort)
//   --status           print the ledger and exit (no browser)
//   --prune            drop indexed URLs from the queue file and exit (no browser)

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : def;
};
const has = (name) => args.includes(`--${name}`);

// ---- Config resolution: CLI flag > env > config.json -------------------------
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8')); }
  catch { return {}; }
}
const cfg = loadConfig();
const RESOURCE = flag('property', process.env.GSC_PROPERTY || cfg.property);
if (!RESOURCE) {
  console.error(
    'No Search Console property set.\n' +
    'Provide one of:\n' +
    '  • config.json  {"property":"sc-domain:example.com"}\n' +
    '  • env  GSC_PROPERTY="sc-domain:example.com"\n' +
    '  • flag --property="https://example.com/"\n');
  process.exit(1);
}

const headed = has('headed');
const dry = has('dry');
const force = has('force');
const doValidate = has('validate');
const discover = has('discover');
const statusOnly = has('status');
const limitPassed = args.some((a) => a.startsWith('--limit='));
const limit = Number(flag('limit', cfg.limit ?? '10')) || 10;
const cooldownDays = Number(flag('cooldown', cfg.cooldownDays ?? '14')) || 14;
const urlsFile = flag('urls', cfg.urlsFile || 'urls.txt');
const sitemapSrc = flag('sitemap', cfg.sitemap || '');

const PROFILE_DIR = path.join(process.cwd(), '.gsc-profile');
const OUT = path.join(process.cwd(), 'output');
fs.mkdirSync(OUT, { recursive: true });

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const today = () => new Date().toISOString().slice(0, 10);
const daysSince = (d) => (d ? Math.floor((Date.now() - Date.parse(d)) / 86400000) : Infinity);
// For pretty-printing: strip the property origin from URLs when it's a URL-prefix property.
const stripPrefix = RESOURCE.startsWith('http') ? RESOURCE.replace(/\/$/, '') : '';

// ---- Ledger: persistent record of what we've submitted / what's indexed -------
const LEDGER = path.join(OUT, 'index-ledger.json');
function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return {}; }
}
function saveLedger(l) { fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2)); }
const ledger = loadLedger();

function printStatus(l) {
  const rows = Object.entries(l);
  if (!rows.length) { console.log('Ledger empty — nothing submitted yet.'); return; }
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(`\n=== INDEX LEDGER (${rows.length} URLs) ===`);
  console.log(`${pad('url', 58)} ${pad('state', 10)} ${pad('last req', 11)} reqs`);
  const rank = (e) => (e.indexed ? 0 : 1);
  rows.sort((a, b) => rank(a[1]) - rank(b[1]));
  for (const [u, e] of rows) {
    const state = e.indexed ? 'INDEXED' : 'requested';
    console.log(`${pad(u.replace(stripPrefix, ''), 58)} ${pad(state, 10)} ${pad(e.lastRequested || '-', 11)} ${e.timesRequested || 0}`);
  }
  const idx = rows.filter(([, e]) => e.indexed).length;
  console.log(`\n${idx} indexed | ${rows.length - idx} awaiting crawl`);
}

// `--status`: just print the ledger and exit (no browser, no GSC calls).
if (statusOnly) { printStatus(ledger); process.exit(0); }

const waitForEnter = (msg) =>
  new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n${msg}\n`, () => { rl.close(); res(); });
  });

// ---- Build the URL list ------------------------------------------------------
const urlsPath = path.isAbsolute(urlsFile) ? urlsFile : path.join(process.cwd(), urlsFile);
async function loadUrls() {
  if (fs.existsSync(urlsPath)) {
    const lines = fs.readFileSync(urlsPath, 'utf8')
      .split(/\r?\n/).map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (lines.length) return lines;
  }
  // Optional fallback: pull <loc> URLs from a sitemap (local path or http[s] URL).
  if (sitemapSrc) {
    try {
      const xml = sitemapSrc.startsWith('http')
        ? await (await fetch(sitemapSrc)).text()
        : fs.readFileSync(sitemapSrc, 'utf8');
      return [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1].trim());
    } catch (e) {
      console.error(`Could not read sitemap "${sitemapSrc}": ${e}`);
    }
  }
  return [];
}

let urls = await loadUrls();
if (!urls.length) {
  console.error(`No URLs found. Add URLs to ${urlsFile} (one per line) or set --sitemap.`);
  process.exit(1);
}
// Full list is kept for --discover (scan everything). The normal request run is
// capped to --limit so it never blows past Google's daily request-indexing quota.
const allUrls = urls.slice();
urls = urls.slice(0, limit);

// Remove URLs the ledger marks as INDEXED from the queue file (keeps comments &
// still-pending URLs).
function pruneIndexed() {
  if (!fs.existsSync(urlsPath)) return;
  const lines = fs.readFileSync(urlsPath, 'utf8').split(/\r?\n/);
  const dropped = [];
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return true; // keep comments / blanks
    if (ledger[t] && ledger[t].indexed) { dropped.push(t); return false; }
    return true;
  });
  if (dropped.length) {
    fs.writeFileSync(urlsPath, kept.join('\n'));
    fs.appendFileSync(path.join(OUT, 'indexed-archive.txt'),
      dropped.map((u) => `${today()}  ${u}`).join('\n') + '\n');
    console.log(`\n🧹 Dropped ${dropped.length} now-indexed URL(s) from ${urlsFile} (archived to output/indexed-archive.txt):`);
    dropped.forEach((u) => console.log(`   - ${u}`));
  } else {
    console.log(`\nNothing to prune — no queued URL is marked indexed yet.`);
  }
}

// `--prune`: clean indexed URLs out of the queue and exit (no browser).
if (has('prune')) { pruneIndexed(); process.exit(0); }

const DASHBOARD = 'https://search.google.com/search-console?resource_id=' + encodeURIComponent(RESOURCE);

// ---- Launch persistent (logged-in) browser ----------------------------------
const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: !headed,
  viewport: { width: 1440, height: 950 },
  args: ['--disable-blink-features=AutomationControlled', '--lang=en-US'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.setDefaultTimeout(30000);

const log = { resource: RESOURCE, startedAt: new Date().toISOString(), dry, force, results: [] };
const save = () => fs.writeFileSync(path.join(OUT, `run-${stamp}.json`), JSON.stringify(log, null, 2));

// The GSC top "Inspect any URL in …" omnibox. Its presence also signals logged-in.
async function findOmnibox() {
  const cands = [
    page.getByRole('combobox', { name: /Inspect/i }),
    page.getByRole('textbox', { name: /Inspect/i }),
    page.locator('input[aria-label*="Inspect" i]'),
    page.locator('input[placeholder*="Inspect" i]'),
  ];
  for (const c of cands) {
    const el = c.first();
    if ((await el.count()) && (await el.isVisible().catch(() => false))) return el;
  }
  return null;
}

async function ensureLoggedIn() {
  await page.goto(DASHBOARD, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  const url = page.url();
  const box = await findOmnibox();
  const needsLogin = !box && (/accounts\.google\.com|\/signin|ServiceLogin/.test(url) ||
    (await page.locator('input[type="email"], input[type="password"]').count()) > 0 ||
    !(await findOmnibox()));
  if (needsLogin) {
    if (!headed) {
      console.log('\n⚠ Not logged in and running headless. Re-run ONCE with --headed to log in:');
      console.log('   node gsc-index-bot.mjs --headed');
      await ctx.close();
      process.exit(1);
    }
    console.log('\n⚠ Not logged into Google. In the Chrome window: sign in to the Google account');
    console.log('  that owns this Search Console property, land on the GSC dashboard,');
    await waitForEnter('  THEN press Enter here.');
  }
}

// Locate a clickable by any of several visible texts (case-insensitive).
function byText(texts) {
  const rx = new RegExp(texts.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
  return page.getByText(rx, { exact: false }).first();
}

function safe(u) {
  return u.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_').slice(0, 60);
}

// Inspect a single URL in GSC and read its index verdict — WITHOUT requesting
// indexing. Shared by both the normal run and --discover. Returns the coverage
// string ("on Google" / "not on Google" / "on Google with issues" / null) and a
// noOmnibox flag if the inspect box couldn't be found (usually a load/login issue).
async function inspectVerdict(u) {
  // Always start each URL from a CLEAN dashboard. A leftover "Indexing requested"
  // modal from a previous URL overlays and blocks the omnibox otherwise.
  await page.keyboard.press('Escape').catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await page.goto(DASHBOARD, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  // Drive the "Inspect any URL" omnibox (deep-linking the inspect route 404s).
  const box = await findOmnibox();
  if (!box) return { coverage: null, noOmnibox: true };
  await box.click();
  await box.fill('');
  await box.type(u, { delay: 15 });
  await box.press('Enter');

  // Inspection runs ("Retrieving data from Google Index…"); wait for a verdict.
  const insDeadline = Date.now() + 60000;
  let bodyText = '';
  while (Date.now() < insDeadline) {
    await page.waitForTimeout(2500);
    bodyText = await page.locator('body').innerText().catch(() => '');
    if (/URL is on Google|URL is not on Google|is on Google, but has issues/i.test(bodyText)) break;
    if (/Request indexing/i.test(bodyText)) break;
  }
  let coverage = null;
  if (/URL is on Google/i.test(bodyText)) coverage = 'on Google';
  else if (/URL is not on Google/i.test(bodyText)) coverage = 'not on Google';
  else if (/is on Google, but has issues/i.test(bodyText)) coverage = 'on Google with issues';
  return { coverage, noOmnibox: false };
}

async function requestIndex(u) {
  const rec = { url: u, ts: new Date().toISOString(), status: 'unknown', coverage: null, requested: false };
  try {
    const verdict = await inspectVerdict(u);
    if (verdict.noOmnibox) {
      rec.status = 'no-omnibox';
      await page.screenshot({ path: path.join(OUT, `${stamp}__${safe(u)}.png`) }).catch(() => {});
      return rec;
    }
    rec.coverage = verdict.coverage;

    if (rec.coverage === 'on Google' && !force) {
      rec.status = 'skipped-already-indexed';
      ledger[u] = { ...(ledger[u] || {}), indexed: true, indexedSeenAt: (ledger[u]?.indexedSeenAt || today()), lastStatus: rec.status };
      saveLedger(ledger);
      await page.screenshot({ path: path.join(OUT, `${stamp}__${safe(u)}.png`) }).catch(() => {});
      return rec;
    }
    if (dry) {
      rec.status = 'dry-run';
      await page.screenshot({ path: path.join(OUT, `${stamp}__${safe(u)}.png`) }).catch(() => {});
      return rec;
    }

    // Cooldown: don't re-request a URL we already submitted within cooldownDays —
    // Google says re-requesting doesn't speed anything up, and it wastes quota.
    const prev = ledger[u];
    if (!force && prev && daysSince(prev.lastRequested) < cooldownDays) {
      rec.status = 'skipped-cooldown';
      rec.lastRequested = prev.lastRequested;
      return rec;
    }

    // Find + click "Request indexing". It renders a beat after the verdict and is
    // a link (sometimes CSS-uppercased to "REQUEST INDEXING"), so poll a few roles.
    const findReq = async () => {
      const cands = [
        page.getByRole('button', { name: /request indexing/i }),
        page.getByRole('link', { name: /request indexing/i }),
        page.locator('[aria-label*="Request indexing" i]'),
        byText(['Request indexing']),
      ];
      for (const c of cands) {
        const el = c.first();
        if ((await el.count()) && (await el.isVisible().catch(() => false))) return el;
      }
      return null;
    };
    let reqBtn = null;
    const btnDeadline = Date.now() + 30000;
    while (Date.now() < btnDeadline) {
      reqBtn = await findReq();
      if (reqBtn) break;
      await page.waitForTimeout(2500);
    }
    if (!reqBtn) {
      rec.status = 'no-request-button';
      await page.screenshot({ path: path.join(OUT, `${stamp}__${safe(u)}_NOBTN.png`) }).catch(() => {});
      return rec;
    }
    await reqBtn.scrollIntoViewIfNeeded().catch(() => {});
    await reqBtn.click();
    rec.clickedRequest = true;

    // GSC now runs a live test ("Testing if live URL can be indexed") — up to ~2 min.
    // Then shows a success toast/dialog, or a quota message.
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(3000);
      const t = await page.locator('body').innerText().catch(() => '');
      if (/Quota exceeded|reached your daily quota|Daily quota/i.test(t)) {
        rec.status = 'quota-exceeded';
        await page.screenshot({ path: path.join(OUT, `${stamp}__${safe(u)}.png`) }).catch(() => {});
        return { ...rec, quota: true };
      }
      if (/Indexing requested|priority crawl queue|Request submitted|URL added/i.test(t)) {
        rec.status = 'requested';
        rec.requested = true;
        const prevE = ledger[u] || {};
        ledger[u] = {
          ...prevE,
          firstRequested: prevE.firstRequested || today(),
          lastRequested: today(),
          timesRequested: (prevE.timesRequested || 0) + 1,
          indexed: false,
          lastStatus: 'requested',
        };
        saveLedger(ledger);
        break;
      }
      if (/Testing if live URL|Requesting indexing/i.test(t)) continue;
    }
    if (!rec.requested && rec.status === 'unknown') rec.status = 'timeout-unconfirmed';

    // Dismiss the confirmation dialog if a "Got it" / "Close" button is present.
    const gotIt = byText(['Got it', 'GOT IT', 'Close']);
    if (await gotIt.count()) await gotIt.click().catch(() => {});
    await page.screenshot({ path: path.join(OUT, `${stamp}__${safe(u)}.png`) }).catch(() => {});
  } catch (e) {
    rec.status = 'error';
    rec.error = String(e).slice(0, 200);
    await page.screenshot({ path: path.join(OUT, `${stamp}__${safe(u)}_ERR.png`) }).catch(() => {});
  }
  return rec;
}

async function validateFixes() {
  console.log('\n→ Checking Page-indexing issues for "Validate fix" buttons…');
  await page.goto('https://search.google.com/search-console/index?resource_id=' + encodeURIComponent(RESOURCE),
    { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  const clicks = [];
  for (let i = 0; i < 3; i++) {
    const btn = byText(['Validate fix', 'Validate Fix', 'VALIDATE FIX']);
    if (await btn.count()) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(3000);
      clicks.push('clicked');
    } else break;
  }
  log.validateFix = clicks.length ? `clicked ${clicks.length}` : 'no validate-fix button visible';
  console.log('  ' + log.validateFix);
}

// ---- Discover mode -----------------------------------------------------------
// Inspect every URL (read-only, NO request-indexing) and write out just the ones
// Google is missing, so you get a ready-made "needs indexing" list without
// spending any request quota. Inspection has its own (much higher) daily limit,
// so scanning a large sitemap is fine, but very large sites may still hit it.
async function discoverMode(list) {
  console.log(`\ngsc-index-bot — DISCOVER mode`);
  console.log(`Inspecting ${list.length} URLs (read-only, no indexing requests)\n`);
  const notOnGoogle = [], withIssues = [], indexed = [], unknown = [];
  for (let i = 0; i < list.length; i++) {
    const u = list[i];
    process.stdout.write(`[${i + 1}/${list.length}] ${u}  … `);
    let coverage = null;
    try {
      ({ coverage } = await inspectVerdict(u));
    } catch (e) {
      console.log('error');
      unknown.push(u);
      continue;
    }
    if (coverage === 'on Google') {
      indexed.push(u);
      // Keep the ledger honest so a later run skips these for free.
      ledger[u] = { ...(ledger[u] || {}), indexed: true, indexedSeenAt: (ledger[u]?.indexedSeenAt || today()), lastStatus: 'discovered-indexed' };
      saveLedger(ledger);
    } else if (coverage === 'not on Google') {
      notOnGoogle.push(u);
    } else if (coverage === 'on Google with issues') {
      withIssues.push(u);
    } else {
      unknown.push(u);
    }
    console.log(coverage || 'unknown');
    await page.waitForTimeout(2000);
  }

  // Write the "needs indexing" queue: pages not on Google, plus pages with issues
  // (which usually benefit from a resubmit). This file is ready to feed back in.
  const needs = [...notOnGoogle, ...withIssues];
  const outFile = path.join(OUT, 'needs-indexing.txt');
  const header =
    `# Pages that need indexing — generated by gsc-index-bot --discover on ${today()}.\n` +
    `# ${notOnGoogle.length} not on Google, ${withIssues.length} on Google with issues.\n` +
    `# Feed these back in:  node gsc-index-bot.mjs --urls=output/needs-indexing.txt\n\n`;
  fs.writeFileSync(outFile, header + needs.join('\n') + (needs.length ? '\n' : ''));

  console.log(`\n=== DISCOVER SUMMARY (${list.length} scanned) ===`);
  console.log(`  already on Google:   ${indexed.length}`);
  console.log(`  NOT on Google:       ${notOnGoogle.length}`);
  console.log(`  on Google w/ issues: ${withIssues.length}`);
  console.log(`  unknown:             ${unknown.length}`);
  console.log(`\n  Needs-indexing list (${needs.length} URLs): ${outFile}`);
  if (needs.length) {
    console.log(`  Request indexing for them with:`);
    console.log(`    node gsc-index-bot.mjs --urls=output/needs-indexing.txt`);
  }
}

// ---- Run ---------------------------------------------------------------------
try {
  await ensureLoggedIn();

  // --discover: scan the full list (respect --limit only if the user set it),
  // write the "needs indexing" file, and exit without requesting anything.
  if (discover) {
    const scanList = limitPassed ? allUrls.slice(0, limit) : allUrls;
    await discoverMode(scanList);
    await ctx.close();
    process.exit(0);
  }

  console.log(`\ngsc-index-bot — property ${RESOURCE}`);
  console.log(`Mode: ${dry ? 'DRY (no requests)' : 'LIVE'} | limit ${limit} | ${urls.length} URLs\n`);

  for (const u of urls) {
    process.stdout.write(`• ${u}  … `);
    const rec = await requestIndex(u);
    log.results.push(rec);
    save();
    console.log(rec.status + (rec.coverage ? ` (${rec.coverage})` : ''));
    if (rec.quota) {
      console.log('\n⛔ Daily quota reached — stopping. Remaining URLs will wait for tomorrow.');
      break;
    }
    await page.waitForTimeout(4000 + Math.floor(3000 * (u.length % 5) / 5));
  }

  if (doValidate) await validateFixes();

  log.finishedAt = new Date().toISOString();
  save();

  const reqd = log.results.filter((r) => r.requested).length;
  const skipIdx = log.results.filter((r) => r.status === 'skipped-already-indexed').length;
  const skipCool = log.results.filter((r) => r.status === 'skipped-cooldown').length;
  console.log(`\n✔ Done. Requested: ${reqd} | already-indexed: ${skipIdx} | in-cooldown: ${skipCool} | total: ${log.results.length}`);
  console.log(`  Log + screenshots: ${OUT}`);
  console.log(`  Ledger: ${LEDGER}  (run "node gsc-index-bot.mjs --status" anytime)`);
  if (!dry) pruneIndexed();
  printStatus(ledger);
} finally {
  await ctx.close();
}
