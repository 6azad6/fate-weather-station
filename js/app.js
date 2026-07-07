const moneyFmt = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2, minimumFractionDigits: 0 });
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const playTypes = [
  { id: "spf", name: "胜平负" },
  { id: "score", name: "比分" },
  { id: "goals", name: "总进球" },
  { id: "half", name: "半全场" },
];

let spfOptions = [
  { value: "win", label: "主胜", odds: 1.78 },
  { value: "draw", label: "平局", odds: 3.68 },
  { value: "loss", label: "客胜", odds: 4.25 },
];

let scoreOptions = [
  ["1:0", 11.5], ["2:0", 14], ["2:1", 5.75], ["3:0", 30], ["3:1", 14],
  ["3:2", 18], ["4:0", 80], ["4:1", 50], ["4:2", 45], ["5:0", 200],
  ["5:1", 120], ["5:2", 150], ["胜其它", 90], ["0:0", 13.5], ["1:1", 6.55],
  ["2:2", 8.5], ["3:3", 28], ["平其它", 150], ["0:1", 8.5], ["0:2", 10.5],
  ["1:2", 6.1], ["0:3", 18], ["1:3", 11.5], ["2:3", 17], ["0:4", 45],
  ["1:4", 38], ["2:4", 50], ["0:5", 110], ["1:5", 100], ["负其它", 60],
].map(([value, odds]) => ({ value, label: value, odds }));

let goalsOptions = [
  ["0球", 9.2], ["1球", 4.15], ["2球", 3.65], ["3球", 3.95],
  ["4球", 5.4], ["5球", 9.8], ["6球", 18], ["7+球", 32],
].map(([label, odds], i) => ({ value: String(i), label, odds }));

let halfOptions = [
  ["胜胜", 2.7], ["胜平", 15], ["胜负", 32],
  ["平胜", 4.5], ["平平", 5.2], ["平负", 8.8],
  ["负胜", 26], ["负平", 13], ["负负", 6.4],
].map(([label, odds]) => ({ value: label, label, odds }));

let matches = [
  { id: 93, code: "周一093", league: "世界杯", time: "07-07 03:00", home: "葡萄牙", away: "西班牙", odds: [1.92, 3.42, 3.88] },
  { id: 94, code: "周一094", league: "世界杯", time: "07-07 08:00", home: "美国", away: "比利时", odds: [2.85, 3.35, 2.22] },
  { id: 95, code: "周二001", league: "亚洲杯", time: "07-08 19:30", home: "日本", away: "韩国", odds: [2.18, 3.12, 3.05] },
  { id: 96, code: "周二002", league: "友谊赛", time: "07-08 22:00", home: "巴西", away: "德国", odds: [2.05, 3.55, 3.25] },
];

const defaultState = () => ({
  tab: "bet",
  playType: "score",
  selections: {},
  tickets: [],
  totalBet: 0,
  totalReturn: 0,
  history: [],
});

let state = loadState();

