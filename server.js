/**
 * 命运气象站 - 多人实时后端
 *
 * 运行方式：
 *   node server.js
 *   打开 http://127.0.0.1:8765/
 *
 * 特点：
 * - 零第三方依赖，方便部署到 Render / Railway / 个人服务器。
 * - 所有用户共享 data/db.json，因此气象球读取的是全站总投注、总返还、总盈亏。
 * - 提供 SSE 实时推送；微信 WebView 不支持时，前端会自动降级为轮询。
 * - 当前赔率和开奖为课程演示用模拟数据；后续可把 updateOddsTick() 替换成真实接口。
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || "0.0.0.0";

const scoreDefaults = [
  ["1:0", 11.5], ["2:0", 14], ["2:1", 5.75], ["3:0", 30], ["3:1", 14],
  ["3:2", 18], ["4:0", 80], ["4:1", 50], ["4:2", 45], ["5:0", 200],
  ["5:1", 120], ["5:2", 150], ["胜其它", 90], ["0:0", 13.5], ["1:1", 6.55],
  ["2:2", 8.5], ["3:3", 28], ["平其它", 150], ["0:1", 8.5], ["0:2", 10.5],
  ["1:2", 6.1], ["0:3", 18], ["1:3", 11.5], ["2:3", 17], ["0:4", 45],
  ["1:4", 38], ["2:4", 50], ["0:5", 110], ["1:5", 100], ["负其它", 60],
].map(([value, odds]) => ({ value, label: value, odds }));

const goalsDefaults = [
  ["0球", 9.2], ["1球", 4.15], ["2球", 3.65], ["3球", 3.95],
  ["4球", 5.4], ["5球", 9.8], ["6球", 18], ["7+球", 32],
].map(([label, odds], i) => ({ value: String(i), label, odds }));

const halfDefaults = [
  ["胜胜", 2.7], ["胜平", 15], ["胜负", 32],
  ["平胜", 4.5], ["平平", 5.2], ["平负", 8.8],
  ["负胜", 26], ["负平", 13], ["负负", 6.4],
].map(([label, odds]) => ({ value: label, label, odds }));

const defaultDb = () => ({
  version: 2,
  oddsUpdatedAt: new Date().toISOString(),
  matches: [
    { id: 93, code: "周一093", league: "世界杯", time: "07-07 03:00", home: "葡萄牙", away: "西班牙", odds: [1.92, 3.42, 3.88] },
    { id: 94, code: "周一094", league: "世界杯", time: "07-07 08:00", home: "美国", away: "比利时", odds: [2.85, 3.35, 2.22] },
    { id: 95, code: "周二001", league: "亚洲杯", time: "07-08 19:30", home: "日本", away: "韩国", odds: [2.18, 3.12, 3.05] },
    { id: 96, code: "周二002", league: "友谊赛", time: "07-08 22:00", home: "巴西", away: "德国", odds: [2.05, 3.55, 3.25] },
  ],
  options: {
    score: scoreDefaults,
    goals: goalsDefaults,
    half: halfDefaults,
  },
  tickets: [],
  totalBet: 0,
  totalReturn: 0,
  history: [],
});

let db = loadDb();
const sseClients = new Map();

function loadDb() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      return { ...defaultDb(), ...parsed, options: { ...defaultDb().options, ...(parsed.options || {}) } };
    }
  } catch (err) {
    console.error("读取数据库失败，将使用默认数据：", err);
  }
  return defaultDb();
}

function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

function publicState(clientId = "") {
  const pendingTickets = db.tickets.filter((ticket) => !ticket.settled).length;
  const myTickets = db.tickets
    .filter((ticket) => ticket.clientId === clientId)
    .slice(-10)
    .map((ticket) => ({
      id: ticket.id,
      selections: ticket.selections,
      pass: ticket.pass,
      times: ticket.times,
      amount: ticket.amount,
      totalMoney: ticket.totalMoney,
      maxPrize: ticket.maxPrize,
      settled: ticket.settled,
      winAmount: ticket.winAmount,
      profit: ticket.profit,
      createdAt: ticket.createdAt,
    }));

  return {
    realtime: true,
    serverTime: new Date().toISOString(),
    oddsUpdatedAt: db.oddsUpdatedAt,
    matches: db.matches,
    options: db.options,
    totalBet: round2(db.totalBet),
    totalReturn: round2(db.totalReturn),
    netProfit: round2(db.totalReturn - db.totalBet),
    returnRate: db.totalBet > 0 ? db.totalReturn / db.totalBet : 0,
    totalTickets: db.tickets.length,
    pendingTickets,
    settledTickets: db.tickets.length - pendingTickets,
    history: db.history.slice(-15),
    myTickets,
  };
}

function broadcast() {
  for (const [res, clientId] of sseClients.entries()) {
    const payload = `data: ${JSON.stringify(publicState(clientId))}\n\n`;
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("JSON 格式错误"));
      }
    });
    req.on("error", reject);
  });
}

function round2(num) {
  return Math.round((Number(num) || 0) * 100) / 100;
}

function clampOdds(v) {
  return Math.max(1.01, Math.min(500, round2(v)));
}

function jitterOdd(v) {
  const drift = 1 + (Math.random() - 0.5) * 0.035;
  return clampOdds(v * drift);
}

function updateOddsTick() {
  db.matches = db.matches.map((match) => ({
    ...match,
    odds: match.odds.map(jitterOdd),
  }));
  db.options = {
    score: db.options.score.map((opt) => ({ ...opt, odds: jitterOdd(opt.odds) })),
    goals: db.options.goals.map((opt) => ({ ...opt, odds: jitterOdd(opt.odds) })),
    half: db.options.half.map((opt) => ({ ...opt, odds: jitterOdd(opt.odds) })),
  };
  db.oddsUpdatedAt = new Date().toISOString();
  saveDb();
  broadcast();
}

function optionList(playType, match) {
  if (playType === "spf") {
    return [
      { value: "win", label: "主胜", odds: match.odds[0] },
      { value: "draw", label: "平局", odds: match.odds[1] },
      { value: "loss", label: "客胜", odds: match.odds[2] },
    ];
  }
  if (playType === "score") return db.options.score;
  if (playType === "goals") return db.options.goals;
  if (playType === "half") return db.options.half;
  return [];
}

function normalizeSelections(rawSelections) {
  if (!Array.isArray(rawSelections) || rawSelections.length === 0) {
    throw new Error("请至少选择一个赔率");
  }
  if (rawSelections.length > 8) {
    throw new Error("单次选择过多");
  }
  return rawSelections.map((raw) => {
    const match = db.matches.find((item) => item.id === Number(raw.matchId));
    if (!match) throw new Error("比赛不存在");
    const playType = String(raw.playType || "");
    const opt = optionList(playType, match).find((item) => String(item.value) === String(raw.value));
    if (!opt) throw new Error("赔率选项不存在或已更新，请刷新后重试");
    return {
      key: `${match.id}|${playType}|${opt.value}|${Date.now()}`,
      matchId: match.id,
      code: match.code,
      league: match.league,
      time: match.time,
      home: match.home,
      away: match.away,
      playType,
      value: opt.value,
      label: opt.label,
      odds: Number(opt.odds),
    };
  });
}

function comb(arr, k) {
  const out = [];
  function walk(start, picked) {
    if (picked.length === k) {
      out.push([...picked]);
      return;
    }
    for (let i = start; i <= arr.length - (k - picked.length); i += 1) {
      picked.push(arr[i]);
      walk(i + 1, picked);
      picked.pop();
    }
  }
  if (k > 0 && k <= arr.length) walk(0, []);
  return out;
}

function calcTicket(selections, pass, times, amount) {
  const combos = comb(selections, pass);
  const totalMoney = combos.length * times * amount;
  const maxPrize = combos.reduce((sum, c) => sum + c.reduce((p, s) => p * s.odds, 1) * times * amount, 0);
  return { combos, totalMoney: round2(totalMoney), maxPrize: round2(maxPrize) };
}

function createTicket(clientId, rawSelections, rawPass, rawTimes, rawAmount) {
  const selections = normalizeSelections(rawSelections);
  const pass = Math.max(1, Math.min(Number(rawPass) || 1, selections.length));
  const times = Math.max(1, Math.min(99, Number(rawTimes) || 1));
  const amount = Math.max(2, Math.min(200, Number(rawAmount) || 2));
  const calc = calcTicket(selections, pass, times, amount);
  if (!calc.totalMoney) throw new Error("投注金额无效");

  const ticket = {
    id: crypto.randomUUID(),
    clientId: clientId || "anonymous",
    selections,
    pass,
    times,
    amount,
    totalMoney: calc.totalMoney,
    maxPrize: calc.maxPrize,
    settled: false,
    createdAt: new Date().toISOString(),
  };
  db.tickets.push(ticket);
  db.totalBet = round2(db.totalBet + ticket.totalMoney);
  saveDb();
  broadcast();
  return ticket;
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
  const pool = db.options.score.filter((opt) => !opt.value.includes("其它") && scoreOutcome(opt.value) === outcome);
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
  const ids = [...new Set(tickets.flatMap((ticket) => ticket.selections.map((selection) => selection.matchId)))];
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

function settlePending(forced = "random", ticketIds = null) {
  const allow = ticketIds ? new Set(ticketIds) : null;
  const pending = db.tickets.filter((ticket) => !ticket.settled && (!allow || allow.has(ticket.id)));
  if (!pending.length) return { settled: 0, roundBet: 0, roundReturn: 0 };

  const results = buildResults(pending, forced);
  let roundBet = 0;
  let roundReturn = 0;
  pending.forEach((ticket) => {
    const combos = comb(ticket.selections, ticket.pass);
    let payout = 0;
    combos.forEach((c) => {
      const ok = c.every((sel) => selectionWins(sel, results[sel.matchId]));
      if (ok) payout += c.reduce((p, s) => p * s.odds, 1) * ticket.amount * ticket.times;
    });
    ticket.settled = true;
    ticket.settledAt = new Date().toISOString();
    ticket.results = results;
    ticket.winAmount = round2(payout);
    ticket.profit = round2(ticket.winAmount - ticket.totalMoney);
    roundBet += ticket.totalMoney;
    roundReturn += ticket.winAmount;
  });

  roundBet = round2(roundBet);
  roundReturn = round2(roundReturn);
  db.totalReturn = round2(db.totalReturn + roundReturn);
  db.history.push({
    time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
    result: forced,
    bet: roundBet,
    ret: roundReturn,
    profit: round2(roundReturn - roundBet),
  });
  db.history = db.history.slice(-50);
  saveDb();
  broadcast();
  return { settled: pending.length, roundBet, roundReturn };
}

function randomDemoSelection(play, match) {
  const opts = optionList(play, match);
  const opt = opts[Math.floor(Math.random() * opts.length)];
  return { matchId: match.id, playType: play, value: opt.value };
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".md": "text/markdown; charset=utf-8",
  }[ext] || "application/octet-stream";
}

function serveStatic(req, res, pathname) {
  const safePath = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(ROOT, safePath === "/" ? "index.html" : safePath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, "index.html");
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mimeType(filePath), "Cache-Control": "public, max-age=60" });
    res.end(buf);
  });
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, serverTime: new Date().toISOString() });
    return;
  }

  if (url.pathname === "/api/state") {
    sendJson(res, 200, publicState(url.searchParams.get("clientId") || ""));
    return;
  }

  if (url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`data: ${JSON.stringify(publicState(url.searchParams.get("clientId") || ""))}\n\n`);
    sseClients.set(res, url.searchParams.get("clientId") || "");
    req.on("close", () => sseClients.delete(res));
    return;
  }

  try {
    if (url.pathname === "/api/bets" && req.method === "POST") {
      const body = await readBody(req);
      const ticket = createTicket(body.clientId, body.selections, body.pass, body.times, body.amount);
      sendJson(res, 200, { ok: true, ticket, state: publicState(body.clientId) });
      return;
    }

    if (url.pathname === "/api/settle" && req.method === "POST") {
      const body = await readBody(req);
      const result = ["win", "draw", "loss", "random"].includes(body.result) ? body.result : "random";
      const settled = settlePending(result);
      sendJson(res, 200, { ok: true, ...settled, state: publicState(body.clientId) });
      return;
    }

    if (url.pathname === "/api/demo/auto" && req.method === "POST") {
      const body = await readBody(req);
      const rounds = Math.max(1, Math.min(50, Number(body.rounds) || 10));
      const createdIds = [];
      for (let i = 0; i < rounds; i += 1) {
        const count = 1 + Math.floor(Math.random() * 3);
        const play = Math.random() < 0.45 ? "score" : (Math.random() < 0.7 ? "spf" : "goals");
        const shuffled = [...db.matches].sort(() => Math.random() - 0.5).slice(0, count);
        const selections = shuffled.map((match) => randomDemoSelection(play, match));
        const pass = count > 1 && Math.random() < 0.55 ? 2 : 1;
        const times = 1 + Math.floor(Math.random() * 4);
        const ticket = createTicket(body.clientId || "auto-demo", selections, pass, times, 2);
        createdIds.push(ticket.id);
      }
      const settled = settlePending("random", createdIds);
      sendJson(res, 200, { ok: true, created: createdIds.length, ...settled, state: publicState(body.clientId) });
      return;
    }

    if (url.pathname === "/api/admin/odds" && req.method === "POST") {
      updateOddsTick();
      sendJson(res, 200, { ok: true, state: publicState() });
      return;
    }
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message || "请求失败" });
    return;
  }

  sendJson(res, 404, { ok: false, error: "API 不存在" });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url);
    return;
  }
  serveStatic(req, res, url.pathname);
});

saveDb();
server.listen(PORT, HOST, () => {
  console.log(`命运气象站多人实时版已启动：http://127.0.0.1:${PORT}/`);
});

setInterval(updateOddsTick, 45 * 1000);
