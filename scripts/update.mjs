// Pulls the current season from the Survivor Fandom wiki and writes data/season.json.
//
// Spoiler safety: an episode is only "revealed" once it is past its reveal time
// (the morning after it airs, so the West Coast has watched) AND the wiki lists
// who left. While an episode has aired but isn't revealed yet, this script
// refuses to write anything, so the castaway table (tribes, advantages) can't
// leak new information early.
//
// Usage: node scripts/update.mjs [--force] [--refresh-images]

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const IMG_DIR = path.join(ROOT, 'img', 'castaways');
const API = 'https://survivor.fandom.com/api.php';
const UA = 'survivor-pickem-bot/1.0 (family pick em site)';
const FORCE = process.argv.includes('--force') || process.env.FORCE === '1';
const REFRESH_IMAGES = process.argv.includes('--refresh-images');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = async (file, fallback) => {
  try { return JSON.parse(await fs.readFile(path.join(DATA, file), 'utf8')); }
  catch { return fallback; }
};
const writeJson = (file, obj) =>
  fs.writeFile(path.join(DATA, file), JSON.stringify(obj, null, 2) + '\n');

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
  for (const row of rows) {
    const nameMatch = row.match(/'''\[\[([^\]|]+)(?:\|[^\]]*)?\]\]'''/);
    if (!nameMatch || !row.includes('[[File:')) continue;
    const lines = row.split('\n').filter(l => l.startsWith('|') && !l.startsWith('|}'));
    const nameIdx = lines.findIndex(l => l.includes(nameMatch[0]));
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
    for (const cell of lines.slice(nameIdx + 1)) {
      if (/\{\{tribebox\|yes\|/i.test(cell)) {
        const inner = cell
          .replace(/\{\{yn\|.\}\}/gi, '')
          .replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1')
          .replace(/^.*?\{\{tribebox\|yes\|/i, '')
          .replace(/\}\}\s*$/, '');
        c.advantages.push(...inner.split(/<br\s*\/?>/i).map(clean).filter(Boolean));
        continue;
      }
      const tribe = cell.match(/\{\{tribebox\|([a-z0-9 ]+)\}\}/i);
      if (tribe && !NOT_TRIBES.has(tribe[1].toLowerCase())) {
        c.tribes.push(tribe[1].toLowerCase());
        continue;
      }
      const text = clean(cell.replace(/^\|[^|{[]*\|(?!\|)/, '|').slice(1));
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

async function main() {
  const config = await readJson('config.json');
  const overrides = await readJson('overrides.json', {});
  const extras = await readJson('extras.json', {});
  const phaseStarts = await readJson('phases.json', {});
  const advLog = await readJson('advantages.json', { events: [] });
  const now = Date.now();

  console.log(`Fetching ${config.wikiPage}...`);
  const seasonWt = await wikitext(config.wikiPage);
  const guideWt = await wikitext(`Template:S${config.season}epguide`);
  const { phases, castaways } = parseCastaways(seasonWt);
  const episodes = parseEpisodes(guideWt);
  console.log(`Parsed ${castaways.length} castaways, ${episodes.length} episodes, phases: ${phases.join(' / ')}`);
  if (castaways.length < 10) throw new Error('Castaway table parse looks wrong, refusing to write.');

  // Which episodes are safe to show?
  const confirm = new Set(overrides.confirmEpisodes || []);
  const manualExitEps = new Set(Object.values(overrides.exits || {}).map(x => x.ep));
  let revealedThrough = 0;
  let blackout = null;
  for (const ep of episodes.sort((a, b) => a.num - b.num)) {
    if (!ep.airDate) break;
    const [y, m, d] = ep.airDate.split('-').map(Number);
    ep.airStart = Date.UTC(y, m - 1, d, 22);  // 6pm ET, before anyone airs
    ep.revealAt = Date.UTC(y, m - 1, d + 1, config.revealHourUTC);
    const confirmed = ep.exits.length > 0 || confirm.has(ep.num) || manualExitEps.has(ep.num);
    if (now >= ep.revealAt && confirmed) { revealedThrough = ep.num; continue; }
    if (now >= ep.airStart) blackout = ep;
    break;
  }
  if (overrides.holdBackAfter != null) revealedThrough = Math.min(revealedThrough, overrides.holdBackAfter);
  if (blackout && !FORCE) {
    console.log(`Episode ${blackout.num} has aired but isn't revealed yet (reveal ${new Date(blackout.revealAt).toISOString()}, wiki exits: ${blackout.exits.join(', ') || 'none yet'}). Not writing anything.`);
    return;
  }
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

  // New tribe phases start at the latest revealed episode
  for (const p of phases) if (!(p in phaseStarts)) phaseStarts[p] = Math.max(1, revealedThrough);

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
      jury: !!finish && /jury|juror/i.test(finish),
      finalist: !!finish && /sole survivor|runner/i.test(finish),
      winner: !!finish && /sole survivor/i.test(finish),
      words: c.words || '',
      fact: c.fact || '',
      _advantages: c.advantages,
      ...(overrides.castaways?.[c.name] || {}),
    });
  }

  // Advantage log: open events for new advantages, close ones no longer on hand
  for (const c of out) {
    const current = c._advantages;
    delete c._advantages;
    const open = advLog.events.filter(e => e.castaway === c.name && e.lostEp == null);
    for (const name of new Set([...current, ...open.map(e => e.name)])) {
      const have = current.filter(a => a === name).length;
      const logged = open.filter(e => e.name === name);
      for (let i = logged.length; i < have; i++)
        advLog.events.push({ castaway: c.name, name, foundEp: Math.max(1, revealedThrough), lostEp: null });
      for (let i = have; i < logged.length; i++) logged[i].lostEp = Math.max(1, revealedThrough);
    }
  }

  const season = {
    season: config.season,
    revealedThrough,
    episodes: episodes.map(e => e.num <= revealedThrough
      ? { num: e.num, title: e.title || null, airDate: e.airDate,
          exits: out.filter(c => c.exitEp === e.num).map(c => c.name) }
      : { num: e.num, airDate: e.airDate }),
    phases: phases.map(name => ({ name, start: phaseStarts[name] })),
    tribes,
    castaways: out,
    advantages: advLog.events.filter(e => e.foundEp <= revealedThrough),
  };

  const prev = await readJson('season.json', null);
  if (prev) delete prev.updatedAt;
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