function makeClientId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  return `wx-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const realtime = {
  enabled: false,
  connected: false,
  clientId: localStorage.getItem("fateWeatherClientId") || makeClientId(),
  pollTimer: null,
  eventSource: null,
  oddsUpdatedAt: "",
};
localStorage.setItem("fateWeatherClientId", realtime.clientId);

function loadState() {
  try {
    const raw = localStorage.getItem("fateWeatherState");
    if (raw) return { ...defaultState(), ...JSON.parse(raw) };
  } catch (e) {
    console.warn(e);
  }
  return defaultState();
}

function saveState() {
  localStorage.setItem("fateWeatherState", JSON.stringify(state));
}

async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || "服务器请求失败");
  return data;
}

function applyServerState(serverState) {
  if (!serverState || !serverState.realtime) return;
  realtime.enabled = true;
  realtime.connected = true;
  realtime.oddsUpdatedAt = serverState.oddsUpdatedAt || "";
  if (Array.isArray(serverState.matches)) matches = serverState.matches;
  if (serverState.options) {
    if (Array.isArray(serverState.options.score)) scoreOptions = serverState.options.score;
    if (Array.isArray(serverState.options.goals)) goalsOptions = serverState.options.goals;
    if (Array.isArray(serverState.options.half)) halfOptions = serverState.options.half;
  }
  syncSelectionsWithLatestOdds();
  state.totalBet = Number(serverState.totalBet) || 0;
  state.totalReturn = Number(serverState.totalReturn) || 0;
  state.history = Array.isArray(serverState.history) ? serverState.history.slice(-15) : [];
  state.tickets = Array.isArray(serverState.myTickets) ? serverState.myTickets : [];
  state.pendingGlobal = Number(serverState.pendingTickets) || 0;
  state.totalTickets = Number(serverState.totalTickets) || 0;
  updateRealtimeLabels(serverState);
  renderAll();
}

function syncSelectionsWithLatestOdds() {
  Object.keys(state.selections || {}).forEach((key) => {
    const selected = state.selections[key];
    const match = matches.find((item) => item.id === Number(selected.matchId));
    if (!match) return;
    const latest = optionList(selected.playType, match).find((item) => String(item.value) === String(selected.value));
    if (latest) {
      selected.odds = Number(latest.odds);
      selected.label = latest.label;
    }
  });
}

function updateRealtimeLabels(serverState = {}) {
  const status = $(".status-row strong");
  if (status) status.textContent = realtime.enabled ? "多人实时版" : "本地演示版";
  const sub = $(".lottery-head .sub");
  if (sub) {
    const time = realtime.oddsUpdatedAt ? new Date(realtime.oddsUpdatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "本地";
    const source = serverState.matchSource === "the-odds-api"
      ? "The Odds API"
      : serverState.matchSource === "football-data.org"
        ? "football-data.org"
        : serverState.matchSource === "no-real-matches"
          ? "暂无真实世界杯赛程"
          : "模拟";
    const quota = serverState.oddsApiUsage ? `，赔率API ${serverState.oddsApiUsage.usedToday}/${serverState.oddsApiUsage.dailyLimit}次/日` : "";
    sub.textContent = realtime.enabled
      ? `微信/公网多人模式：赛程/赔率来源 ${source}（${time}${quota}），投注与开奖汇总到全站气象球。`
      : "本地离线演示：选择赔率 → 虚拟投注 → 模拟开奖。部署 server.js 后自动切换多人实时。";
  }
  const small = $("#pendingCount");
  if (small && realtime.enabled) small.textContent = serverState.pendingTickets ? `全站待开奖 ${serverState.pendingTickets} 张` : "全站暂无待开奖";
}

async function refreshServerState() {
  const data = await apiFetch(`/api/state?clientId=${encodeURIComponent(realtime.clientId)}`);
  applyServerState(data);
  return data;
}

function startRealtimePush() {
  if (!realtime.enabled || realtime.eventSource || !("EventSource" in window)) return;
  try {
    const es = new EventSource(`/api/events?clientId=${encodeURIComponent(realtime.clientId)}`);
    realtime.eventSource = es;
    es.onmessage = (event) => {
      try {
        applyServerState(JSON.parse(event.data));
      } catch (err) {
        console.warn("实时消息解析失败", err);
      }
    };
    es.onerror = () => {
      realtime.connected = false;
      es.close();
      realtime.eventSource = null;
      startPolling();
    };
  } catch (err) {
    console.warn("实时连接失败，切换轮询", err);
    startPolling();
  }
}

function startPolling() {
  if (realtime.pollTimer) return;
  realtime.pollTimer = setInterval(() => {
    if (realtime.enabled) refreshServerState().catch(() => {});
  }, 5000);
}

async function initRealtime() {
  try {
    await refreshServerState();
    startRealtimePush();
    startPolling();
    toast("已连接多人实时服务器：气象球显示全站用户总盈亏。");
  } catch (err) {
    realtime.enabled = false;
    updateRealtimeLabels();
    console.info("未检测到多人后端，继续使用本地演示模式。", err);
  }
}

function formatMoney(v) {
  return "¥" + moneyFmt.format(Math.round((Number(v) || 0) * 100) / 100);
}

function escapeAttr(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("show"), 2300);
}

function switchTab(tab) {
  state.tab = tab;
  $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#betPage").classList.toggle("active", tab === "bet");
  $("#weatherPage").classList.toggle("active", tab === "weather");
  saveState();
  renderWeather();
}

function optionList(playType, match) {
  if (playType === "spf") return spfOptions.map((o, i) => ({ ...o, odds: match.odds[i] }));
  if (playType === "score") return scoreOptions;
  if (playType === "goals") return goalsOptions;
  return halfOptions;
}

function selectedArray() {
  return Object.values(state.selections);
}

function comb(arr, k) {
  const out = [];
  function walk(start, picked) {
    if (picked.length === k) {
      out.push([...picked]);
      return;
    }
    for (let i = start; i <= arr.length - (k - picked.length); i++) {
      picked.push(arr[i]);
      walk(i + 1, picked);
      picked.pop();
    }
  }
  if (k > 0 && k <= arr.length) walk(0, []);
  return out;
}

function currentPass() {
  const n = selectedArray().length;
  const raw = Number($("#passSelect")?.value || Math.min(2, n) || 1);
  return Math.max(1, Math.min(raw, Math.max(1, n)));
}

function ticketCalc(selections = selectedArray(), pass = currentPass()) {
  const times = Math.max(1, Math.min(99, Number($("#timesInput")?.value) || 1));
  const amount = 2;
  const combos = comb(selections, pass);
  const totalMoney = combos.length * times * amount;
  const maxPrize = combos.reduce((sum, c) => sum + c.reduce((p, s) => p * s.odds, 1) * times * amount, 0);
  return { times, amount, combos, totalMoney, maxPrize };
}

function renderPlayTabs() {
  $("#playTabs").innerHTML = playTypes.map((p) =>
    `<button class="play-tab ${state.playType === p.id ? "active" : ""}" data-play="${p.id}">${p.name}</button>`
  ).join("");
  $$("#playTabs .play-tab").forEach((btn) => btn.addEventListener("click", () => {
    state.playType = btn.dataset.play;
    saveState();
    renderAll();
  }));
}

function renderMatches() {
  if (!matches.length) {
    $("#matchList").innerHTML = `<div class="empty">当前没有从真实接口获取到可投注赛程。请检查 Render 环境变量 ODDS_API_KEY / ODDS_API_SPORTS，或稍后刷新。</div>`;
    return;
  }
  $("#matchList").innerHTML = matches.map((match) => {
    const gridClass = state.playType === "score" ? "score-grid" : state.playType === "goals" ? "goals-grid" : state.playType === "half" ? "half-grid" : "odds-row";
    const buttons = optionList(state.playType, match).map((opt) => {
      const key = `${match.id}|${state.playType}|${opt.value}`;
      const selected = !!state.selections[key];
      return `<button class="odds-btn ${selected ? "selected" : ""}" data-key="${escapeAttr(key)}" data-match="${match.id}" data-value="${escapeAttr(opt.value)}" data-label="${escapeAttr(opt.label)}" data-odds="${opt.odds}">
        <span class="label">${opt.label}</span><span class="odd">${Number(opt.odds).toFixed(2)}</span>
      </button>`;
    }).join("");
    return `<article class="match-card">
      <div class="match-meta"><div class="match-code">${match.code}</div><div class="league">${match.league}</div><div class="time">${match.time}</div></div>
      <div class="teams"><div class="team home">${match.home}</div><div class="vs">VS</div><div class="team away">${match.away}</div></div>
      <div class="${gridClass}">${buttons}</div>
    </article>`;
  }).join("");
  $$("#matchList .odds-btn").forEach((btn) => btn.addEventListener("click", () => toggleSelection(btn)));
}

function toggleSelection(btn) {
  const match = matches.find((m) => m.id === Number(btn.dataset.match));
  const key = btn.dataset.key;
  if (state.selections[key]) {
    delete state.selections[key];
  } else {
    state.selections[key] = {
      key,
      matchId: match.id,
      code: match.code,
      league: match.league,
      time: match.time,
      home: match.home,
      away: match.away,
      playType: state.playType,
      value: btn.dataset.value,
      label: btn.dataset.label,
      odds: Number(btn.dataset.odds),
    };
  }
  saveState();
  renderAll();
}

function renderTicket() {
  const n = selectedArray().length;
  $("#selectedBadge").textContent = n;
  const pass = Math.min(currentPass(), Math.max(1, n));
  const opts = [];
  if (n === 0) {
    opts.push('<option value="1">请选择赔率</option>');
  } else {
    for (let i = 1; i <= n; i++) {
      opts.push(`<option value="${i}" ${i === pass ? "selected" : ""}>${i === 1 ? "单关" : i + "串1"}</option>`);
    }
  }
  $("#passSelect").innerHTML = opts.join("");
  const calc = ticketCalc(selectedArray(), pass);
  $("#totalMoney").textContent = moneyFmt.format(calc.totalMoney);
  $("#maxPrize").textContent = moneyFmt.format(calc.maxPrize);
  $("#buyBtn").disabled = n === 0;
}

function renderTickets() {
  const pending = realtime.enabled ? (state.pendingGlobal || 0) : state.tickets.filter((t) => !t.settled).length;
  $("#pendingCount").textContent = pending
    ? `${realtime.enabled ? "全站待开奖" : "待开奖"} ${pending} 张`
    : `${realtime.enabled ? "全站暂无待开奖" : "暂无待开奖"}`;
  const latest = [...state.tickets].slice(-5).reverse();
  $("#ticketsList").innerHTML = latest.length ? latest.map((t) => {
    const names = t.selections.map((s) => `${s.code} ${s.home}vs${s.away} ${s.label}@${s.odds}`).join(" / ");
    const status = !t.settled
      ? '<span class="pending">待开奖</span>'
      : (t.profit >= 0 ? `<span class="win">中奖返还 ${formatMoney(t.winAmount)}</span>` : `<span class="loss">未中，亏损 ${formatMoney(Math.abs(t.profit))}</span>`);
    return `<div class="ticket-item"><strong>#${t.id}</strong> ${t.pass === 1 ? "单关" : t.pass + "串1"}　${formatMoney(t.totalMoney)}　${status}<br>${names}</div>`;
  }).join("") : `<div class="empty">${realtime.enabled ? "你还没有投注记录。全站数据仍会实时驱动气象球。" : "还没有投注记录。可以先选择赔率，再点击确认投注。"}</div>`;
}

