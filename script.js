/*
 * Complex Solutions Ladder – client side logic (Google Sheets backed)
 *
 * This script powers all pages in the static ladder app.
 * It reads ladder + matches from the Apps Script endpoint and renders:
 *  - Leaderboard
 *  - Add Match form
 *  - Matches list
 *  - Awards
 *  - Rules page interactions
 *
 * IMPORTANT:
 * - This version assumes your Apps Script is the source of truth.
 * - It now includes a DAILY movement indicator on the Leaderboard:
 *    ▲ green = moved up today
 *    ▼ red   = moved down today
 *    — grey  = no net movement today
 *
 * Movement is computed relative to a "daily baseline" snapshot stored
 * in localStorage (per device/browser) on the first load each day.
 */

// -----------------------------
// Config
// -----------------------------
(function () {
  "use strict";

  // Your deployed Apps Script web app URL
  // Must support GET returning { players, matches } and POST submitMatch
  const API_URL =
    "https://script.google.com/macros/s/AKfycbwa0KQCnpQOVmDKt1sk3MkAuKvMnT_TP1ViPZc_iJCsUAtp2zdS586FE6hLuhp_cgAl/exec";

  const STORAGE_KEYS = {
    pin: "cs_tt_league_pin",
    pending: "cs_tt_pending_matches_v1",
    lastState: "cs_tt_last_state_v1",
    dailyBaseline: "cs_tt_daily_baseline_v1",
  };

  // -----------------------------
  // Utilities
  // -----------------------------
  const $ = (sel) => document.querySelector(sel);

  function safeText(v) {
    return String(v == null ? "" : v).trim();
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function formatDate(v) {
    if (!v) return "";
    const d = new Date(v);
    if (isNaN(d)) return safeText(v);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function fetchJson(url, opts) {
    return fetch(url, opts).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
  }

  // -----------------------------
  // LocalStorage helpers
  // -----------------------------
  function loadPin() {
    try {
      return safeText(localStorage.getItem(STORAGE_KEYS.pin));
    } catch {
      return "";
    }
  }

  function savePin(pin) {
    try {
      localStorage.setItem(STORAGE_KEYS.pin, safeText(pin));
    } catch {
      // ignore
    }
  }

  function loadPendingMatches() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.pending);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function savePendingMatches(arr) {
    try {
      localStorage.setItem(STORAGE_KEYS.pending, JSON.stringify(arr || []));
    } catch {
      // ignore
    }
  }

  function saveLastState(state) {
    try {
      localStorage.setItem(STORAGE_KEYS.lastState, JSON.stringify(state));
    } catch {
      // ignore
    }
  }

  function loadLastState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.lastState);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || typeof s !== "object") return null;
      return s;
    } catch {
      return null;
    }
  }

  // -----------------------------
  // Daily movement baseline (per device)
  // -----------------------------
  function getTodayKey() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function loadDailyBaseline() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.dailyBaseline);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") return null;
      return data;
    } catch {
      return null;
    }
  }

  function saveDailyBaseline(baseline) {
    try {
      localStorage.setItem(STORAGE_KEYS.dailyBaseline, JSON.stringify(baseline));
    } catch {
      // ignore
    }
  }

  function ensureDailyBaseline(currentPlayers) {
    const today = getTodayKey();
    const existing = loadDailyBaseline();

    if (!existing || existing.date !== today) {
      const ranks = {};
      (currentPlayers || []).forEach((p) => {
        const name = safeText(p?.name);
        const rank = Number(p?.rank) || 0;
        if (name && rank) ranks[name] = rank;
      });
      saveDailyBaseline({ date: today, ranks });
    }
  }

  function computeDailyMovementMap(currentPlayers) {
    const baseline = loadDailyBaseline();
    const ranks0 = baseline?.ranks || {};
    const movement = new Map();

    (currentPlayers || []).forEach((p) => {
      const name = safeText(p?.name);
      const nowRank = Number(p?.rank) || 0;
      const baseRank = Number(ranks0[name]) || 0;

      // +delta = improved (rank number decreased)
      // base 8 -> now 6 => +2 (up 2)
      const delta = baseRank && nowRank ? baseRank - nowRank : 0;
      movement.set(name, delta);
    });

    return movement;
  }

  // -----------------------------
  // State
  // -----------------------------
  let players = [];
  let matches = [];

  // -----------------------------
  // API
  // -----------------------------
  async function loadState() {
    const state = await fetchJson(API_URL, { method: "GET" });
    if (!state || !Array.isArray(state.players) || !Array.isArray(state.matches)) {
      throw new Error("Bad API response");
    }
    players = state.players;
    matches = state.matches;
    saveLastState(state);
    return state;
  }

  async function submitMatch(match) {
    const pin = loadPin();
    const payload = {
      action: "submitMatch",
      pin: pin || undefined,
      match,
    };

    const res = await fetchJson(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });

    if (!res || res.ok !== true) {
      throw new Error(res?.error || "Submit failed");
    }

    // Update local state from server
    players = res.players || players;
    matches = res.matches || matches;
    saveLastState({ players, matches });

    return res;
  }

  // -----------------------------
  // Page routing
  // -----------------------------
  document.addEventListener("DOMContentLoaded", async () => {
    const bodyId = document.body?.id || "";

    // Always try to load from server, fallback to lastState on failure
    try {
      await loadState();
    } catch (e) {
      const cached = loadLastState();
      if (cached?.players && cached?.matches) {
        players = cached.players;
        matches = cached.matches;
        showToast("Offline mode (showing last saved data).", "warn");
      } else {
        showToast(`Failed to load: ${e.message}`, "err");
      }
    }

    if (bodyId === "index-page") initLeaderboardPage();
    else if (bodyId === "add-match-page") initAddMatchPage();
    else if (bodyId === "matches-page") initMatchesPage();
    else if (bodyId === "awards-page") initAwardsPage();
    else if (bodyId === "rules-page") initRulesPage();
  });

  // -----------------------------
  // UI helpers
  // -----------------------------
  function showToast(msg, type) {
    const host = $("#toastHost");
    if (!host) return;

    const t = document.createElement("div");
    t.className = `toast ${type || ""}`.trim();
    t.textContent = msg;

    host.appendChild(t);
    setTimeout(() => t.classList.add("show"), 10);
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 250);
    }, 3000);
  }

  // -----------------------------
  // Leaderboard page
  // -----------------------------
  function initLeaderboardPage() {
    renderLeaderboard();
    renderRecentMatches();
  }

  function renderLeaderboard() {
    const el = $("#leaderboard");
    if (!el) return;

    el.innerHTML = "";

    if (!players.length) {
      const empty = document.createElement("div");
      empty.className = "card";
      empty.textContent = "No players found. Check the Ladder sheet.";
      el.appendChild(empty);
      return;
    }

    // ✅ Daily movement baseline + map (per device/browser)
    ensureDailyBaseline(players);
    const movementMap = computeDailyMovementMap(players);

    players.forEach((p) => {
      const card = document.createElement("div");
      card.className = "card leaderboard-card";

      const top = document.createElement("div");
      top.style.display = "flex";
      top.style.justifyContent = "space-between";
      top.style.alignItems = "center";
      top.style.gap = "12px";

      const left = document.createElement("div");
      left.style.display = "flex";
      left.style.alignItems = "center";
      left.style.gap = "12px";

      const badge = document.createElement("div");
      badge.className = "rank-badge";
      badge.textContent = `#${p.rank}`;

      // ✅ Movement indicator (compared to today's baseline on this device)
      const delta = movementMap.get(p.name) || 0;
      const trend = document.createElement("span");
      trend.className = "rank-trend";

      if (delta > 0) {
        trend.textContent = `▲${delta}`;
        trend.dataset.trend = "up";
        trend.setAttribute("aria-label", `Up ${delta} today`);
        trend.title = `Up ${delta} today`;
      } else if (delta < 0) {
        trend.textContent = `▼${Math.abs(delta)}`;
        trend.dataset.trend = "down";
        trend.setAttribute("aria-label", `Down ${Math.abs(delta)} today`);
        trend.title = `Down ${Math.abs(delta)} today`;
      } else {
        trend.textContent = "—";
        trend.dataset.trend = "flat";
        trend.setAttribute("aria-label", "No movement today");
        trend.title = "No movement today";
      }

      const rankWrap = document.createElement("div");
      rankWrap.style.display = "inline-flex";
      rankWrap.style.alignItems = "center";
      rankWrap.style.gap = "8px";
      rankWrap.appendChild(badge);
      rankWrap.appendChild(trend);

      const name = document.createElement("div");
      name.className = "player-name";
      name.textContent = p.name;

      left.appendChild(rankWrap);
      left.appendChild(name);

      const right = document.createElement("div");
      right.className = "player-meta";

      const wl = document.createElement("div");
      wl.textContent = `${p.wins}W • ${p.losses}L`;

      const st = document.createElement("div");
      const s = Number(p.streak) || 0;
      st.textContent = s === 0 ? "Streak: 0" : s > 0 ? `Streak: +${s}` : `Streak: ${s}`;
      st.style.opacity = "0.85";
      st.style.fontSize = "0.85rem";

      right.appendChild(wl);
      right.appendChild(st);

      top.appendChild(left);
      top.appendChild(right);

      const bottom = document.createElement("div");
      bottom.style.marginTop = "10px";
      bottom.style.fontSize = "0.85rem";
      bottom.style.opacity = "0.8";
      bottom.textContent = p.lastPlayed ? `Last played: ${formatDate(p.lastPlayed)}` : "Last played: —";

      if (p.rank <= 3) {
        card.style.borderColor = "rgba(228,26,103,.25)";
      }

      card.appendChild(top);
      card.appendChild(bottom);
      el.appendChild(card);
    });

    injectMinimalCardStylesOnce();
  }

  function renderRecentMatches() {
    const el = $("#recentMatches");
    if (!el) return;

    el.innerHTML = "";

    const recent = [...matches]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 5);

    if (!recent.length) {
      const empty = document.createElement("div");
      empty.className = "card";
      empty.textContent = "No matches yet.";
      el.appendChild(empty);
      return;
    }

    recent.forEach((m) => {
      const card = document.createElement("div");
      card.className = "card";

      const line1 = document.createElement("div");
      line1.style.display = "flex";
      line1.style.justifyContent = "space-between";
      line1.style.gap = "10px";

      const left = document.createElement("div");
      left.innerHTML = `<strong>${safeText(m.winner)}</strong> beat ${safeText(
        m.winner === m.challenger ? m.defender : m.challenger
      )}`;

      const right = document.createElement("div");
      right.style.opacity = "0.8";
      right.style.whiteSpace = "nowrap";
      right.textContent = safeText(m.score || "");

      line1.appendChild(left);
      line1.appendChild(right);

      const line2 = document.createElement("div");
      line2.style.marginTop = "6px";
      line2.style.opacity = "0.75";
      line2.style.fontSize = "0.85rem";
      line2.textContent = formatDate(m.date);

      card.appendChild(line1);
      card.appendChild(line2);
      el.appendChild(card);
    });
  }

  // -----------------------------
  // Add Match page
  // -----------------------------
  function initAddMatchPage() {
    const challengerSel = $("#challenger");
    const defenderSel = $("#defender");
    const winnerSel = $("#winner");
    const scoreSel = $("#score");
    const pinInput = $("#pin");
    const form = $("#matchForm");
    const btn = $("#submitBtn");
    const statusEl = $("#submitStatus");

    if (!form) return;

    // populate selects
    const names = players.map((p) => p.name);
    fillSelect(challengerSel, names);
    fillSelect(defenderSel, names);
    fillSelect(winnerSel, names);

    // pin
    if (pinInput) {
      pinInput.value = loadPin();
      pinInput.addEventListener("input", () => savePin(pinInput.value));
    }

    // score options
    if (scoreSel && !scoreSel.options.length) {
      ["2-0", "2-1", "0-2", "1-2"].forEach((s) => {
        const opt = document.createElement("option");
        opt.value = s;
        opt.textContent = s;
        scoreSel.appendChild(opt);
      });
    }

    // prevent picking same person
    function syncWinnerOptions() {
      if (!challengerSel || !defenderSel || !winnerSel) return;
      const c = challengerSel.value;
      const d = defenderSel.value;

      [...winnerSel.options].forEach((o) => {
        o.disabled = o.value !== c && o.value !== d;
      });

      if (winnerSel.value !== c && winnerSel.value !== d) winnerSel.value = c || d || "";
    }

    challengerSel?.addEventListener("change", syncWinnerOptions);
    defenderSel?.addEventListener("change", syncWinnerOptions);
    syncWinnerOptions();

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();

      const challenger = safeText(challengerSel?.value);
      const defender = safeText(defenderSel?.value);
      const winner = safeText(winnerSel?.value);
      const score = safeText(scoreSel?.value);

      if (!challenger || !defender || !winner || !score) {
        showToast("Please complete all fields.", "warn");
        return;
      }
      if (challenger === defender) {
        showToast("Challenger and defender cannot be the same.", "warn");
        return;
      }

      const match = {
        date: new Date().toISOString(),
        challenger,
        defender,
        winner,
        score,
      };

      // optimistic pending queue (offline safe)
      const pending = loadPendingMatches();
      pending.push(match);
      savePendingMatches(pending);

      if (btn) btn.disabled = true;
      if (statusEl) statusEl.textContent = "Submitting…";

      try {
        // try submit
        await submitMatch(match);

        // remove from pending
        const pending2 = loadPendingMatches().filter((x) => JSON.stringify(x) !== JSON.stringify(match));
        savePendingMatches(pending2);

        showToast("Match submitted ✅", "ok");
        if (statusEl) statusEl.textContent = "Submitted ✅";

        // refresh selects + state on page
        await sleep(350);
        renderLeaderboardPreviewIfPresent();
      } catch (e) {
        showToast(`Saved locally (offline). Will retry later. (${e.message})`, "warn");
        if (statusEl) statusEl.textContent = "Saved locally (offline).";
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    // attempt resend pending on load
    retryPendingSubmissions();
  }

  function fillSelect(sel, items) {
    if (!sel) return;
    sel.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select…";
    placeholder.disabled = true;
    placeholder.selected = true;
    sel.appendChild(placeholder);

    (items || []).forEach((x) => {
      const opt = document.createElement("option");
      opt.value = x;
      opt.textContent = x;
      sel.appendChild(opt);
    });
  }

  async function retryPendingSubmissions() {
    const pending = loadPendingMatches();
    if (!pending.length) return;

    // try submit in order
    for (const m of [...pending]) {
      try {
        await submitMatch(m);
        const rest = loadPendingMatches().filter((x) => JSON.stringify(x) !== JSON.stringify(m));
        savePendingMatches(rest);
      } catch {
        // stop on first failure (likely still offline)
        break;
      }
    }
  }

  function renderLeaderboardPreviewIfPresent() {
    // If add-match page also includes leaderboard (some versions do)
    if ($("#leaderboard")) renderLeaderboard();
  }

  // -----------------------------
  // Matches page
  // -----------------------------
  function initMatchesPage() {
    const el = $("#matchesList");
    if (!el) return;

    el.innerHTML = "";

    const list = [...matches].sort((a, b) => new Date(b.date) - new Date(a.date));

    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "card";
      empty.textContent = "No matches yet.";
      el.appendChild(empty);
      return;
    }

    list.forEach((m) => {
      const card = document.createElement("div");
      card.className = "card";

      const header = document.createElement("div");
      header.style.display = "flex";
      header.style.justifyContent = "space-between";
      header.style.alignItems = "center";
      header.style.gap = "10px";

      const title = document.createElement("div");
      title.innerHTML = `<strong>${safeText(m.winner)}</strong> won`;

      const score = document.createElement("div");
      score.style.opacity = "0.85";
      score.style.whiteSpace = "nowrap";
      score.textContent = safeText(m.score || "");

      header.appendChild(title);
      header.appendChild(score);

      const detail = document.createElement("div");
      detail.style.marginTop = "8px";
      detail.style.opacity = "0.8";
      detail.style.fontSize = "0.9rem";
      detail.innerHTML = `
        <div>${safeText(m.challenger)} (challenger) vs ${safeText(m.defender)} (defender)</div>
        <div style="margin-top:6px; font-size:.85rem; opacity:.85;">${formatDate(m.date)}</div>
      `;

      card.appendChild(header);
      card.appendChild(detail);
      el.appendChild(card);
    });
  }

  // -----------------------------
  // Awards page
  // -----------------------------
  function initAwardsPage() {
    renderAwards();
  }

  function renderAwards() {
    const el = $("#awardsGrid");
    if (!el) return;

    el.innerHTML = "";

    if (!players.length) return;

    // Compute basic awards from match list + player stats
    const byName = new Map(players.map((p) => [p.name, p]));

    // Champion = rank 1
    const champ = players.find((p) => Number(p.rank) === 1);

    // Most successful challenger = most wins where winner === challenger
    const challengerWins = new Map();
    matches.forEach((m) => {
      if (m.winner && m.challenger && safeText(m.winner) === safeText(m.challenger)) {
        const k = safeText(m.challenger);
        challengerWins.set(k, (challengerWins.get(k) || 0) + 1);
      }
    });

    // Giant killer = wins vs higher ranked opponent (approx by challengeDistance >= 1)
    const giantKills = new Map();
    matches.forEach((m) => {
      const cd = Number(m.challengeDistance) || 0;
      if (cd >= 1 && safeText(m.winner) === safeText(m.challenger)) {
        const k = safeText(m.challenger);
        giantKills.set(k, (giantKills.get(k) || 0) + 1);
      }
    });

    const topChallenger = maxByMap_(challengerWins);
    const topGiant = maxByMap_(giantKills);

    const cards = [
      {
        title: "Ladder Champion",
        value: champ ? champ.name : "—",
        sub: champ ? "Rank #1" : "",
        icon: "🏆",
      },
      {
        title: "Most Successful Challenger",
        value: topChallenger?.key || "—",
        sub: topChallenger ? `${topChallenger.val} challenge wins` : "",
        icon: "⚔️",
      },
      {
        title: "Giant Killer",
        value: topGiant?.key || "—",
        sub: topGiant ? `${topGiant.val} wins vs higher ranks` : "",
        icon: "🗡️",
      },
    ];

    cards.forEach((c) => {
      const card = document.createElement("div");
      card.className = "card";

      const h = document.createElement("div");
      h.style.display = "flex";
      h.style.justifyContent = "space-between";
      h.style.alignItems = "center";

      const t = document.createElement("div");
      t.style.fontWeight = "800";
      t.textContent = c.title;

      const ic = document.createElement("div");
      ic.style.fontSize = "1.3rem";
      ic.textContent = c.icon;

      h.appendChild(t);
      h.appendChild(ic);

      const v = document.createElement("div");
      v.style.marginTop = "10px";
      v.style.fontSize = "1.2rem";
      v.style.fontWeight = "800";
      v.textContent = c.value;

      const s = document.createElement("div");
      s.style.marginTop = "6px";
      s.style.opacity = "0.8";
      s.style.fontSize = "0.9rem";
      s.textContent = c.sub;

      card.appendChild(h);
      card.appendChild(v);
      card.appendChild(s);
      el.appendChild(card);
    });
  }

  function maxByMap_(m) {
    let bestK = null;
    let bestV = -Infinity;
    for (const [k, v] of m.entries()) {
      if (v > bestV) {
        bestV = v;
        bestK = k;
      }
    }
    return bestK == null ? null : { key: bestK, val: bestV };
  }

  // -----------------------------
  // Rules page (toggle + search)
  // -----------------------------
  function initRulesPage() {
    // Page already has inline logic in rules.html in some builds.
    // This is a safe no-op placeholder.
  }

  // -----------------------------
  // Minimal styles injected for leaderboard cards
  // -----------------------------
  function injectMinimalCardStylesOnce() {
    if ($("#__cs_tt_styles__")) return;

    const s = document.createElement("style");
    s.id = "__cs_tt_styles__";
    s.textContent = `
      .leaderboard-card { padding: 14px 14px; }
      .rank-badge{
        min-width: 52px;
        text-align:center;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(255,255,255,.08);
        border: 1px solid rgba(255,255,255,.10);
        font-weight: 700;
        letter-spacing: -0.01em;
      }
      .rank-trend{
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 42px;
        padding: 6px 10px;
        border-radius: 999px;
        font-weight: 800;
        font-size: 0.85rem;
        letter-spacing: -0.01em;
        border: 1px solid rgba(255,255,255,.10);
        background: rgba(255,255,255,.06);
        opacity: 0.95;
      }
      .rank-trend[data-trend="up"]{
        color: rgba(80, 255, 170, 0.95);
        border-color: rgba(80, 255, 170, 0.25);
        background: rgba(80, 255, 170, 0.08);
      }
      .rank-trend[data-trend="down"]{
        color: rgba(255, 90, 90, 0.95);
        border-color: rgba(255, 90, 90, 0.25);
        background: rgba(255, 90, 90, 0.07);
      }
      .rank-trend[data-trend="flat"]{
        color: rgba(200, 200, 200, 0.85);
      }
      .player-name{
        font-size: 1.05rem;
        font-weight: 700;
        letter-spacing: -0.015em;
      }
      .player-meta{
        text-align: right;
        font-size: 0.95rem;
        font-weight: 600;
      }
    `;
    document.head.appendChild(s);
  }
})();
