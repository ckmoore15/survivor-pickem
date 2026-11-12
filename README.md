# 🔥 Survivor Family Pick 'Em

A spoiler-safe scoreboard for our family Survivor pool. It's a static site on GitHub Pages and updates itself from the [Survivor Wiki](https://survivor.fandom.com/wiki/Survivor_51).

## How it updates

A GitHub Action (`.github/workflows/update.yml`) does the updating. GitHub starts scheduled jobs hours late or not at all, so the workflow doesn't rely on good timing: any run that starts on Wednesday (there are many scheduled chances, and the "Run workflow" button counts too) stays alive, waits for the East Coast airing to end, then checks the wiki every 3 minutes until results are up. A run can only live about 6 hours, so one that is about to time out starts its own replacement. Thursday and daily runs are backups. It runs `scripts/update.mjs`, which:

1. Reads the season page and episode guide from the wiki.
2. Publishes an episode only after **9:30pm Eastern** on air night (the end of the East Coast airing, set by `reveal` in `config.json`) **and** once the wiki shows who left, in both the episode guide and the castaway table. West Coast viewers stay spoiler-free because the site only moves past the episode they last marked as watched when they move the slider.
3. Between an episode airing and being published, it **writes nothing at all**, so new tribes and advantages can't leak early.
4. Downloads castaway photos, records advantage history, then commits and deploys.

To update by hand: open **Actions → Update from wiki & deploy → Run workflow**. Pressing it any time on Wednesday also works as a head start: that run waits and posts the episode when it's ready.

## Files you might edit (all on github.com, in the `data/` folder)

| File | What it's for |
|---|---|
| `picks.json` | Who drafted whom. |
| `extras.json` | Nicknames and funny notes. **Keep them spoiler-free.** |
| `config.json` | Scoring values, pot, season and wiki page. |
| `overrides.json` | Fixes for when the wiki is wrong or late (see `_help` inside). `holdBackAfter` is an emergency spoiler brake; `revealTimes` delays one episode (use it for a long finale). |
| `phases.json` | Which episode each tribe phase (swap, merge…) started. New phases are added automatically. |
| `advantages.json` | Advantage history (found / gone by episode). Kept up to date automatically; fix episode numbers here if needed. |

`season.json` is generated, so don't edit it by hand.

Committing any change re-runs the update and redeploys within a minute or two.

## Run locally

```sh
node scripts/update.mjs      # refresh data (add --force to ignore the spoiler blackout)
npx serve .                  # or any static server, then open http://localhost:3000
```

## Next season

Update `config.json` (`season`, `title`, `wikiPage`), replace `picks.json` and `extras.json`, empty the `events` list in `advantages.json` and reset `phases.json` to `{}`.