async function buyTicket() {
  const selections = selectedArray();
  if (!selections.length) {
    toast("请先选择至少一个赔率。");
    return;
  }
  const pass = currentPass();
  const calc = ticketCalc(selections, pass);

  if (realtime.enabled) {
    try {
      $("#buyBtn").disabled = true;
      const data = await apiFetch("/api/bets", {
        method: "POST",
        body: JSON.stringify({
          clientId: realtime.clientId,
          selections,
          pass,
          times: calc.times,
          amount: calc.amount,
        }),
      });
      state.selections = {};
      applyServerState(data.state);
      toast(`已提交到多人服务器：投入 ${formatMoney(data.ticket.totalMoney)}，气象球将读取全站总盈亏。`);
    } catch (err) {
      toast(err.message || "服务器投注失败");
      renderTicket();
    }
    return;
  }

  const ticket = {
    id: Date.now(),
    selections: selections.map((s) => ({ ...s })),
    pass,
    times: calc.times,
    amount: calc.amount,
    totalMoney: calc.totalMoney,
    maxPrize: calc.maxPrize,
    settled: false,
  };
  state.tickets.push(ticket);
  state.totalBet += ticket.totalMoney;
  state.selections = {};
  saveState();
  renderAll();
  toast(`虚拟投注成功：${ticket.pass === 1 ? "单关" : ticket.pass + "串1"}，投入 ${formatMoney(ticket.totalMoney)}。`);
}

