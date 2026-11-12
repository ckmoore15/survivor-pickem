// Pulls the current season from the Survivor Fandom wiki and writes data/season.json.
//
// Spoiler safety: an episode is only "revealed" once it is past its reveal time
// (right after the East Coast airing ends, config.reveal) AND the wiki lists
// who left. West Coast viewers are protected by the "watched through" slider. While an episode has aired but isn't revealed yet, this script
// refuses to write anything, so the castaway table (tribes, advantages) can't
// leak new information early.
//
// Usage: node scripts/update.mjs [--force] [--refresh-images] [--wait=MINUTES] [--wait-only]
//
// --wait=MINUTES   If an episode airs soon (within 18 hours) or has aired but isn't
//                  revealed yet, stay alive until it is revealed, or until MINUTES
//                  run out, instead of giving up right away.
// --wait-only      Do the waiting but write nothing. The GitHub workflow uses this
//                  for its "wait" job; when time runs out while an episode is still
//                  pending it sets the output relay=true so the workflow can start
//                  its own replacement run.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { juryInfo, checkJury } from './jury.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const IMG_DIR = path.join(ROOT, 'img', 'castaways');
const API = 'https://survivor.fandom.com/api.php';
const UA = 'survivor-pickem-bot/1.0 (family pick em site)';
const FORCE = process.argv.includes('--force') || process.env.FORCE === '1';
const REFRESH_IMAGES = process.argv.includes('--refresh-images');
const WAIT_MIN = Number((process.argv.find(a => a.startsWith('--wait=')) || '').slice(7)) || 0;
const WAIT_ONLY = process.argv.includes('--wait-only');
const POLL_MS = 3 * 60_000;
const LEAD_MS = 18 * 3600_000;       // start waiting this long before the reveal
const RELAY_CAP_MS = 12 * 3600_000;  // stop handing off this long after the reveal
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// UTC timestamp for a wall-clock date + "HH:MM" in an IANA time zone (handles DST).
// Times past 24:00 roll into the next day, e.g. "25:00" = 1am the next morning.
function zonedTime(dateStr, hhmm, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(new Date(guess)).map(x => [x.type, Number(x.value)]));
  const asZone = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return guess - (asZone - guess);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = async (file, fallback) => {
  try { return JSON.parse(await fs.readFile(path.join(DATA, file), 'utf8')); }
  catch { return fallback; }
};
const writeJson = (file, obj) =>
  fs.writeFile(path.join(DATA, file), JSON.stringify(obj, null, 2) + '\n');

// Step output for the GitHub workflow (no-op when run locally).
const setOutput = async (key, value) => {
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
};

async function api(params) {
  const url = API + '?' + new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.ok) return await res.json();
      console.warn(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      console.warn(`Fetch failed (${err.message}) for ${url}`);
    }
    await sleep(2000 * attempt);
  }
  throw new Error(`Wiki API failed: ${url}`);
}

async function wikitext(page) {
  const json = await api({ action: 'parse', page, prop: 'wikitext' });
  if (!json.parse) throw new Error(`Missing wiki page: ${page}`);
  return json.parse.wikitext;
}

const expand = async text =>
  (await api({ action: 'expandtemplates', text, prop: 'wikitext' })).expandtemplates.wikitext;

