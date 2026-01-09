/*
 * Complex Solutions Ladder – client side logic (Google Sheets backend, hardened)
 *
 * ✅ GitHub Pages friendly (static site)
 * ✅ Reads state from Apps Script (Google Sheets)
 * ✅ Writes matches to Apps Script (server computes allowed/swap/distance + updates ladder + stats)
 * ✅ Offline-ish: if POST fails, queues match in localStorage and lets user sync later
 * ✅ No trust in browser for rules (server is source of truth)
 *
 * Required Apps Script behavior (matches the hardened script I gave you):
 * - GET  -> { players:[{name,rank,wins,losses,streak,lastPlayed}], matches:[...] }
 * - POST -> { action:"submitMatch", match:{date,challenger,defender,winner,score}, pin? }
 *           returns { ok:true, players:[...], matches:[...] } or { ok:false, error:"..." }
 */

(() => {
  "use strict";

  // -----------------------------
  // Config
  // -----------------------------
  const GOOGLE_SCRIPT_URL =
    "https://script.google.com/macros/s/AKfycbwa0KQCnpQOVmDKt1sk3MkAuKvMnT_TP1ViPZc_iJCsUAtp2zdS586FE6hLuhp_cgAl/exec";

  const STORAGE_KEYS = {
    pin: "cs_tt_league_pin",
    pending: "cs_tt_pending_matches_v1",
    lastState: "cs_tt_last_state_v1",
  };

  // -----------------------------
  // App state
  // -----------------------------
  let players = [];
  let matches = [];

  // Rank movement indicators (vs previous known state)
  // Map<playerName, delta> where delta = oldRank - newRank (positive = moved up)
  let rankMovement = new Map();

  // -----------------------------
  // Utilities
  // -----------------------------
  function $(sel) {
    return document.querySelector(sel);
  }

  function safeText(s) {
    return (s ?? "").toString().trim();
  }

  function formatDate(d) {
    try {
      const dateObj = d instanceof Date ? d : new Date(d);
      return dateObj.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return safeText(d);
    }
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function normalizePlayer(p) {
    return {
      name: safeText(p?.name),
      rank: Number(p?.rank) || 0,
      wins: Number(p?.wins) || 0,
      losses: Number(p?.losses) || 0,
      streak: Number(p?.streak) || 0,
      lastPlayed: p?.lastPlayed ?? "",
    };
  }

  function normalizeMatch(m) {
    return {
      date: m?.date ?? "",
      challenger: safeText(m?.challenger),
      defender: safeText(m?.defender),
      winner: safeText(m?.winner),
      score: safeText(m?.score),
      allowed: !!m?.allowed,
      swap: !!m?.swap,
      challengeDistance: Number(m?.challengeDistance) || 0,
    };
  }

  function computeRankMovement(prevPlayers, nextPlayers) {
    const prev = new Map();
    (prevPlayers || []).forEach((p) => {
      const name = safeText(p?.name);
      const rank = Number(p?.rank) || 0;
      if (name) prev.set(name, rank);
    });

    const next = new Map();
    (nextPlayers || []).forEach((p) => {
      const name = safeText(p?.name);
      const rank = Number(p?.rank) || 0;
      if (name) next.set(name, rank);
    });

    const out = new Map();
    next.forEach((newRank, name) => {
      const oldRank = prev.get(name);
      if (!oldRank || !newRank) return;
      out.set(name, oldRank - newRank); // + => moved up, - => moved down
    });

    return out;
  }

  // -----------------------------
  // Toasts (replaces alert())
  // -----------------------------
  function ensureToastHost() {
    let host = $("#toast-host");
    if (host) return host;

    host = document.createElement("div");
    host.id = "toast-host";
    host.style.position = "fixed";
    host.style.right = "16px";
    host.style.bottom = "84px"; // above bottom nav
    host.style.display = "flex";
    host.style.flexDirection = "column";
    host.style.gap = "10px";
    host.style.zIndex = "9999";
    document.body.appendChild(host);
    return host;
  }

  function toast(message, type = "info", timeout = 3500) {
    const host = ensureToastHost();

    const t = document.createElement("div");
    t.className = `toast toast-${type}`;
    t.style.padding = "12px 14px";
    t.style.borderRadius = "12px";
    t.style.border = "1px solid var(--color-border, rgba(255,255,255,.12))";
    t.style.background = "rgba(0,0,0,.55)";
    t.style.backdropFilter = "blur(10px)";
    t.style.color = "rgba(255,255,255,.92)";
    t.style.maxWidth = "360px";
    t.style.boxShadow = "0 10px 30px rgba(0,0,0,.35)";
    t.style.fontSize = "0.92rem";
    t.style.lineHeight = "1.2";
    t.textContent = message;

    if (type === "success") t.style.borderColor = "rgba(0,255,150,.35)";
    if (type === "error") t.style.borderColor = "rgba(255,80,80,.45)";
    if (type === "warn") t.style.borderColor = "rgba(255,200,0,.45)";

    host.appendChild(t);

    const remove = () => {
      if (!t.isConnected) return;
      t.style.opacity = "0";
      t.style.transform = "translateY(6px)";
      t.style.transition = "opacity 180ms ease, transform 180ms ease";
      setTimeout(() => t.remove(), 220);
    };

    t.addEventListener("click", remove);
    setTimeout(remove, timeout);
  }

  // -----------------------------
  // localStorage helpers
  // -----------------------------
  function getLeaguePin() {
    return safeText(localStorage.getItem(STORAGE_KEYS.pin));
  }

  function setLeaguePin(pin) {
    const p = safeText(pin);
    if (!p) localStorage.removeItem(STORAGE_KEYS.pin);
    else localStorage.setItem(STORAGE_KEYS.pin, p);
  }

  function getPendingMatches() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.pending);
      const arr = JSON.parse(raw || "[]");
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function setPendingMatches(list) {
    localStorage.setItem(STORAGE_KEYS.pending, JSON.stringify(list || []));
  }

  function enqueuePending(match) {
    const list = getPendingMatches();
    list.push(match);
    setPendingMatches(list);
  }

  function dequeuePending() {
    const list = getPendingMatches();
    const next = list.shift();
    setPendingMatches(list);
    return next;
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
  // API
  // -----------------------------
  async function fetchState() {
    const prevPlayers = Array.isArray(players) ? players.map((p) => ({ ...p })) : [];

    const res = await fetch(GOOGLE_SCRIPT_URL, { method: "GET" });
    if (!res.ok) throw new Error(`GET failed: ${res.status}`);

    const data = await res.json();

    players = Array.isArray(data.players) ? data.players.map(normalizePlayer) : [];
    matches = Array.isArray(data.matches) ? data.matches.map(normalizeMatch) : [];

    players.sort((a, b) => a.rank - b.rank);
    matches.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Movement vs previous state
    rankMovement = computeRankMovement(prevPlayers, players);

    saveLastState({ players, matches });
  }

  async function postMatch(match) {
    const prevPlayers = Array.isArray(players) ? players.map((p) => ({ ...p })) : [];

    const pin = getLeaguePin();
    const payload = {
      action: "submitMatch",
      ...(pin ? { pin } : {}),
      match: {
        date: match.date,
        challenger: match.challenger,
        defender: match.defender,
        winner: match.winner,
        score: match.score,
      },
    };

    const res = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // Apps Script happiest with text/plain
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error(`POST failed: ${res.status}`);

    const data = await res.json();

    if (data && data.ok === false) {
      throw new Error(data.error || "Server rejected the match");
    }

    // adopt server truth
    if (data && (data.players || data.matches)) {
      players = Array.isArray(data.players) ? data.players.map(normalizePlayer) : players;
      matches = Array.isArray(data.matches) ? data.matches.map(normalizeMatch) : matches;
      players.sort((a, b) => a.rank - b.rank);
      matches.sort((a, b) => new Date(a.date) - new Date(b.date));

      // Movement vs previous state
      rankMovement = computeRankMovement(prevPlayers, players);

      saveLastState({ players, matches });
    }
  }

  // Sync any queued matches (offline or failed POST)
  async function syncPendingMatches({ max = 10 } = {}) {
    const pending = getPendingMatches();
    if (!pending.length) return { synced: 0, remaining: 0 };

    let synced = 0;
    const attempts = clamp(max, 1, 50);

    for (let i = 0; i < attempts; i++) {
      const next = getPendingMatches()[0];
      if (!next) break;

      try {
        await postMatch(next);
        dequeuePending();
        synced++;
      } catch (err) {
        // stop on first failure to avoid hammering
        throw err;
      }
    }

    return { synced, remaining: getPendingMatches().length };
  }

  // -----------------------------
  // Rendering: Leaderboard
  // -----------------------------
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

      // Movement indicator (vs previous state)
      const delta = Number(rankMovement.get(p.name) || 0);
      const move = document.createElement("div");
      move.className = `move-indicator ${delta > 0 ? "move-up" : delta < 0 ? "move-down" : "move-flat"}`;
      move.textContent = delta > 0 ? "▲" : delta < 0 ? "▼" : "—";
      move.title = delta > 0 ? `Moved up ${delta}` : delta < 0 ? `Moved down ${Math.abs(delta)}` : "No movement";

      const name = document.createElement("div");
      name.className = "player-name";
      name.textContent = p.name;

      left.appendChild(badge);
      left.appendChild(move);
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

      // Small highlight for top 3
      if (p.rank <= 3) {
        card.style.borderColor = "rgba(228,26,103,.25)";
      }

      card.appendChild(top);
      card.appendChild(bottom);
      el.appendChild(card);
    });

    injectMinimalCardStylesOnce();
  }

  function injectMinimalCardStylesOnce() {
    if ($("#__cs_tt_styles")) return;

    const s = document.createElement("style");
    s.id = "__cs_tt_styles";
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

      .move-indicator{
        width: 28px;
        height: 28px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,.12);
        background: rgba(255,255,255,.06);
        font-weight: 900;
        font-size: 0.95rem;
        line-height: 1;
        user-select: none;
      }
      .move-up{ color: rgba(0,255,160,.95); border-color: rgba(0,255,160,.25); background: rgba(0,255,160,.10); }
      .move-down{ color: rgba(255,90,90,.95); border-color: rgba(255,90,90,.25); background: rgba(255,90,90,.10); }
      .move-flat{ color: rgba(255,255,255,.55); border-color: rgba(255,255,255,.14); background: rgba(255,255,255,.06); }
    `;
    document.head.appendChild(s);
  }

  // -----------------------------
  // Rendering: Matches page
  // -----------------------------
  function renderMatches() {
    const container = $("#matchesList");
    if (!container) return;

    container.innerHTML = "";

    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "card";
      empty.textContent = "No matches logged yet.";
      container.appendChild(empty);
      return;
    }

    const sorted = [...matches].sort((a, b) => new Date(b.date) - new Date(a.date));

    sorted.forEach((m) => {
      const card = document.createElement("div");
      card.className = "card";

      const title = document.createElement("div");
      title.style.fontWeight = "800";
      title.style.letterSpacing = "-0.01em";
      title.style.marginBottom = "6px";
      title.textContent = `${m.challenger} vs ${m.defender}`;

      const detail = document.createElement("div");
      detail.style.fontSize = "0.92rem";
      detail.style.opacity = "0.85";
      detail.textContent = `${formatDate(m.date)} • ${m.winner} wins ${m.score || ""}`.trim();

      const tags = document.createElement("div");
      tags.style.marginTop = "10px";
      tags.style.fontSize = "0.78rem";
      tags.style.opacity = "0.8";

      const parts = [];
      if (!m.allowed) parts.push("Invalid challenge");
      if (m.allowed && m.winner === m.challenger) parts.push(m.challengeDistance >= 2 ? "Giant killer" : "Challenge win");
      if (m.allowed && m.winner === m.defender) parts.push("Defended");
      if (m.swap) parts.push("Swap");
      tags.textContent = parts.join(" • ");

      card.appendChild(title);
      card.appendChild(detail);
      if (tags.textContent) card.appendChild(tags);

      container.appendChild(card);
    });
  }

  // -----------------------------
  // Awards (simple + useful)
  // -----------------------------
  function computeAwards(playersList, matchList) {
    const awards = [];

    // Most wins
    let topWins = null;
    for (const p of playersList) {
      if (!topWins || p.wins > topWins.wins) topWins = p;
    }
    if (topWins) awards.push({ title: "Most Wins", value: `${topWins.name} (${topWins.wins})` });

    // Best streak
    let bestStreak = null;
    for (const p of playersList) {
      if (!bestStreak || (p.streak || 0) > (bestStreak.streak || 0)) bestStreak = p;
    }
    if (bestStreak) awards.push({ title: "Best Streak", value: `${bestStreak.name} (${bestStreak.streak || 0})` });

    // Giant killers (challengeDistance >=2 and challenger wins)
    const giantKillers = matchList.filter((m) => m.allowed && m.winner === m.challenger && (m.challengeDistance || 0) >= 2);
    if (giantKillers.length) {
      awards.push({ title: "Giant Killers", value: `${giantKillers.length} total` });
    }

    // Most active (played count)
    const counts = {};
    matchList.forEach((m) => {
      counts[m.challenger] = (counts[m.challenger] || 0) + 1;
      counts[m.defender] = (counts[m.defender] || 0) + 1;
    });
    let mostActive = null;
    Object.entries(counts).forEach(([name, c]) => {
      if (!mostActive || c > mostActive.count) mostActive = { name, count: c };
    });
    if (mostActive) awards.push({ title: "Most Active", value: `${mostActive.name} (${mostActive.count} matches)` });

    return awards;
  }

  function renderAwards() {
    const container = $("#awardsContainer");
    if (!container) return;

    container.innerHTML = "";

    const awards = computeAwards(players, matches);

    if (!awards.length) {
      const empty = document.createElement("div");
      empty.className = "card";
      empty.textContent = "No awards yet — log some matches.";
      container.appendChild(empty);
      return;
    }

    awards.forEach((a) => {
      const card = document.createElement("div");
      card.className = "card";

      const t = document.createElement("div");
      t.style.fontWeight = "800";
      t.style.marginBottom = "8px";
      t.textContent = a.title;

      const v = document.createElement("div");
      v.style.fontSize = "0.98rem";
      v.style.opacity = "0.9";
      v.textContent = a.value;

      card.appendChild(t);
      card.appendChild(v);
      container.appendChild(card);
    });
  }

  // -----------------------------
  // Add Match page logic
  // -----------------------------
  function getPlayerByName(name) {
    const n = safeText(name);
    return players.find((p) => p.name === n) || null;
  }

  function getLastOpponent(playerName) {
    const n = safeText(playerName);
    if (!n || !matches.length) return null;

    const sorted = [...matches].sort((a, b) => new Date(b.date) - new Date(a.date));
    for (const m of sorted) {
      if (m.challenger === n) return m.defender;
      if (m.defender === n) return m.challenger;
    }
    return null;
  }

  // Rules implemented client-side (server still validates):
  // - Challenge up: up to 2 ranks above (rank-1, rank-2)
  // - Push-down challenge: 1 rank below (rank+1)
  // - No back-to-back repeats: exclude your last opponent
  function getAllowedDefendersForChallenger(challengerName) {
    const p = getPlayerByName(challengerName);
    if (!p || !p.rank) return players.map((x) => x.name).filter((n) => n && n !== challengerName);

    const maxRank = players.length;
    const r = p.rank;

    const allowedRanks = new Set([
      r - 1,
      r - 2,
      r + 1,
    ].filter((x) => x >= 1 && x <= maxRank && x !== r));

    const allowed = players
      .filter((x) => allowedRanks.has(x.rank))
      .sort((a, b) => a.rank - b.rank)
      .map((x) => x.name);

    const lastOpp = getLastOpponent(challengerName);
    const filtered = lastOpp ? allowed.filter((n) => n !== lastOpp) : allowed;

    return filtered;
  }

  function rebuildDefenderOptions({ challengerSelect, defenderSelect }) {
    const challenger = safeText(challengerSelect?.value);
    const currentDefender = safeText(defenderSelect?.value);

    const allowed = getAllowedDefendersForChallenger(challenger);
    defenderSelect.innerHTML = "";

    allowed.forEach((name) => {
      const pl = getPlayerByName(name);
      const label = pl?.rank ? `#${pl.rank} — ${name}` : name;
      const o = document.createElement("option");
      o.value = name;
      o.textContent = label;
      defenderSelect.appendChild(o);
    });

    // Keep selection if still allowed, otherwise pick first
    if (allowed.includes(currentDefender)) defenderSelect.value = currentDefender;
    else defenderSelect.value = allowed[0] || "";

    // If nothing allowed (edge case: 1 player / bad state), disable
    defenderSelect.disabled = allowed.length === 0;
  }

  function populateSelects() {
    const challengerSelect = $("#challengerSelect");
    const defenderSelect = $("#defenderSelect");
    if (!challengerSelect || !defenderSelect) return;

    challengerSelect.innerHTML = "";
    defenderSelect.innerHTML = "";

    players.forEach((p) => {
      const o1 = document.createElement("option");
      o1.value = p.name;
      o1.textContent = p.rank ? `#${p.rank} — ${p.name}` : p.name;
      challengerSelect.appendChild(o1);
    });

    // Default challenger: rank 2 (else rank 1)
    if (players.length >= 2) challengerSelect.value = players[1].name;
    else if (players.length === 1) challengerSelect.value = players[0].name;

    // Build defender options according to the rules
    rebuildDefenderOptions({ challengerSelect, defenderSelect });
  }

  function ensureSyncAndPinUI() {
    // Add a small utility bar on Add Match page and Matches page
    const pageId = document.body?.id || "";

    const container = document.querySelector("main.container");
    if (!container) return;

    // Avoid duplicating
    if ($("#utilityBar")) return;

    const bar = document.createElement("div");
    bar.id = "utilityBar";
    bar.className = "card";
    bar.style.padding = "12px 14px";
    bar.style.display = "flex";
    bar.style.flexWrap = "wrap";
    bar.style.gap = "10px";
    bar.style.alignItems = "center";
    bar.style.justifyContent = "space-between";

    const left = document.createElement("div");
    left.style.display = "flex";
    left.style.flexWrap = "wrap";
    left.style.gap = "10px";
    left.style.alignItems = "center";

    const pinLabel = document.createElement("span");
    pinLabel.style.fontSize = "0.85rem";
    pinLabel.style.opacity = "0.8";
    pinLabel.textContent = "League code:";

    const pinInput = document.createElement("input");
    pinInput.type = "password";
    pinInput.placeholder = "optional";
    pinInput.value = getLeaguePin();
    pinInput.style.padding = "10px 12px";
    pinInput.style.borderRadius = "10px";
    pinInput.style.border = "1px solid rgba(255,255,255,.14)";
    pinInput.style.background = "rgba(255,255,255,.06)";
    pinInput.style.color = "rgba(255,255,255,.92)";
    pinInput.style.outline = "none";
    pinInput.style.width = "160px";

    pinInput.addEventListener("change", () => {
      setLeaguePin(pinInput.value);
      toast("League code saved on this device.", "success");
    });

    left.appendChild(pinLabel);
    left.appendChild(pinInput);

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.flexWrap = "wrap";
    right.style.gap = "10px";
    right.style.alignItems = "center";

    const pendingCount = document.createElement("span");
    pendingCount.id = "pendingCount";
    pendingCount.style.fontSize = "0.85rem";
    pendingCount.style.opacity = "0.85";

    function refreshPendingLabel() {
      const n = getPendingMatches().length;
      pendingCount.textContent = n ? `Pending saves: ${n}` : "Pending saves: 0";
    }

    const syncBtn = document.createElement("button");
    syncBtn.className = "button";
    syncBtn.textContent = "Sync pending";
    syncBtn.style.padding = "10px 12px";

    syncBtn.addEventListener("click", async () => {
      try {
        syncBtn.disabled = true;
        syncBtn.textContent = "Syncing…";
        const res = await syncPendingMatches({ max: 25 });
        refreshPendingLabel();
        toast(`Synced ${res.synced}. Remaining ${res.remaining}.`, "success");
        // re-render current page if needed
        if (pageId === "leaderboard-page") renderLeaderboard();
        if (pageId === "matches-page") renderMatches();
        if (pageId === "awards-page") renderAwards();
      } catch (err) {
        toast(`Sync failed: ${err.message || err}`, "error");
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = "Sync pending";
      }
    });

    refreshPendingLabel();
    right.appendChild(pendingCount);
    right.appendChild(syncBtn);

    bar.appendChild(left);
    bar.appendChild(right);

    // Insert utility bar at top of main content
    container.insertBefore(bar, container.firstChild);

    // Keep label up to date
    setInterval(refreshPendingLabel, 2000);
  }

  function renderAddMatch() {
    const challengerSelect = $("#challengerSelect");
    const defenderSelect = $("#defenderSelect");
    if (!challengerSelect || !defenderSelect) return;

    ensureSyncAndPinUI();
    populateSelects();

    const challengerNameEl = $("#challengerName");
    const defenderNameEl = $("#defenderName");
    const challengerScoreEl = $("#challengerScore");
    const defenderScoreEl = $("#defenderScore");
    const challengerWinnerLabel = $("#challengerWinner");
    const defenderWinnerLabel = $("#defenderWinner");
    const summaryEl = $("#summary");
    const confirmBtn = $("#confirmButton");

    const challengerPlus = $("#challengerPlus");
    const challengerMinus = $("#challengerMinus");
    const defenderPlus = $("#defenderPlus");
    const defenderMinus = $("#defenderMinus");

    if (
      !challengerNameEl ||
      !defenderNameEl ||
      !challengerScoreEl ||
      !defenderScoreEl ||
      !challengerWinnerLabel ||
      !defenderWinnerLabel ||
      !summaryEl ||
      !confirmBtn ||
      !challengerPlus ||
      !challengerMinus ||
      !defenderPlus ||
      !defenderMinus
    ) {
      return;
    }

    let challenger = safeText(challengerSelect.value);
    let defender = safeText(defenderSelect.value);
    let challengerScore = 0;
    let defenderScore = 0;
    let matchFinished = false;

    function resetScores() {
      challengerScore = 0;
      defenderScore = 0;
      matchFinished = false;
      challengerScoreEl.textContent = "0";
      defenderScoreEl.textContent = "0";
      challengerWinnerLabel.classList.add("hide");
      defenderWinnerLabel.classList.add("hide");
      summaryEl.classList.add("hide");
      confirmBtn.classList.add("hide");
    }

    function updateNames() {
      challenger = safeText(challengerSelect.value);
      defender = safeText(defenderSelect.value);

      if (challenger === defender) {
        // auto-correct
        const alt = players.find((p) => p.name !== challenger);
        if (alt) defenderSelect.value = alt.name;
        defender = safeText(defenderSelect.value);
      }

      challengerNameEl.textContent = challenger;
      defenderNameEl.textContent = defender;
      resetScores();
    }

    function updateWinnerDisplay() {
      challengerWinnerLabel.classList.add("hide");
      defenderWinnerLabel.classList.add("hide");
      matchFinished = false;

      if (challengerScore >= 2 || defenderScore >= 2) {
        matchFinished = true;
        if (challengerScore >= 2) challengerWinnerLabel.classList.remove("hide");
        if (defenderScore >= 2) defenderWinnerLabel.classList.remove("hide");

        const winner = challengerScore >= 2 ? challenger : defender;
        const scoreStr = `${challengerScore}-${defenderScore}`;

        summaryEl.innerHTML = `
          <strong>${winner}</strong> wins ${scoreStr}.
          <div style="margin-top:6px; opacity:.85; font-size:.9rem;">
            We’ll validate the challenge rules and update the ladder.
          </div>
        `;
        summaryEl.classList.remove("hide");
        confirmBtn.classList.remove("hide");
      } else {
        summaryEl.classList.add("hide");
        confirmBtn.classList.add("hide");
      }
    }

    challengerPlus.addEventListener("click", () => {
      if (matchFinished) return;
      if (challengerScore >= 2) return;
      challengerScore++;
      challengerScoreEl.textContent = String(challengerScore);
      updateWinnerDisplay();
    });

    challengerMinus.addEventListener("click", () => {
      if (matchFinished) return;
      challengerScore = Math.max(0, challengerScore - 1);
      challengerScoreEl.textContent = String(challengerScore);
      updateWinnerDisplay();
    });

    defenderPlus.addEventListener("click", () => {
      if (matchFinished) return;
      if (defenderScore >= 2) return;
      defenderScore++;
      defenderScoreEl.textContent = String(defenderScore);
      updateWinnerDisplay();
    });

    defenderMinus.addEventListener("click", () => {
      if (matchFinished) return;
      defenderScore = Math.max(0, defenderScore - 1);
      defenderScoreEl.textContent = String(defenderScore);
      updateWinnerDisplay();
    });

    challengerSelect.addEventListener("change", () => {
      rebuildDefenderOptions({ challengerSelect, defenderSelect });
      updateNames();
    });
    defenderSelect.addEventListener("change", updateNames);

    updateNames();

    confirmBtn.addEventListener("click", async () => {
      if (!matchFinished) return;

      const winner = challengerScore >= 2 ? challenger : defender;
      const scoreStr = `${challengerScore}-${defenderScore}`;

      const match = {
        date: new Date().toISOString(), // server formats/records as it likes
        challenger,
        defender,
        winner,
        score: scoreStr,
      };

      confirmBtn.disabled = true;
      confirmBtn.textContent = "Saving…";

      try {
        await postMatch(match);
        toast("Match saved and ladder updated.", "success");
        resetScores();
        updateNames(); // refresh names + reset

      } catch (err) {
        // Queue locally so it never feels broken
        enqueuePending(match);
        toast(`Couldn’t save right now. Stored locally (pending sync).`, "warn");
        resetScores();
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = "Confirm Match";
      }
    });
  }

  // -----------------------------
  // Rules page search (light touch)
  // -----------------------------
  function initRulesSearch() {
    const input = $("#ruleSearch");
    if (!input) return;

    input.addEventListener("input", () => {
      const q = safeText(input.value).toLowerCase();
      const rules = document.querySelectorAll(".rule-card, .card");
      rules.forEach((r) => {
        const txt = safeText(r.textContent).toLowerCase();
        r.style.display = !q || txt.includes(q) ? "" : "none";
      });
    });
  }

  // -----------------------------
  // Boot
  // -----------------------------
  async function boot() {
    const page = document.body?.id || "";

    // Use cached state immediately (fast paint), then refresh from server
    const cached = loadLastState();
    if (cached?.players && cached?.matches) {
      players = cached.players.map(normalizePlayer);
      matches = cached.matches.map(normalizeMatch);
      players.sort((a, b) => a.rank - b.rank);
      matches.sort((a, b) => new Date(a.date) - new Date(b.date));
    }

    // Render initial (cached) if possible
    if (page === "leaderboard-page") renderLeaderboard();
    if (page === "matches-page") {
      ensureSyncAndPinUI();
      renderMatches();
    }
    if (page === "awards-page") renderAwards();
    if (page === "add-match-page") renderAddMatch();
    if (page === "rules-page") initRulesSearch();

    // Now fetch live state
    try {
      await fetchState();

      // Auto-sync any pending matches when online
      const pending = getPendingMatches().length;
      if (pending) {
        try {
          const res = await syncPendingMatches({ max: 10 });
          if (res.synced) toast(`Auto-synced ${res.synced} pending match(es).`, "success");
        } catch {
          // ignore (manual sync available)
        }
      }

      // Re-render with fresh data
      if (page === "leaderboard-page") renderLeaderboard();
      if (page === "matches-page") renderMatches();
      if (page === "awards-page") renderAwards();
      if (page === "add-match-page") renderAddMatch();

    } catch (err) {
      toast(`Live update failed. Using cached data.`, "warn");
      // keep cached UI
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
