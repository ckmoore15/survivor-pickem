// Who is actually on the jury, worked out from the wiki's "finish" text.
//
// A castaway only counts as a juror when the wiki gives them a numbered seat
// ("9th Voted Out 1st Jury Member Day 15"). Just mentioning the jury is not enough:
// "Withdrew from Jury", "Removed from Jury" and the like mean they are NOT a juror
// and must not get the jury bonus. That is the Brady Booker case from Survivor 51:
// voted out as the first juror, then left the jury, so the seat went to the next boot.

const SEAT_RE = /\b(\d+)(?:st|nd|rd|th)\s+(?:jury\s+member|juror)\b/i;
const MENTION_RE = /\bjur(?:y|or)/i;
const LEFT_JURY_RE = /\b(?:withdrew|withdrawn|removed|dismissed|ejected|evacuated|quit|left|pulled|replaced|disqualified|resigned|stepped down)\s+(?:from|off)\s+(?:the\s+)?jur(?:y|or)|\b(?:left|quit)\s+(?:the\s+)?jury\b|\b(?:not|never|no longer)\b[^.]*\bjur(?:y|or)|\bjury\s+(?:seat|spot|place)\s+(?:withdrawn|removed|revoked|vacated)\b/i;

// -> { jury, seat, left, unclear }
//   jury:    true only for a seated juror
//   seat:    their jury number (1 = first juror), or null
//   left:    the text says they were on the jury and then left / were removed
//   unclear: the text mentions the jury in a way we don't recognise (treated as NOT a juror)
export function juryInfo(finish) {
  const text = finish || '';
  if (!MENTION_RE.test(text)) return { jury: false, seat: null, left: false, unclear: false };
  const left = LEFT_JURY_RE.test(text);
  const seat = text.match(SEAT_RE);
  if (seat && !left) return { jury: true, seat: Number(seat[1]), left: false, unclear: false };
  return { jury: false, seat: null, left, unclear: !left };
}

// Sanity checks on the finished castaway list. Returns a list of problems (strings);
// empty means the jury looks right. `prev` is last run's castaway list, used to spot
// someone whose jury status changed after the fact.
export function checkJury(castaways, prev = []) {
  const problems = [];
  const out = castaways.filter(c => c.exitEp != null);
  const jurors = out.filter(c => c.jury);

  for (const c of out) {
    const info = juryInfo(c.finish);
    if (info.left && c.jury)
      problems.push(`${c.name} is marked as a juror but the wiki says they left the jury ("${c.finish}"). They should not get the jury bonus.`);
    if (info.unclear)
      problems.push(`${c.name}'s finish mentions the jury but has no jury seat number ("${c.finish}"). Treated as NOT a juror; set "jury" for them in overrides.json if that's wrong.`);
    if (c.jury && !info.jury && !info.left)
      problems.push(`${c.name} is marked as a juror but their finish has no jury seat number ("${c.finish}").`);
  }

  // Seats should be 1, 2, 3... with nobody sharing or skipping one.
  const seats = jurors.map(c => ({ c, seat: juryInfo(c.finish).seat })).filter(x => x.seat != null)
    .sort((a, b) => a.seat - b.seat);
  seats.forEach((x, i) => {
    if (x.seat !== i + 1)
      problems.push(`Jury seats don't count up cleanly: ${x.c.name} is juror #${x.seat} but should be #${i + 1}. Someone may have joined or left the jury.`);
    const before = seats[i - 1];
    if (before && before.c.exitEp > x.c.exitEp)
      problems.push(`Jury order looks wrong: ${before.c.name} (juror #${before.seat}, ep ${before.c.exitEp}) left after ${x.c.name} (juror #${x.seat}, ep ${x.c.exitEp}).`);
  });

  // Nobody voted out before the first juror should be on the jury, and nobody voted
  // out after it (other than finalists and people who left the jury) should be off it.
  if (jurors.length) {
    const start = Math.min(...jurors.map(c => c.exitEp));
    for (const c of out) {
      if (c.exitEp > start && !c.jury && !c.finalist && !juryInfo(c.finish).left)
        problems.push(`${c.name} left in episode ${c.exitEp}, after the jury started (episode ${start}), but isn't a juror ("${c.finish}"). Check they shouldn't have the jury bonus.`);
    }
  }

  // Someone who was a juror last time and isn't now (or the other way round).
  const before = Object.fromEntries(prev.map(c => [c.name, c]));
  for (const c of out) {
    const p = before[c.name];
    if (p && p.exitEp != null && !!p.jury !== !!c.jury)
      problems.push(`Jury status changed for ${c.name}: was ${p.jury ? 'a juror' : 'not a juror'}, now ${c.jury ? 'a juror' : 'not a juror'} ("${c.finish}"). Scores were adjusted to match.`);
  }
  return problems;
}