// Wikitext -> plain text.
function clean(s) {
  return s
    .replace(/<ref[^>]*\/>/g, '')
    .replace(/<ref[\s\S]*?<\/ref>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\{\{(?:nowrap|yn)\|/gi, '{{')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\{\{|\}\}/g, '')
    .replace(/'{2,}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pulls {{efn|...}} / {{note|...}} footnotes (with nested templates) out of a cell,
// leaving a \0N\0 marker where note N was so it can be matched to its advantage.
function takeTemplates(s, notes) {
  let out = '';
  for (let i = 0; i < s.length;) {
    const m = s.slice(i).match(/^\{\{\s*(?:efn|note)\s*\|/i);
    if (!m) { out += s[i++]; continue; }
    let depth = 0, j = i;
    for (; j < s.length; j++) {
      if (s.startsWith('{{', j)) { depth++; j++; }
      else if (s.startsWith('}}', j)) { depth--; j++; if (depth === 0) break; }
    }
    const body = s.slice(i + m[0].length, j - 1).replace(/^\s*(?:name|group)\s*=[^|]*\|/i, '');
    out += `\u0000${notes.length}\u0000`;
    notes.push(clean(body));
    i = j + 1;
  }
  return out;
}

const slugify = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const NOT_TRIBES = new Set(['yes', 'no', 'out', 'none', 'won', 'lost', 'tba', 'tbd']);
const FINISH_RE = /voted out|quit|evacuat|eject|eliminat|sole survivor|runner|jury|juror|coin|removed|lost fire/i;

function parseCastaways(wt) {
  const section = wt.split('==Castaways==')[1].split(/\n==[^=]/)[0];
  const rows = section.split(/\n\|-/);
  const phases = rows[1].split('\n')
    .filter(l => l.startsWith('!'))
    .map(l => clean(l.slice(1).split('|').pop()))
    .filter(Boolean);

  const castaways = [];
  // Cells with rowspan="N" (e.g. the merged tribe) appear once and stretch down
  // the next N-1 rows, which omit that cell. Track them by column.
  const spans = {};
  for (const row of rows) {
    const nameMatch = row.match(/'''\[\[([^\]|]+)(?:\|[^\]]*)?\]\]'''/);
    if (!nameMatch || !row.includes('[[File:')) continue;
    const lines = row.split('\n').filter(l => l.startsWith('|') && !l.startsWith('|}'));
    const nameIdx = lines.findIndex(l => l.includes(nameMatch[0]));
    const cells = [];
    let col = 0;
    const fillSpans = () => {
      while (spans[col]?.left > 0) { spans[col].left--; cells.push(spans[col].text); col++; }
    };
    for (const raw of lines.slice(nameIdx + 1)) {
      fillSpans();
      const rs = raw.match(/rowspan\s*=\s*"?(\d+)"?\s*/i);
      const cell = rs ? raw.replace(rs[0], '') : raw;
      if (rs && Number(rs[1]) > 1) spans[col] = { text: cell, left: Number(rs[1]) - 1 };
      cells.push(cell);
      col++;
    }
    fillSpans();
    const small = row.match(/<small>\s*(\d+),\s*([^<]+?)<br\s*\/?>([\s\S]+?)<\/small>/);
    const c = {
      name: nameMatch[1].trim(),
      age: small ? Number(small[1]) : null,
      hometown: small ? clean(small[2]) : '',
      job: small ? clean(small[3]) : '',
      thumbFile: (row.match(/\[\[File:([^|\]]+)/) || [])[1] || null,
      tribes: [],
      finish: null,
      advantages: [],
    };
    for (const cell of cells) {
      // Advantages held: {{tribebox|yes|...}} (older wiki format) or {{ynbox|y|...}}.
      // Several advantages are separated by <br>; a <br> inside a link is just wrapping.
      if (/\{\{(?:tribebox\|yes|ynbox\|y)\|/i.test(cell)) {
        // Footnotes ({{efn|...}}) become notes on the advantage they follow.
        const notes = [];
        const inner = takeTemplates(cell, notes)
          .replace(/\{\{yn\|.\}\}/gi, '')
          .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g,
            (_, target, label) => (label ?? target).replace(/<br\s*\/?>/gi, ' '))
          .replace(/^.*?\{\{(?:tribebox\|yes|ynbox\|y)\|/i, '')
          .replace(/\}\}\s*$/, '');
        for (const part of inner.split(/<br\s*\/?>/i)) {
          const ids = [...part.matchAll(/\u0000(\d+)\u0000/g)].map(m => Number(m[1]));
          const name = clean(part.replace(/\u0000\d+\u0000/g, ''));
          if (!name || /^(not )?safe$/i.test(name)) continue;  // Shot in the Dark result, not an advantage
          c.advantages.push({ name, note: ids.map(i => notes[i]).join(' ') || null });
        }
        continue;
      }
      const tribe = cell.match(/\{\{tribebox\|([a-z0-9 ]+)\}\}/i);
      if (tribe && !NOT_TRIBES.has(tribe[1].toLowerCase())) {
        c.tribes.push(tribe[1].toLowerCase());
        continue;
      }
      // Footnotes ({{efn|...}}) are dropped so they don't end up inside the finish text.
      const text = clean(takeTemplates(cell.replace(/^\|[^|{[]*\|(?!\|)/, '|').slice(1), [])
        .replace(/\u0000\d+\u0000/g, ''));
      if (!/\{\{tribebox\|no/i.test(cell) && FINISH_RE.test(text)) c.finish = text;
    }
    castaways.push(c);
  }
  return { phases, castaways };
}

function parseEpisodes(guide) {
  const parts = guide.split(/\{\{Ep\|(\d+)\}\}/);
  const episodes = [];
  for (let i = 1; i < parts.length; i += 2) {
    const code = parts[i];
    const seg = parts[i + 1];
    const date = seg.match(new RegExp(`(${MONTHS.join('|')}) (\\d{1,2}), (\\d{4})`));
    const exits = [...seg.matchAll(/\{\{tribebox\|[a-z0-9 ]*\|([^{}<]+?)<br\s*\/?>\s*\(/gi)]
      .map(m => m[1].trim())
      .filter(n => !/^(tbd|tba)$/i.test(n));
    episodes.push({
      code,
      num: Number(code.slice(-2)),
      airDate: date ? `${date[3]}-${String(MONTHS.indexOf(date[1]) + 1).padStart(2, '0')}-${date[2].padStart(2, '0')}` : null,
      exits,
    });
  }
  return episodes;
}

function parseProfile(wt) {
  const profile = (wt.split('==Profile==')[1] || '').split(/\n==[^=]/)[0];
  const get = key => {
    const m = profile.match(new RegExp(`'''${key}[^']*'''([^\\n]*)`));
    return m ? clean(m[1]) : '';
  };
  let fact = get('What is something we would never know');
  if (fact.length > 240) fact = fact.slice(0, 240).replace(/[^.!?]*$/, '').trim() || fact.slice(0, 237) + '...';
  return {
    image: ((wt.match(/\|\s*image\s*=\s*([^\n|]+)/) || [])[1] || '').trim() || null,
    words: get('3 Words'),
    fact,
  };
}

async function imageUrls(files) {
  const out = {};
  for (let i = 0; i < files.length; i += 40) {
    const batch = files.slice(i, i + 40);
    const json = await api({
      action: 'query', prop: 'imageinfo', iiprop: 'url', iiurlwidth: '360',
      titles: batch.map(f => `File:${f}`).join('|'),
    });
    const norm = Object.fromEntries((json.query.normalized || []).map(n => [n.to, n.from]));
    for (const p of json.query.pages) {
      const info = p.imageinfo?.[0];
      if (info) out[(norm[p.title] || p.title).replace(/^File:/, '')] = info.thumburl || info.url;
    }
  }
  return out;
}

async function downloadImage(url, slug) {
  const ext = (url.match(/\.(jpe?g|png|webp)/i) || ['', 'jpg'])[1].toLowerCase().replace('jpeg', 'jpg');
  const rel = `img/castaways/${slug}.${ext}`;
  const dest = path.join(ROOT, rel);
  if (!REFRESH_IMAGES) {
    try { await fs.access(dest); return rel; } catch { /* download below */ }
  }
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) { console.warn(`Image failed ${res.status}: ${url}`); return null; }
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return rel;
}

function matchesName(exitName, c) {
  const e = exitName.toLowerCase();
  const n = c.name.toLowerCase();
  return n === e || n.split(' ').includes(e) || n.startsWith(e + ' ') || e.startsWith(n.split(' ')[0] + ' ');
}

// Reads the wiki and works out which episodes are safe to show.
async function fetchSeason(config, overrides) {
  console.log(`Fetching ${config.wikiPage}...`);
  const seasonWt = await wikitext(config.wikiPage);
  const guideWt = await wikitext(`Template:S${config.season}epguide`);
  const { phases, castaways } = parseCastaways(seasonWt);
  const episodes = parseEpisodes(guideWt);
  console.log(`Parsed ${castaways.length} castaways, ${episodes.length} episodes, phases: ${phases.join(' / ')}`);
  if (castaways.length < 10) throw new Error('Castaway table parse looks wrong, refusing to write.');

  const now = Date.now();
  const confirm = new Set(overrides.confirmEpisodes || []);
  const manualExitEps = new Set(Object.values(overrides.exits || {}).map(x => x.ep));
  const reveal = config.reveal || { timeZone: 'America/New_York', time: '21:30' };
  let revealedThrough = 0;
  let blackout = null;
  let upcoming = null;
  for (const ep of episodes.sort((a, b) => a.num - b.num)) {
    if (!ep.airDate) break;
    const [y, m, d] = ep.airDate.split('-').map(Number);
    ep.airStart = Date.UTC(y, m - 1, d, 22);  // 5-6pm ET, before anyone airs
    const revealOverride = (overrides.revealTimes || {})[ep.num];
    ep.revealAt = revealOverride ? Date.parse(revealOverride)
      : zonedTime(ep.airDate, reveal.time, reveal.timeZone);
    // Wiki editors update the episode guide and the castaway table separately.
    // Wait (up to 2 hours) until the table also shows who left, so we don't post
    // a half-updated episode.
    const tableReady = ep.exits.every(x => castaways.some(c => c.finish && matchesName(x, c)));
    const fromWiki = ep.exits.length > 0 && (tableReady || now >= ep.revealAt + 2 * 3600_000);
    const confirmed = fromWiki || confirm.has(ep.num) || manualExitEps.has(ep.num);
    if (now >= ep.revealAt && confirmed) { revealedThrough = ep.num; continue; }
    if (now >= ep.airStart) blackout = ep; else upcoming = ep;
    break;
  }
  if (overrides.holdBackAfter != null) revealedThrough = Math.min(revealedThrough, overrides.holdBackAfter);
  return { phases, castaways, episodes, revealedThrough, blackout, upcoming };
}

async function main() {
  const config = await readJson('config.json');
  const overrides = await readJson('overrides.json', {});
  const extras = await readJson('extras.json', {});
  const phaseStarts = await readJson('phases.json', {});
  const advLog = await readJson('advantages.json', { events: [] });

  // --wait=MINUTES: if an episode airs soon, or has aired but isn't revealed yet,
  // keep checking the wiki until it is (or time runs out) instead of giving up.
  const waitDeadline = Date.now() + WAIT_MIN * 60_000;
  let snap;
  for (;;) {
    try {
      snap = await fetchSeason(config, overrides);
    } catch (err) {
      // While waiting, one bad wiki response shouldn't end the whole run.
      if (!WAIT_MIN || Date.now() + POLL_MS > waitDeadline) throw err;
      console.warn(`${err.message}. Trying again in 3 minutes.`);
      await sleep(POLL_MS);
      continue;
    }
    const nowMs = Date.now();
    const soon = WAIT_MIN && snap.upcoming && snap.upcoming.revealAt - nowMs <= LEAD_MS ? snap.upcoming : null;
    const b = snap.blackout || soon;
    if (!b || FORCE) break;
    const msg = snap.blackout
      ? `Episode ${b.num} has aired but isn't revealed yet (reveal ${new Date(b.revealAt).toISOString()}, wiki exits: ${b.exits.join(', ') || 'none yet'}).`
      : `Episode ${b.num} airs soon (reveal ${new Date(b.revealAt).toISOString()}).`;
    const next = nowMs < b.revealAt ? b.revealAt + 30_000 : nowMs + POLL_MS;
    if (next > waitDeadline) {
      if (!WAIT_MIN) { console.log(`${msg} Not writing anything.`); return; }
      // Out of time. Use up what's left, then ask the workflow to start a
      // replacement run, unless the wiki is so late the daily run should take over.
      if (waitDeadline > nowMs) await sleep(waitDeadline - nowMs);
      const relay = Date.now() < b.revealAt + RELAY_CAP_MS;
      console.log(`${msg} Out of waiting time. ${relay ? 'Handing off to a new run.' : 'Leaving it to the next scheduled run.'}`);
      if (relay) await setOutput('relay', 'true');
      return;
    }
    console.log(`${msg} Checking again at ${new Date(next).toISOString()}.`);
    await sleep(next - nowMs);
  }
  if (WAIT_ONLY) { console.log('Nothing to wait for.'); return; }
  const { phases, castaways, episodes, revealedThrough } = snap;
  const now = Date.now();
  console.log(`Revealed through episode ${revealedThrough}`);

  // Episode titles
  const titleText = await expand(episodes.map(e => `{{Ep|${e.code}}}`).join('\n'));
  titleText.split('\n').forEach((line, i) => {
    const t = line.match(/\[\[([^\]|]+)/);
    if (episodes[i] && t) episodes[i].title = t[1];
  });

  // Tribe colors
  const tribeIds = [...new Set(castaways.flatMap(c => c.tribes))];
  const tribeText = await expand(tribeIds.map(t => `{{tribebox|${t}}}`).join('\n'));
  const tribes = {};
  tribeText.split('\n').forEach((line, i) => {
    const bg = line.match(/background:\s*(#[0-9a-f]{3,6})/i);
    const fg = line.match(/[^-]color:\s*([#a-z0-9]+)/i);
    tribes[tribeIds[i]] = {
      name: tribeIds[i].replace(/\b\w/g, ch => ch.toUpperCase()),
      bg: bg ? bg[1] : '#777',
      fg: fg ? fg[1] : 'white',
    };
  });

  // New tribe phases start at the latest revealed episode. Skip columns the wiki
  // has added but not filled in yet, so a phase isn't dated an episode early.
  phases.forEach((p, i) => {
    if (!(p in phaseStarts) && castaways.some(c => c.tribes[i]))
      phaseStarts[p] = Math.max(1, revealedThrough);
  });

  // Castaway pages: profile + portrait
  for (const c of castaways) {
    try { Object.assign(c, parseProfile(await wikitext(c.name.replace(/ /g, '_')))); }
    catch (err) { console.warn(`Profile failed for ${c.name}: ${err.message}`); }
  }
  const urls = await imageUrls([...new Set(castaways.flatMap(c => [c.image, c.thumbFile]).filter(Boolean))]);

  const out = [];
  for (const c of castaways) {
    const slug = slugify(c.name);
    const imgUrl = urls[c.image] || urls[c.thumbFile];
    const photo = imgUrl ? await downloadImage(imgUrl, slug) : null;

    // Exit episode
    let exitEp = null;
    if (c.finish) {
      const ep = episodes.find(e => e.exits.some(x => matchesName(x, c)));
      exitEp = ep ? ep.num : revealedThrough;
      if (!ep) console.warn(`Couldn't find exit episode for ${c.name} (${c.finish}); using ${exitEp}`);
    }
    const manual = overrides.exits?.[c.name];
    let finish = manual?.finish ?? c.finish;
    if (manual?.ep) exitEp = manual.ep;
    if (exitEp && exitEp > revealedThrough) { exitEp = null; finish = null; }

    out.push({
      name: c.name,
      slug,
      displayName: extras[c.name]?.displayName || c.name.split(' ')[0],
      age: c.age,
      hometown: c.hometown,
      job: c.job,
      photo,
      tribes: c.tribes,
      finish,
      exitEp,
      // Only a numbered jury seat counts; "Withdrew from Jury" etc. does not (see jury.mjs).
      jury: juryInfo(finish).jury,
      finalist: !!finish && /sole survivor|runner/i.test(finish),
      winner: !!finish && /sole survivor/i.test(finish),
      words: c.words || '',
      fact: c.fact || '',
      _advantages: c.advantages,
      ...(overrides.castaways?.[c.name] || {}),
    });
  }

  // Advantage log: open events for new advantages, close ones no longer on hand
  // Wiki notes are kept with the episode they first appeared, so the "watched
  // through" slider never shows a note written after a later episode.
  const ep = Math.max(1, revealedThrough);
  for (const c of out) {
    const held = c._advantages;
    const current = held.map(a => a.name);
    delete c._advantages;
    const open = advLog.events.filter(e => e.castaway === c.name && e.lostEp == null);
    for (const name of new Set([...current, ...open.map(e => e.name)])) {
      const have = current.filter(a => a === name).length;
      const logged = open.filter(e => e.name === name);
      for (let i = logged.length; i < have; i++)
        advLog.events.push({ castaway: c.name, name, foundEp: ep, lostEp: null });
      for (let i = have; i < logged.length; i++) logged[i].lostEp = ep;
    }
    for (const a of held.filter(h => h.note)) {
      const e = advLog.events.find(x => x.castaway === c.name && x.name === a.name && x.lostEp == null);
      const last = e?.notes?.[e.notes.length - 1];
      if (e && last?.text !== a.note) (e.notes ||= []).push({ ep, text: a.note });
    }
  }

  const season = {
    season: config.season,
    revealedThrough,
    episodes: episodes.map(e => e.num <= revealedThrough
      ? { num: e.num, title: e.title || null, airDate: e.airDate,
          exits: out.filter(c => c.exitEp === e.num).map(c => c.name) }
      : { num: e.num, airDate: e.airDate }),
    phases: phases.filter(name => phaseStarts[name] != null).map(name => ({ name, start: phaseStarts[name] })),
    tribes,
    castaways: out,
    advantages: advLog.events.filter(e => e.foundEp <= revealedThrough),
  };

  const prev = await readJson('season.json', null);
  if (prev) delete prev.updatedAt;

  // Jury guard: flag anything odd about who is (or stopped being) on the jury.
  // Shows as a warning on the workflow run in GitHub's Actions tab.
  const juryProblems = checkJury(out, prev?.castaways || []);
  for (const msg of juryProblems)
    console.warn(process.env.GITHUB_ACTIONS ? `::warning title=Jury check::${msg}` : `JURY CHECK: ${msg}`);
  if (juryProblems.length && process.env.GITHUB_STEP_SUMMARY)
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
      `### ⚠️ Jury check\n${juryProblems.map(m => `- ${m}`).join('\n')}\n`);
  if (JSON.stringify(prev) === JSON.stringify(season)) {
    console.log('No changes.');
  } else {
    await writeJson('season.json', { ...season, updatedAt: new Date(now).toISOString() });
    console.log('Wrote data/season.json');
  }
  await writeJson('phases.json', phaseStarts);
  await writeJson('advantages.json', advLog);
}

main().catch(err => { console.error(err); process.exit(1); });