function scoreOutcome(score) {
  if (score.includes("其它")) {
    if (score.startsWith("胜")) return "win";
    if (score.startsWith("平")) return "draw";
    if (score.startsWith("负")) return "loss";
  }
  const [h, a] = score.split(":").map(Number);
  if (h > a) return "win";
  if (h === a) return "draw";
  return "loss";
}

function randomScoreFor(outcome) {
  const pool = scoreOptions.filter((o) => !o.value.includes("其它") && scoreOutcome(o.value) === outcome);
  return pool[Math.floor(Math.random() * pool.length)]?.value || (outcome === "win" ? "2:1" : outcome === "loss" ? "1:2" : "1:1");
}

function weightedOutcome() {
  const r = Math.random();
  if (r < 0.43) return "win";
  if (r < 0.69) return "draw";
  return "loss";
}

function randomHalf(outcome) {
  const last = outcome === "win" ? "胜" : outcome === "draw" ? "平" : "负";
  const first = ["胜", "平", "负"][Math.floor(Math.random() * 3)];
  return first + last;
}

function buildResults(tickets, forced) {
  const ids = [...new Set(tickets.flatMap((t) => t.selections.map((s) => s.matchId)))];
  const results = {};
  ids.forEach((id) => {
    const outcome = forced === "random" ? weightedOutcome() : forced;
    const score = randomScoreFor(outcome);
    const totalGoals = score.split(":").map(Number).reduce((a, b) => a + b, 0);
    results[id] = { outcome, score, totalGoals: Math.min(totalGoals, 7), half: randomHalf(outcome) };
  });
  return results;
}

