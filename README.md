# 🏓 Table Tennis Ladder v2

A fully self-hosted table tennis ladder — static site on GitHub Pages, with **GitHub itself as the shared real-time database** via the GitHub Contents API.

No backend. No Google Sheets. No server. Just one `index.html` and a `data.json`.

---

## How it works

All ladder data lives in `data.json` in this repo. The app reads and writes it directly via the GitHub API using a Personal Access Token stored locally in each user's browser. Everyone hitting the same GitHub Pages URL reads from and writes to the same file — shared state, for real.

---

## One-time setup (do this once)

### 1. Create `data.json` in the repo root

```json
{"leagueName":"Complex Solutions","players":[],"matches":[],"nextMatchId":1}
```

### 2. Enable GitHub Pages

Settings → Pages → Deploy from `main` branch, root (`/`). Your app will be live at:
```
https://YOUR-ORG.github.io/YOUR-REPO
```

### 3. Each person who logs matches does this once on their device

1. Open the GitHub Pages URL
2. You'll see the setup screen — fill in:
   - **GitHub Owner/Org** — your GitHub username or org name
   - **Repository Name** — e.g. `tt-ladder`
   - **Branch** — `main` (usually)
   - **Personal Access Token** — create one at [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)

#### Token permissions (fine-grained)
- Repository access: **this repo only**
- Repository permissions: **Contents → Read and Write**

That's it. The token is stored only in that person's browser (`localStorage`). It's never sent anywhere except the GitHub API.

---

## Usage

| Page | What it does |
|---|---|
| **Ladder** | Live rankings with W/L, streaks, win%, last played |
| **Match** | Score a match, validates challenge rules, saves to GitHub |
| **History** | All matches with direction/movement badges, search |
| **Awards** | Auto-computed: Champion, Top Scorer, On Fire, Giant Killer, Best Win Rate, Most Active |
| **Rules** | Full rule set, accordion + search |
| **Admin** | PIN-protected: add/remove/reorder players, league name, reset data |

---

## Challenge rules (built into the app)

| Type | Challenger wins | Challenger loses |
|---|---|---|
| Challenge Up (1–2 ranks above) | Swap positions | No change |
| Push-Down (1 rank below you) | Defender drops one more rank | Swap |
| Invalid (too far / wrong direction) | Match recorded, no ladder movement | Same |

---

## Season reset

At end of season:
1. Unlock Admin → **Reset All Matches** (clears history, resets stats, keeps ranking order)
2. Or **Reset Everything** to start from zero

---

## Notes

- **Concurrent writes**: if two people submit a match at the exact same moment, one will get a GitHub 409 conflict. The app fetches the latest SHA before every write to minimise this. In practice it's rarely an issue in an office setting.
- **Read-only viewers** don't need a token — they can read `data.json` directly or just refresh the app (the Refresh button fetches the latest without a token... actually a token is needed for private repos; for public repos, reads are unauthenticated).
- **Private vs public repo**: works with both. For a public repo, anyone can read the data. For a private repo, only people with a token can read. Either is fine for an office ladder.
