# 🔥 Survivor Family Pick 'Em

A spoiler-safe scoreboard for our family Survivor pool. It's a static site on GitHub Pages and updates itself from the [Survivor Wiki](https://survivor.fandom.com/wiki/Survivor_51).

## How it updates

A GitHub Action (`.github/workflows/update.yml`) runs every morning at about 7:30am ET, plus a Thursday afternoon retry. It runs `scripts/update.mjs`, which:

1. Reads the season page and episode guide from the wiki.
2. Publishes an episode only after **Thursday 11:00 UTC** (the morning after it airs) **and** once the wiki lists who left.
3. Between an episode airing and being published, it **writes nothing at all**, so new tribes and advantages can't leak early.
4. Downloads castaway photos, records advantage history, then commits and deploys.

To update by hand: open **Actions → Update from wiki & deploy → Run workflow**.

## Files you might edit (all on github.com, in the `data/` folder)

| File | What it's for |
|---|---|
| `picks.json` | Who drafted whom. |
| `extras.json` | Nicknames and funny notes. **Keep them spoiler-free.** |
| `config.json` | Scoring values, pot, season and wiki page. |
| `overrides.json` | Fixes for when the wiki is wrong or late (see `_help` inside). `holdBackAfter` is an emergency spoiler brake. |
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