function selectionWins(sel, result) {
  if (sel.playType === "spf") return sel.value === result.outcome;
  if (sel.playType === "score") return sel.value === result.score || (sel.value.includes("其它") && scoreOutcome(sel.value) === result.outcome);
  if (sel.playType === "goals") return Number(sel.value) === Math.min(result.totalGoals, 7);
  if (sel.playType === "half") return sel.value === result.half;
  return false;
}

async function settleTickets(forced = "random") {
  if (realtime.enabled) {
    try {
      const data = await apiFetch("/api/settle", {
        method: "POST",
        body: JSON.stringify({ clientId: realtime.clientId, result: forced }),
      });
      applyServerState(data.state);
      const profit = (data.roundReturn || 0) - (data.roundBet || 0);
      toast(data.settled
        ? `${forced === "real" ? "真实赛果" : "模拟"}已结算 ${data.settled} 张：本轮${profit >= 0 ? "盈利" : "亏损"} ${formatMoney(Math.abs(profit))}。`
        : (forced === "real" ? "暂时没有已完赛且可按真实比分结算的投注。" : "全站当前没有待开奖投注。"));
    } catch (err) {
      toast(err.message || "服务器开奖失败");
    }
    return;
  }

  const pending = state.tickets.filter((t) => !t.settled);
  if (!pending.length) {
    toast("当前没有待开奖的投注。");
    return;
  }
  const results = buildResults(pending, forced);
  let roundBet = 0;
  let roundReturn = 0;
  pending.forEach((t) => {
    const combos = comb(t.selections, t.pass);
    let payout = 0;
    combos.forEach((c) => {
      const ok = c.every((sel) => selectionWins(sel, results[sel.matchId]));
      if (ok) payout += c.reduce((p, s) => p * s.odds, 1) * t.amount * t.times;
    });
    t.settled = true;
    t.results = results;
    t.winAmount = Math.round(payout * 100) / 100;
    t.profit = Math.round((t.winAmount - t.totalMoney) * 100) / 100;
    roundBet += t.totalMoney;
    roundReturn += t.winAmount;
  });
  state.totalReturn += roundReturn;
  state.history.push({
    time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
    result: forced,
    bet: roundBet,
    ret: roundReturn,
    profit: Math.round((roundReturn - roundBet) * 100) / 100,
  });
  state.history = state.history.slice(-15);
  saveState();
  renderAll();
  renderWeather();
  const msg = roundReturn >= roundBet
    ? `本轮返还 ${formatMoney(roundReturn)}，集体暂时盈利 ${formatMoney(roundReturn - roundBet)}。`
    : `本轮返还 ${formatMoney(roundReturn)}，集体亏损 ${formatMoney(roundBet - roundReturn)}。`;
  toast(msg);
}

