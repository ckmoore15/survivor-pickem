(() => {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, val) { try { localStorage.setItem(key, val); } catch { /* private mode */ } },
  };

  const state = { ep: 0, tab: 'scoreboard', filter: 'all' };
  let D; // loaded data

  async function load() {
    const get = f => fetch(`data/${f}`, { cache: 'no-cache' }).then(r => {
      if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
      return r.json();
    });
    const [config, season, picks, extras] = await Promise.all(
      ['config.json', 'season.json', 'picks.json', 'extras.json'].map(get));

    const owner = {};
    for (const p of picks.players) for (const name of p.picks) owner[name] = p.name;
    const byName = Object.fromEntries(season.castaways.map(c => [c.name, c]));
    for (const p of picks.players) for (const name of p.picks)
      if (!byName[name]) console.warn(`Pick "${name}" (${p.name}) not found in season data`);

    for (const c of season.castaways) {
      c.owner = owner[c.name] || null;
      c.nickname = extras[c.name]?.nickname || '';
      c.note = extras[c.name]?.note || '';
    }
    D = { config, season, picks, byName, max: season.revealedThrough, storeKey: `s${config.season}-watched` };
  }

  /* ---------- Game logic for a given "watched through" episode ---------- */

  const isOut = (c, n) => c.exitEp != null && c.exitEp <= n;

  function points(c, n) {
    const s = D.config.scoring;
    const out = isOut(c, n);
    const episodes = out ? (c.finalist ? c.exitEp : c.exitEp - 1) : n;
    let bonus = 0;
    if (out && c.jury) bonus += s.jury;
    if (out && c.finalist) bonus += s.finalTribal;
    if (out && c.winner) bonus += s.winner;
    return { episodes: episodes * s.episode, bonus, total: episodes * s.episode + bonus };
  }

  function phaseIndex(n) {
    let idx = 0;
    D.season.phases.forEach((p, i) => { if (p.start <= Math.max(n, 1)) idx = i; });
    return idx;
  }

  function tribeHistory(c, n) {
    const hist = c.tribes.slice(0, phaseIndex(n) + 1);
    return hist.filter((t, i) => t !== hist[i - 1]);
  }
  const tribeAt = (c, n) => c.tribes[Math.min(phaseIndex(n), c.tribes.length - 1)];

  const advantagesAt = (c, n) => D.season.advantages.filter(a =>
    a.castaway === c.name && a.foundEp <= n && (a.lostEp == null || a.lostEp > n));
  const pastAdvantagesAt = (c, n) => D.season.advantages.filter(a =>
    a.castaway === c.name && a.foundEp <= n && a.lostEp != null && a.lostEp <= n);

  function standings(n) {
    const rows = D.picks.players.map(p => {
      const cast = p.picks.map(name => D.byName[name]).filter(Boolean);
      const total = cast.reduce((sum, c) => sum + points(c, n).total, 0);
      const alive = cast.filter(c => !isOut(c, n)).length;
      return { ...p, cast, total, alive };
    }).sort((a, b) => b.total - a.total || b.alive - a.alive || a.name.localeCompare(b.name));
    rows.forEach((r, i) => { r.rank = i && r.total === rows[i - 1].total ? rows[i - 1].rank : i + 1; });
    return rows;
  }

  /* ---------- Small render helpers ---------- */

  const tribe = id => D.season.tribes[id] || { name: id || '?', bg: '#555', fg: 'white' };
  const tribeChip = id => {
    const t = tribe(id);
    return `<span class="chip tribe" style="background:${esc(t.bg)};color:${esc(t.fg)}">${esc(t.name)}</span>`;
  };
  function avatar(c, n, size = '') {
    const color = tribe(tribeAt(c, n)).bg;
    const style = `style="--tribe:${esc(color)}"`;
    return c.photo
      ? `<img class="av ${size}" ${style} src="${esc(c.photo)}" alt="" loading="lazy">`
      : `<span class="av ${size}" ${style}>${esc(c.displayName.slice(0, 2))}</span>`;
  }
  const ADV_ICONS = [[/idol/i, '🗿'], [/extra vote|steal a vote|block a vote/i, '🗳️'], [/knowledge/i, '🧠'],
    [/amulet/i, '📿'], [/safety/i, '🚪'], [/shot/i, '🎲'], [/.*/, '🎁']];
  const advIcon = name => ADV_ICONS.find(([re]) => re.test(name))[1];
  const advChip = a => `<span class="chip adv">${advIcon(a.name)} ${esc(a.name)}</span>`;

  function statusChip(c, n) {
    if (!isOut(c, n)) return '<span class="chip status-in">🔥 Still in</span>';
    if (c.winner) return '<span class="chip adv">👑 Sole Survivor</span>';
    return `<span class="chip status-out">${c.finalist ? '🏅' : '💨'} ${esc(c.finish || 'Out')} · Ep ${c.exitEp}</span>`;
  }

  const episode = n => D.season.episodes.find(e => e.num === n);
  const fmtDate = iso => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  };

  /* ---------- Views ---------- */

  function viewScoreboard(n) {
    const rows = standings(n);
    const exits = n ? (episode(n)?.exits || []).map(name => D.byName[name]).filter(Boolean) : [];
    const banner = n === 0
      ? `<div class="banner"><div class="kicker">Pre-season</div><h2>Every torch is lit</h2>
           <p>${D.season.castaways.length} castaways, nobody has scored yet.</p></div>`
      : `<div class="banner"><div class="kicker">Episode ${n} · The tribe has spoken</div>
           <h2>${exits.length ? exits.map(c => esc(c.displayName)).join(' & ') : 'Nobody went home'}</h2>
           <p>${exits.map(c => `${esc(c.displayName)}: ${esc(c.finish)}${c.owner ? ` (${esc(c.owner)}'s pick)` : ''}`).join(' · ')}</p></div>`;

    const leaders = rows.filter(r => r.rank === 1);
    const teams = rows.map(r => `
      <details class="card team ${r.rank === 1 && r.total > 0 ? 'leader' : ''}">
        <summary>
          <div class="rank">${r.rank === 1 && r.total > 0 ? '🏆' : r.rank}</div>
          <div>
            <div class="team-name">${esc(r.name)}</div>
            <div class="team-sub">${r.alive} of ${r.cast.length} still in${r.note ? ` · ${esc(r.note)}` : ''}</div>
          </div>
          <div class="team-total"><strong>${r.total}</strong><span>pts</span></div>
          <div class="torches">
            ${r.cast.map(c => `<span class="mini ${isOut(c, n) ? 'out' : ''}">${avatar(c, n, 'sm')}${esc(c.displayName)} <b>${points(c, n).total}</b></span>`).join('')}
          </div>
        </summary>
        <div class="team-detail">
          ${r.cast.map(c => {
            const p = points(c, n);
            return `<div class="detail-row ${isOut(c, n) ? 'is-out' : ''}">
              ${avatar(c, n)}
              <div><strong>${esc(c.displayName)}</strong> <span class="muted">${esc(c.nickname)}</span>
                <div class="chips" style="margin-top:4px">${tribeChip(tribeAt(c, n))}${statusChip(c, n)}${advantagesAt(c, n).map(advChip).join('')}</div></div>
              <div class="pts">${p.total}<small>${p.episodes} ep${p.bonus ? ` + ${p.bonus} bonus` : ''}</small></div>
            </div>`;
          }).join('')}
        </div>
      </details>`).join('');

    const cast = [...D.season.castaways].sort((a, b) =>
      points(b, n).total - points(a, n).total || isOut(a, n) - isOut(b, n) || a.displayName.localeCompare(b.displayName));
    const table = `
      <div class="card table-wrap"><table class="table">
        <thead><tr><th>Castaway</th><th>Picked by</th><th style="text-align:right">Pts</th></tr></thead>
        <tbody>${cast.map(c => `
          <tr class="${isOut(c, n) ? 'is-out' : ''}">
            <td><div class="who">${avatar(c, n)}<div><strong>${esc(c.displayName)}</strong>
              <small>${esc(tribe(tribeAt(c, n)).name)}${isOut(c, n) ? ` · out Ep ${c.exitEp}` : ''}</small></div></div></td>
            <td>${c.owner ? esc(c.owner) : '<span class="muted">Nobody</span>'}</td>
            <td class="num">${points(c, n).total}</td>
          </tr>`).join('')}
        </tbody></table></div>`;

    return `${banner}
      <h2 class="section-title">Leaderboard</h2>
      <div class="standings">${teams}</div>
      ${leaders.length > 1 && leaders[0].total > 0 ? `<p class="tie-note">🤝 ${leaders.map(l => esc(l.name)).join(' & ')} are tied. If it ends like this, the pot splits.</p>` : ''}
      <h2 class="section-title">Every castaway</h2>
      ${table}`;
  }

  function viewCastaways(n) {
    const filters = [['all', 'All'], ['in', 'Still in'], ['out', 'Out'],
      ...D.picks.players.map(p => [`p:${p.name}`, p.name])];
    const f = state.filter;
    const list = D.season.castaways.filter(c =>
      f === 'all' || (f === 'in' && !isOut(c, n)) || (f === 'out' && isOut(c, n)) || f === `p:${c.owner}`)
      .sort((a, b) => isOut(a, n) - isOut(b, n) || (b.exitEp || 0) - (a.exitEp || 0) || a.displayName.localeCompare(b.displayName));

    const cards = list.map(c => {
      const hist = tribeHistory(c, n);
      const now = advantagesAt(c, n);
      const past = pastAdvantagesAt(c, n);
      return `
      <article class="card cast ${isOut(c, n) ? 'is-out' : ''}">
        <div class="cast-head">
          ${avatar(c, n, 'lg')}
          <div>
            <h3>${esc(c.displayName)} <span class="muted" style="font-size:13px;font-weight:500">${c.displayName !== c.name.split(' ')[0] ? esc(c.name) : esc(c.name.split(' ').slice(1).join(' '))}</span></h3>
            ${c.nickname ? `<div class="cast-nick">${esc(c.nickname)}</div>` : ''}
            <div class="cast-meta">${[c.age, c.hometown, c.job].filter(Boolean).map(esc).join(' · ')}</div>
            <div class="cast-owner">${c.owner ? `Picked by <b>${esc(c.owner)}</b>` : '<span class="muted">Undrafted</span>'} · <b>${points(c, n).total}</b> pts</div>
          </div>
        </div>
        <div class="chips">${statusChip(c, n)}</div>
        <div>
          <div class="label">Tribe${hist.length > 1 ? ' history' : ''}</div>
          <div class="chips">${hist.map(tribeChip).join('<span class="arrow">→</span>')}</div>
        </div>
        ${now.length || past.length ? `<div><div class="label">Advantages</div><div class="chips">
          ${now.map(advChip).join('')}
          ${past.map(a => `<span class="chip ghost">${advIcon(a.name)} ${esc(a.name)} · gone Ep ${a.lostEp}</span>`).join('')}
        </div></div>` : ''}
        ${c.note ? `<p class="note">${esc(c.note)}</p>` : ''}
        ${c.words || c.fact ? `<details><summary>In their words</summary>
          ${c.words ? `<p><b>3 words:</b> ${esc(c.words)}</p>` : ''}
          ${c.fact ? `<p><b>You'd never know:</b> ${esc(c.fact)}</p>` : ''}
        </details>` : ''}
      </article>`;
    }).join('');

    return `<div class="filters" role="group" aria-label="Filter castaways">
        ${filters.map(([key, label]) => `<button data-filter="${esc(key)}" class="${f === key ? 'on' : ''}">${esc(label)}</button>`).join('')}
      </div>
      <div class="grid">${cards || '<p class="muted">Nobody here.</p>'}</div>`;
  }

  function viewTribes(n) {
    const active = D.season.castaways.filter(c => !isOut(c, n));
    const groups = {};
    for (const c of active) (groups[tribeAt(c, n)] ||= []).push(c);
    const order = Object.keys(D.season.tribes).filter(id => groups[id]);

    const member = c => `<div class="member">${avatar(c, n)}<b>${esc(c.displayName)}</b>
      <span>${c.owner ? esc(c.owner) : 'Undrafted'}${advantagesAt(c, n).length ? ' ' + advantagesAt(c, n).map(a => advIcon(a.name)).join('') : ''}</span></div>`;

    const cards = order.map(id => {
      const t = tribe(id);
      const members = groups[id].sort((a, b) => a.displayName.localeCompare(b.displayName));
      return `<section class="card tribe-card">
        <header style="background:${esc(t.bg)};color:${esc(t.fg)}"><h3>${esc(t.name)}</h3><span>${plural(members.length, 'castaway')}</span></header>
        <div class="tribe-members">${members.map(member).join('')}</div>
      </section>`;
    }).join('');

    const gone = D.season.castaways.filter(c => isOut(c, n)).sort((a, b) => b.exitEp - a.exitEp);
    const phases = D.season.phases.filter(p => p.start <= Math.max(n, 1));

    return `<h2 class="section-title" style="margin-top:4px">${n === 0 ? 'Starting tribes' : `Tribes after Episode ${n}`}</h2>
      <div class="tribes">${cards}</div>
      ${gone.length ? `<h2 class="section-title">Snuffed out</h2>
        <div class="card tribe-card"><div class="tribe-members">
          ${gone.map(c => `<div class="member is-out">${avatar(c, n)}<b>${esc(c.displayName)}</b><span>Ep ${c.exitEp} · ${esc(c.owner || 'Undrafted')}</span></div>`).join('')}
        </div></div>` : ''}
      <h2 class="section-title">Tribe timeline</h2>
      <div class="card"><ol class="timeline">
        ${phases.map(p => `<li><strong>${esc(p.name)}</strong> <span class="muted">· from Episode ${p.start}</span></li>`).join('')}
      </ol></div>`;
  }

  function viewRules() {
    const s = D.config.scoring;
    const kennedy = D.picks.players.find(p => p.note);
    return `<div class="card rules">
      <h3>The game</h3>
      <p>Before the season, each of us drafted Survivor castaways. Every week your castaways keep their torch lit, you score. Most points at the end of the season wins.${kennedy ? ` ${esc(kennedy.name)} ${esc(kennedy.note.toLowerCase())}, so ${esc(kennedy.name)} has ${kennedy.picks.length}.` : ''}</p>

      <h3>Scoring</h3>
      <div class="score-grid">
        <div class="score-tile"><strong>${s.episode}</strong><span>per episode survived</span></div>
        <div class="score-tile"><strong>+${s.jury}</strong><span>makes the jury</span></div>
        <div class="score-tile"><strong>+${s.finalTribal}</strong><span>makes Final Tribal</span></div>
        <div class="score-tile"><strong>+${s.winner}</strong><span>Sole Survivor</span></div>
      </div>
      <ul>
        <li>Your castaway earns a point for every episode they make it through.</li>
        <li>No point for the episode they leave in, whether that's a vote, a quit, a medevac or losing at fire.</li>
        <li>Example: 3 castaways through Episode 3 = 9 points. If one goes home in Episode 3, that's 8.</li>
        <li>Jury, Final Tribal and winner bonuses are added when it happens.</li>
      </ul>

      <h3>The prize</h3>
      <p>💰 ${esc(D.config.pot)} to the winner. A tie at the end splits the pot evenly.</p>

      <h3>No spoilers</h3>
      <ul>
        <li>Survivor airs Wednesdays at ${esc(D.config.airTimeLocal)} in every time zone. Results don't post until <b>Thursday morning</b>, after the West Coast has watched.</li>
        <li>Behind on episodes? Use the slider at the top to set the last episode you've watched. The whole site (scores, tribes, advantages, who's out) rewinds to that point.</li>
        <li>Your phone remembers where you left off, and it never jumps ahead on its own.</li>
      </ul>

      <h3>Where the data comes from</h3>
      <p>Castaways, tribes, boots and advantages update automatically from the <a href="https://survivor.fandom.com/wiki/${esc(D.config.wikiPage)}" target="_blank" rel="noopener">Survivor Wiki</a>.</p>
    </div>`;
  }

  /* ---------- Chrome: scrubber, tabs, footer, gate ---------- */

  function setEp(n, save = true) {
    state.ep = Math.max(0, Math.min(D.max, n));
    if (save) store.set(D.storeKey, String(state.ep));
    render();
  }

  function renderScrubber() {
    const n = state.ep;
    const e = episode(n);
    $('#ep-range').max = D.max;
    $('#ep-range').value = n;
    $('#ep-label').textContent = n === 0 ? 'Pre-season' : `Episode ${n}`;
    $('#ep-title').textContent = n === 0 ? 'Nothing watched yet' : e?.title ? `"${e.title}"` : '';
    $('#ep-prev').disabled = n <= 0;
    $('#ep-next').disabled = n >= D.max;
    const hidden = D.max - n;
    const box = $('#ep-hidden');
    box.hidden = hidden === 0;
    if (hidden) box.innerHTML = `${plural(hidden, 'newer episode')} hidden <button type="button" id="catch-up">Show latest</button>`;
  }

  function renderFooter() {
    const next = D.season.episodes.find(e => e.num > D.max && e.airDate);
    const updated = D.season.updatedAt ? new Date(D.season.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
    $('#foot').innerHTML = `
      ${next ? `<p>📺 <b>Next:</b> Episode ${next.num} airs ${esc(fmtDate(next.airDate))}, ${esc(D.config.airTimeLocal)} local. Scores post Thursday morning.</p>` : ''}
      <p>Data from the <a href="https://survivor.fandom.com/wiki/${esc(D.config.wikiPage)}" target="_blank" rel="noopener">Survivor Wiki</a>${updated ? ` · updated ${esc(updated)}` : ''}</p>`;
  }

  function render() {
    renderScrubber();
    document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === state.tab));
    const views = { scoreboard: viewScoreboard, castaways: viewCastaways, tribes: viewTribes, rules: viewRules };
    $('#view').innerHTML = (views[state.tab] || viewScoreboard)(state.ep);
  }

  function openGate() {
    const opts = [];
    for (let i = 0; i <= D.max; i++) {
      const e = episode(i);
      opts.push(`<button value="${i}" class="${i === D.max ? 'latest' : ''}">
        ${i === 0 ? 'None yet' : `Ep ${i}`}<small>${i === 0 ? 'pre-season' : i === D.max ? 'latest' : e?.airDate ? esc(fmtDate(e.airDate)) : ''}</small></button>`);
    }
    $('#gate-options').innerHTML = opts.join('');
    const gate = $('#gate');
    gate.addEventListener('close', () => setEp(Number(gate.returnValue || 0)), { once: true });
    gate.addEventListener('cancel', e => e.preventDefault(), { once: true });
    gate.showModal();
  }

  function bind() {
    $('#ep-range').addEventListener('input', e => setEp(Number(e.target.value)));
    $('#ep-prev').addEventListener('click', () => setEp(state.ep - 1));
    $('#ep-next').addEventListener('click', () => setEp(state.ep + 1));
    $('#ep-hidden').addEventListener('click', e => { if (e.target.id === 'catch-up') setEp(D.max); });
    $('#view').addEventListener('click', e => {
      const btn = e.target.closest('[data-filter]');
      if (btn) { state.filter = btn.dataset.filter; render(); }
    });
    window.addEventListener('hashchange', () => {
      state.tab = location.hash.slice(1) || 'scoreboard';
      render();
      window.scrollTo({ top: 0 });
    });
  }

  async function start() {
    try { await load(); }
    catch (err) {
      $('#view').innerHTML = `<p class="loading">Couldn't load the season data. Try refreshing.<br><small>${esc(err.message)}</small></p>`;
      return;
    }
    document.title = `${D.config.title} · ${D.config.subtitle}`;
    $('#title').textContent = D.config.title;
    state.tab = location.hash.slice(1) || 'scoreboard';
    bind();
    renderFooter();
    const saved = store.get(D.storeKey);
    if (saved === null) { setEp(0, false); openGate(); }
    else setEp(Number(saved), false);
  }

  start();
})();
