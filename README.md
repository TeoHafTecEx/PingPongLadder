# 🏓 Table Tennis Ladder v2

A fully self-hosted, single-file table tennis ladder app — no backend, no Google Sheets, no dependencies beyond a browser.

## Quick Start

1. **Host on GitHub Pages:**
   - Create a new GitHub repo
   - Drop `index.html` into the root
   - Go to Settings → Pages → Deploy from `main` branch, root (`/`)
   - Your ladder is live at `https://yourusername.github.io/your-repo`

2. **Or just open locally:**
   - Double-click `index.html` — it works straight from your file system

## Features

- **📊 Leaderboard** — ranked players with W/L, streaks, win%, last played
- **➕ Add Match** — scoreboard UI, challenge validation, instant ladder update
- **🕑 Match History** — full log with direction/movement badges, search filter
- **🏆 Awards** — auto-computed: Champion, Top Scorer, On Fire, Giant Killer, Most Active, Best Win Rate
- **📖 Rules** — full rule set with accordion sections and search
- **🔐 Admin Panel** — PIN-protected: add/remove/reorder players, edit league name, delete matches, reset data

## How Data is Stored

All data lives in the browser's `localStorage`. This means:

- ✅ **Shared device** (e.g. office tablet): everyone uses the same data
- ⚠️ **Different devices**: each browser has its own copy — use a shared device or hosted URL
- The hosted GitHub Pages URL is the recommended setup for a shared office ladder

## Admin Access

1. Go to the **Leaderboard** page and scroll to the **Admin** section
2. Enter your PIN (or leave blank to set one on first access)
3. Add players, reorder rankings, reset data

## Challenge Rules (built-in logic)

| Situation | If Challenger Wins | If Challenger Loses |
|---|---|---|
| Challenge Up (1–2 ranks above) | Swap positions | No change |
| Push-Down (1 rank below) | Defender drops one more rank | Swap positions |
| Invalid challenge | Match recorded, no movement | Match recorded, no movement |

## Customisation

Everything is in `index.html`. Key areas:

- **League name**: change in Admin panel (or edit `leagueName` in `defaultState()`)
- **Players**: add via Admin panel
- **Colors/fonts**: edit the `:root` CSS variables at the top of the `<style>` block
- **Rules text**: edit the `rules` array in `renderRules()`

## Resetting / Season Change

At the end of a season:
1. Unlock Admin
2. Use **"Reset All Matches"** to clear history and stats while keeping the current ladder order
3. Or **"Reset Everything"** to start from scratch