async function autoSimulate() {
  if (realtime.enabled) {
    try {
      const data = await apiFetch("/api/demo/auto", {
        method: "POST",
        body: JSON.stringify({ clientId: realtime.clientId, rounds: 10 }),
      });
      applyServerState(data.state);
      switchTab("weather");
      toast(`服务器已自动模拟 ${data.created || 10} 轮，全站总盈亏已更新。`);
    } catch (err) {
      toast(err.message || "自动模拟失败");
    }
    return;
  }

  for (let i = 0; i < 10; i++) {
    const count = 1 + Math.floor(Math.random() * 3);
    const play = Math.random() < 0.45 ? "score" : (Math.random() < 0.7 ? "spf" : "goals");
    const shuffled = [...matches].sort(() => Math.random() - 0.5).slice(0, count);
    const selections = shuffled.map((match) => {
      const opts = optionList(play, match);
      const opt = opts[Math.floor(Math.random() * opts.length)];
      return { key: `auto-${Date.now()}-${Math.random()}`, matchId: match.id, code: match.code, league: match.league, time: match.time, home: match.home, away: match.away, playType: play, value: opt.value, label: opt.label, odds: opt.odds };
    });
    const pass = count > 1 && Math.random() < 0.55 ? 2 : 1;
    const times = 1 + Math.floor(Math.random() * 4);
    const amount = 2;
    const combos = comb(selections, pass);
    const totalMoney = combos.length * times * amount;
    const maxPrize = combos.reduce((sum, c) => sum + c.reduce((p, s) => p * s.odds, 1) * times * amount, 0);
    state.tickets.push({ id: Date.now() + i, selections, pass, times, amount, totalMoney, maxPrize, settled: false, auto: true });
    state.totalBet += totalMoney;
    settleTickets("random");
  }
  saveState();
  renderAll();
  renderWeather();
  switchTab("weather");
  toast("已自动模拟10轮，观察返还率如何向赔率结构回落。");
}

function demoSelect() {
  state.playType = "score";
  state.selections = {};
  const picks = [{ match: matches[0], value: "1:2" }, { match: matches[1], value: "2:3" }];
  picks.forEach((p) => {
    const opt = scoreOptions.find((o) => o.value === p.value);
    const key = `${p.match.id}|score|${opt.value}`;
    state.selections[key] = { key, matchId: p.match.id, code: p.match.code, league: p.match.league, time: p.match.time, home: p.match.home, away: p.match.away, playType: "score", value: opt.value, label: opt.label, odds: opt.odds };
  });
  saveState();
  renderAll();
  $("#passSelect").value = "2";
  renderTicket();
  toast("已按参考截图选择两场比分：1:2 与 2:3。");
}

function renderWeather() {
  const totalBet = state.totalBet || 0;
  const totalReturn = state.totalReturn || 0;
  const net = totalReturn - totalBet;
  const rate = totalBet > 0 ? totalReturn / totalBet : 0;
  const hue = Math.max(45, Math.min(260, 45 + (1 - Math.min(1, rate)) * 215));
  const sat = 78 + Math.min(1, rate) * 12;
  const light = 25 + Math.min(1, rate) * 45;
  const glow = Math.min(1, Math.abs(net) / 5000);
  const color1 = `hsl(${Math.max(38, hue - 35)} ${sat}% ${Math.min(88, light + 24)}%)`;
  const color2 = `hsl(${hue} ${sat}% ${light}%)`;
  const color3 = `hsl(${Math.min(275, hue + 38)} ${Math.max(55, sat - 10)}% ${Math.max(18, light - 16)}%)`;
  $("#orbStop1").setAttribute("stop-color", color1);
  $("#orbStop2").setAttribute("stop-color", color2);
  $("#orbStop3").setAttribute("stop-color", color3);
  $("#orbGlow").setAttribute("stroke", color2);
  $("#orbGlow").setAttribute("stroke-width", 14 + glow * 28);
  $("#orbGlow").setAttribute("opacity", 0.2 + glow * 0.55);
  $("#stormPath").setAttribute("opacity", net < 0 ? Math.min(0.52, 0.08 + glow * 0.55) : 0.04);
  $("#statBet").textContent = formatMoney(totalBet);
  $("#statReturn").textContent = formatMoney(totalReturn);
  $("#statProfit").textContent = (net >= 0 ? "+" : "-") + formatMoney(Math.abs(net));
  $("#statProfit").classList.toggle("positive", net > 0);
  $("#statProfit").classList.toggle("negative", net < 0);
  $("#statRate").textContent = (rate * 100).toFixed(totalBet ? 1 : 0) + "%";
  $("#profitMarker").style.left = Math.max(0, Math.min(100, 50 + net / 5000 * 50)) + "%";
  const mood = totalBet === 0
    ? ["未观测", realtime.enabled ? "等待全站第一笔虚拟投注。球体现在处于未观测状态。" : "等待第一笔虚拟投注。球体现在处于未观测状态。"]
    : net >= 0
      ? ["琥珀晴天", `${realtime.enabled ? "全站" : ""}返还率 ${(rate * 100).toFixed(1)}%，样本仍在幸运波动中，球体保持暖色。`]
      : rate > 0.72
        ? ["灰蓝阴霾", `${realtime.enabled ? "全站" : ""}返还率 ${(rate * 100).toFixed(1)}%，净亏损开始出现，颜色向冷色移动。`]
        : ["紫电风暴", `${realtime.enabled ? "全站用户" : "集体"}净亏损扩大，返还率 ${(rate * 100).toFixed(1)}%，光晕转为风暴。`];
  $("#weatherPill").textContent = mood[0];
  $("#weatherCaption").textContent = mood[1];
  renderHistory();
}

