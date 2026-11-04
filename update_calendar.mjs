// Updates events.json from the free weekly economic calendar feed (Forex Factory JSON export).
// Runs in GitHub Actions (see .github/workflows/update-calendar.yml), no dependencies (Node 18+).
//
//  - keeps only HIGH and MEDIUM impact events (change IMPACTS below)
//  - converts every time to UTC ("...Z"), so the countdown is right on any PC / time zone
//  - shortens the titles to the same short style as before ("US Non Farm Payrolls", "EA ECB Rate Decision" …)
//  - merges with the existing events.json: the feed only contains the current week, so events of
//    earlier runs are kept, past events (older than 2 days) are dropped.
//
// Local test:  node scripts/update_calendar.mjs [path-to-feed.json]

import fs from 'node:fs';

const FEED = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const OUT = 'events.json';
const IMPACTS = new Set(['High', 'Medium']);
const MAX_LEN = 30;                                   // longest title (without the country code)

// currency -> country code used for the flag (EUR is refined from the title, e.g. "German …" -> DE)
const CUR = { USD: 'US', EUR: 'EA', GBP: 'GB', JPY: 'JP', CAD: 'CA', AUD: 'AU', NZD: 'NZ', CHF: 'CH', CNY: 'CN' };
const EU_PREFIX = [[/^German\s+/i, 'DE'], [/^French\s+/i, 'FR'], [/^Italian\s+/i, 'IT'], [/^Spanish\s+/i, 'ES'], [/^Eurozone\s+/i, 'EA']];

// exact renames (Forex Factory title -> short title); checked first, after the country prefix is removed
const RENAME = {
  'Non-Farm Employment Change': 'Non Farm Payrolls',
  'Federal Funds Rate': 'Fed Rate Decision',
  'FOMC Statement': 'Fed Statement',
  'FOMC Press Conference': 'Fed Press Conf',
  'FOMC Economic Projections': 'FOMC Projections',
  'FOMC Meeting Minutes': 'FOMC Minutes',
  'Fed Chair Powell Speaks': 'Fed Chair Speech',
  'Fed Chair Powell Testifies': 'Fed Chair Testimony',
  'Main Refinancing Rate': 'ECB Rate Decision',
  'Monetary Policy Statement': 'Monetary Policy Statement',
  'ECB Press Conference': 'ECB Press Conf',
  'Official Bank Rate': 'BoE Rate Decision',
  'BOE Monetary Policy Report': 'BoE Policy Report',
  'MPC Official Bank Rate Votes': 'BoE Rate Votes',
  'Overnight Rate': 'BoC Rate Decision',
  'BOC Monetary Policy Report': 'BoC Policy Report',
  'BOC Press Conference': 'BoC Press Conf',
  'Cash Rate': 'RBA Rate Decision',
  'RBA Rate Statement': 'RBA Rate Statement',
  'RBA Monetary Policy Statement': 'RBA Policy Statement',
  'RBA Press Conference': 'RBA Press Conf',
  'RBA Meeting Minutes': 'RBA Meeting Minutes',
  'Official Cash Rate': 'RBNZ Rate Decision',
  'BOJ Policy Rate': 'BoJ Rate Decision',
  'Monetary Policy Assessment': 'SNB Policy Assessment',
  'SNB Policy Rate': 'SNB Rate Decision',
  'ISM Manufacturing PMI': 'ISM Manufacturing PMI',
  'ISM Services PMI': 'ISM Services PMI',
  'JOLTS Job Openings': 'JOLTs Job Openings',
  'Prelim UoM Consumer Sentiment': 'Michigan Sentiment Prel',
  'Revised UoM Consumer Sentiment': 'Michigan Sentiment',
  'Prelim UoM Inflation Expectations': 'Michigan Infl Exp Prel',
  'Average Hourly Earnings m/m': 'Avg Hourly Earnings MoM',
  'Unemployment Claims': 'Jobless Claims',
  'ADP Non-Farm Employment Change': 'ADP Employment',
  'Core PCE Price Index m/m': 'Core PCE MoM',
  'Core PCE Price Index y/y': 'Core PCE YoY',
  'Advance GDP q/q': 'GDP QoQ Adv',
  'Prelim GDP q/q': 'GDP QoQ 2nd Est',
  'Final GDP q/q': 'GDP QoQ Final',
  'Core Durable Goods Orders m/m': 'Core Durable Goods MoM',
  'Durable Goods Orders m/m': 'Durable Goods MoM',
  'Employment Change': 'Employment Change',
  'Claimant Count Change': 'Claimant Count',
  'Ivey PMI': 'Ivey PMI',
  'Trade Balance': 'Balance of Trade',
  'Tankan Manufacturing Index': 'Tankan Index',
  'Caixin Manufacturing PMI': 'RatingDog Mfg PMI',
  'Caixin Services PMI': 'RatingDog Services PMI',
  'Manufacturing PMI': 'NBS Manufacturing PMI',
  'Ifo Business Climate': 'Ifo Business Climate',
  'ZEW Economic Sentiment': 'ZEW Sentiment Index',
  'GfK Consumer Climate': 'GfK Consumer Conf',
  'Westpac Consumer Sentiment': 'Westpac Confidence',
  'NAB Business Confidence': 'NAB Business Conf',
  'Building Permits': 'Building Permits',
  'Housing Starts': 'Housing Starts',
  'Existing Home Sales': 'Existing Home Sales',
};