function renderHistory() {
  const list = $("#historyList");
  if (!state.history.length) {
    list.innerHTML = '<div class="empty" style="min-width:100%">暂无开奖历史。完成一次投注并开奖后，这里会出现轨迹。</div>';
    return;
  }
  list.innerHTML = [...state.history].reverse().map((h, i) => {
    const win = h.profit >= 0;
    const rate = h.bet > 0 ? h.ret / h.bet * 100 : 0;
    return `<div class="history-chip"><div class="num ${win ? "win" : "loss"}">${win ? "+" : "-"}¥${moneyFmt.format(Math.abs(h.profit))}</div><div class="rate">返还率 ${rate.toFixed(0)}%</div><div class="rate">${h.time || "刚刚"} · 第${state.history.length - i}轮</div></div>`;
  }).join("");
}

function resetAll() {
  if (realtime.enabled) {
    state.selections = {};
    saveState();
    refreshServerState().catch(() => renderAll());
    toast("多人实时模式下不会清空全站数据；已清空本机当前选择。");
    return;
  }
  state = defaultState();
  saveState();
  renderAll();
  renderWeather();
  toast("数据已重置。");
}

function renderAll() {
  renderPlayTabs();
  renderMatches();
  renderTicket();
  renderTickets();
  renderWeather();
}

document.addEventListener("DOMContentLoaded", () => {
  $$(".tab-btn").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));
  $("#passSelect").addEventListener("change", renderTicket);
  $("#timesInput").addEventListener("input", renderTicket);
  $("#buyBtn").addEventListener("click", buyTicket);
  $("#clearBtn").addEventListener("click", () => { state.selections = {}; saveState(); renderAll(); });
  $("#demoSelectBtn").addEventListener("click", demoSelect);
  $("#autoBtn").addEventListener("click", autoSimulate);
  $("#toWeatherBtn").addEventListener("click", () => switchTab("weather"));
  $$(".settle-actions button").forEach((btn) => btn.addEventListener("click", () => settleTickets(btn.dataset.settle)));
  let resetPress = 0;
  $(".brand-mark").addEventListener("click", () => {
    resetPress++;
    if (resetPress >= 3) {
      $("#resetModal").classList.add("show");
      resetPress = 0;
    } else {
      toast("连续点击水晶球 3 次可重置所有演示数据。");
    }
  });
  $("#resetCancel").addEventListener("click", () => $("#resetModal").classList.remove("show"));
  $("#resetOk").addEventListener("click", () => { $("#resetModal").classList.remove("show"); resetAll(); });
  renderAll();
  switchTab(state.tab || "bet");
  initRealtime();
});