// generic shortening rules, applied in order when no exact rename exists
const RULES = [
  [/^(?:Fed )?Chair \S+ (?:Speaks|Testifies)$/, 'Fed Chair Speech'], [/^Fed Chair \S+ (Speaks|Testifies)$/, 'Fed Chair Speech'],
  [/^(BOE|BOJ|BOC|RBA|RBNZ|SNB|PBOC) Gov \S+ Speaks$/, (m, b) => ({ BOE: 'BoE', BOJ: 'BoJ', BOC: 'BoC', PBOC: 'PBoC' }[b] || b) + ' Gov Speech'],
  [/^ECB President \S+ Speaks$/, 'ECB President Speech'],
  [/\bm\/m\b/g, 'MoM'], [/\by\/y\b/g, 'YoY'], [/\bq\/q\b/g, 'QoQ'],
  [/^CPI\b/, 'Inflation'], [/^Core CPI\b/, 'Core Inflation'], [/^Prelim CPI\b/, 'Inflation Prel'], [/^Flash CPI\b/, 'Inflation Flash'],
  [/^Core PPI\b/, 'Core PPI'], [/^PPI\b/, 'PPI'],
  [/^Flash Manufacturing PMI$/, 'Mfg PMI Flash'], [/^Flash Services PMI$/, 'Services PMI Flash'],
  [/^Prelim (.+)$/, '$1 Prel'], [/^Flash (.+)$/, '$1 Flash'], [/^Final (.+)$/, '$1 Final'], [/^Revised (.+)$/, '$1 Rev'],
  [/\bGov\b/g, 'Gov'], [/\bSpeaks\b/g, 'Speech'], [/\bPress Conference\b/g, 'Press Conf'],
  [/\bConsumer Confidence\b/g, 'Consumer Conf'], [/\bBusiness Confidence\b/g, 'Business Conf'],
  [/\bManufacturing\b/g, 'Mfg'], [/\bEmployment\b/g, 'Employment'], [/\s{2,}/g, ' '],
];

function shorten(country, rawTitle) {
  let cc = CUR[country] || country.slice(0, 2).toUpperCase(), t = rawTitle.trim();
  if (country === 'EUR') for (const [re, c] of EU_PREFIX) if (re.test(t)) { cc = c; t = t.replace(re, ''); break; }
  if (RENAME[t]) t = RENAME[t];
  else for (const [re, rep] of RULES) t = t.replace(re, rep);
  t = t.trim();
  if (t.length > MAX_LEN) t = t.slice(0, MAX_LEN).replace(/\s+\S*$/, '');   // cut at a word boundary
  return `${cc} ${t}`;
}

async function loadFeed() {
  if (process.argv[2]) return JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  for (let i = 0; i < 3; i++) {
    const r = await fetch(FEED, { headers: { 'User-Agent': 'economic-calendar-updater (GitHub Actions)' }, cache: 'no-store' });
    const txt = await r.text();
    if (r.ok && txt.trim().startsWith('[')) return JSON.parse(txt);
    console.log(`feed not ready (HTTP ${r.status}), retry in 60 s`); await new Promise(res => setTimeout(res, 60000));
  }
  throw new Error('feed unavailable');           // workflow fails, old events.json stays untouched
}

const feed = await loadFeed();
const fresh = feed
  .filter(e => IMPACTS.has(e.impact) && e.date && e.title)
  .map(e => ({ time: new Date(e.date).toISOString().replace('.000Z', 'Z'), title: shorten(e.country, e.title), impact: e.impact }));

const t0 = Math.min(...feed.map(e => +new Date(e.date))), t1 = Math.max(...feed.map(e => +new Date(e.date)));
let old = [];
try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
const keepFrom = Date.now() - 2 * 864e5;
// events inside the feed's week are always taken from the feed (times may change); others are kept
const kept = old.filter(e => { const t = +new Date(e.time); return t >= keepFrom && (t < t0 || t > t1); });
const seen = new Set(), all = [];
for (const e of [...kept, ...fresh].sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : a.title.localeCompare(b.title))) {
  const k = e.time + '|' + e.title; if (seen.has(k)) continue; seen.add(k); all.push(e);
}
const json = JSON.stringify(all, null, 1) + '\n';
if (fs.existsSync(OUT) && fs.readFileSync(OUT, 'utf8') === json) console.log('no change');
else { fs.writeFileSync(OUT, json); console.log(`events.json: ${all.length} events (${fresh.length} from this week's feed)`); }
