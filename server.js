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
 * - 当前赔率、赛程和开奖为课程演示用模拟数据；后续可把 refreshDailyMatches()
 *   和 updateOddsTick() 替换成真实接口。
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
loadLocalEnv(path.join(ROOT, ".env"));
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || "0.0.0.0";
const DAILY_REFRESH_HOUR = Number(process.env.DAILY_REFRESH_HOUR || 8);
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN || "";
const FOOTBALL_DATA_BASE = "https://api.football-data.org/v4";
const FOOTBALL_DATA_DAILY_LIMIT = Number(process.env.FOOTBALL_DATA_DAILY_LIMIT || 10);
const FOOTBALL_DATA_MATCH_DAYS = Number(process.env.FOOTBALL_DATA_MATCH_DAYS || 2);
const FOOTBALL_DATA_COMPETITIONS = (process.env.FOOTBALL_DATA_COMPETITIONS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const ODDS_API_KEY = process.env.ODDS_API_KEY || process.env.THE_ODDS_API_KEY || "";
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";
const ODDS_API_REGIONS = process.env.ODDS_API_REGIONS || "eu";
const ODDS_API_MARKETS = process.env.ODDS_API_MARKETS || "h2h";
const ODDS_API_DAILY_LIMIT = Number(process.env.ODDS_API_DAILY_LIMIT || 8);
const ODDS_API_MONTHLY_LIMIT = Number(process.env.ODDS_API_MONTHLY_LIMIT || 450);
const ODDS_API_MAX_SPORTS_PER_REFRESH = Number(process.env.ODDS_API_MAX_SPORTS_PER_REFRESH || 3);
const ODDS_API_SPORTS = (process.env.ODDS_API_SPORTS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

function loadLocalEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    value = value.replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const teamPool = [
  "葡萄牙", "西班牙", "美国", "比利时", "日本", "韩国", "巴西", "德国",
  "法国", "荷兰", "英格兰", "阿根廷", "意大利", "克罗地亚", "墨西哥", "乌拉圭",
  "丹麦", "瑞士", "摩洛哥", "塞内加尔", "澳大利亚", "加拿大", "哥伦比亚", "智利",
];

const leaguePool = ["世界杯", "欧洲杯", "亚洲杯", "美洲杯", "欧国联", "友谊赛", "俱乐部杯"];

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

function dateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function seededRandom(seedText) {
  let seed = 2166136261;
  for (let i = 0; i < seedText.length; i += 1) {
    seed ^= seedText.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  return () => {
    seed += 0x6D2B79F5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weekdayCn(date) {
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
}

function generateDailyMatches(baseDate = new Date()) {
  const key = dateKey(baseDate);
  const random = seededRandom(key);
  const usedTeams = new Set();
  const matches = [];
  const times = ["10:30", "15:00", "18:30", "21:00", "23:30", "02:00"];
  for (let i = 0; i < 6; i += 1) {
    const dayOffset = i < 4 ? 0 : 1;
    const matchDate = new Date(baseDate);
    matchDate.setDate(baseDate.getDate() + dayOffset);
    const available = teamPool.filter((team) => !usedTeams.has(team));
    const home = available[Math.floor(random() * available.length)] || teamPool[Math.floor(random() * teamPool.length)];
    usedTeams.add(home);
    const availableAway = teamPool.filter((team) => team !== home && !usedTeams.has(team));
    const away = availableAway[Math.floor(random() * availableAway.length)] || teamPool.filter((team) => team !== home)[Math.floor(random() * (teamPool.length - 1))];
    usedTeams.add(away);
    const homeOdd = 1.55 + random() * 2.25;
    const drawOdd = 2.85 + random() * 1.35;
    const awayOdd = 1.75 + random() * 2.7;
    matches.push({
      id: Number(`${String(matchDate.getMonth() + 1).padStart(2, "0")}${String(matchDate.getDate()).padStart(2, "0")}${String(i + 1).padStart(2, "0")}`),
      code: `${weekdayCn(matchDate)}${String(i + 1).padStart(3, "0")}`,
      league: leaguePool[Math.floor(random() * leaguePool.length)],
      time: `${String(matchDate.getMonth() + 1).padStart(2, "0")}-${String(matchDate.getDate()).padStart(2, "0")} ${times[i]}`,
      home,
      away,
      odds: [homeOdd, drawOdd, awayOdd].map(clampOdds),
    });
  }
  return matches;
}

function apiUsageDefaults() {
  return {
    date: dateKey(),
    used: 0,
    limit: FOOTBALL_DATA_DAILY_LIMIT,
    lastRequestAt: "",
    lastStatus: "not-configured",
    lastError: "",
    remainingMinute: null,
  };
}

function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function oddsApiUsageDefaults() {
  return {
    date: dateKey(),
    month: monthKey(),
    usedToday: 0,
    usedMonthLocal: 0,
    dailyLimit: ODDS_API_DAILY_LIMIT,
    monthlyLimit: ODDS_API_MONTHLY_LIMIT,
    lastRequestAt: "",
    lastStatus: ODDS_API_KEY ? "ready" : "not-configured",
    lastError: "",
    headerRemaining: null,
    headerUsed: null,
    headerLast: null,
  };
}

function normalizeApiUsage() {
  db.apiUsage = { ...apiUsageDefaults(), ...(db.apiUsage || {}) };
  if (db.apiUsage.date !== dateKey()) {
    db.apiUsage = apiUsageDefaults();
  }
  db.apiUsage.limit = FOOTBALL_DATA_DAILY_LIMIT;
}

function normalizeOddsApiUsage() {
  db.oddsApiUsage = { ...oddsApiUsageDefaults(), ...(db.oddsApiUsage || {}) };
  if (db.oddsApiUsage.date !== dateKey()) {
    db.oddsApiUsage.date = dateKey();
    db.oddsApiUsage.usedToday = 0;
  }
  if (db.oddsApiUsage.month !== monthKey()) {
    db.oddsApiUsage.month = monthKey();
    db.oddsApiUsage.usedMonthLocal = 0;
    db.oddsApiUsage.headerRemaining = null;
    db.oddsApiUsage.headerUsed = null;
  }
  db.oddsApiUsage.dailyLimit = ODDS_API_DAILY_LIMIT;
  db.oddsApiUsage.monthlyLimit = ODDS_API_MONTHLY_LIMIT;
}

function canUseOddsApi(estimatedCredits = 1) {
  normalizeOddsApiUsage();
  if (!ODDS_API_KEY) {
    db.oddsApiUsage.lastStatus = "missing-token";
    db.oddsApiUsage.lastError = "ODDS_API_KEY 未配置";
    return false;
  }
  if (db.oddsApiUsage.usedToday + estimatedCredits > ODDS_API_DAILY_LIMIT) {
    db.oddsApiUsage.lastStatus = "daily-limit-reached";
    db.oddsApiUsage.lastError = `已达到 The Odds API 每日自设上限 ${ODDS_API_DAILY_LIMIT}`;
    return false;
  }
  if (db.oddsApiUsage.usedMonthLocal + estimatedCredits > ODDS_API_MONTHLY_LIMIT) {
    db.oddsApiUsage.lastStatus = "monthly-limit-reached";
    db.oddsApiUsage.lastError = `已达到 The Odds API 月度自设上限 ${ODDS_API_MONTHLY_LIMIT}`;
    return false;
  }
  const remaining = Number(db.oddsApiUsage.headerRemaining);
  if (Number.isFinite(remaining) && remaining > 0 && remaining < estimatedCredits) {
    db.oddsApiUsage.lastStatus = "provider-limit-low";
    db.oddsApiUsage.lastError = `官方返回剩余额度不足：${remaining}`;
    return false;
  }
  return true;
}

function reserveOddsCredits(estimatedCredits = 1, purpose = "unknown") {
  normalizeOddsApiUsage();
  db.oddsApiUsage.usedToday += estimatedCredits;
  db.oddsApiUsage.usedMonthLocal += estimatedCredits;
  db.oddsApiUsage.lastRequestAt = new Date().toISOString();
  db.oddsApiUsage.lastPurpose = purpose;
  saveDb();
}

function applyOddsApiHeaders(res, estimatedCredits = 1) {
  const remaining = res.headers.get("x-requests-remaining");
  const used = res.headers.get("x-requests-used");
  const last = res.headers.get("x-requests-last");
  db.oddsApiUsage.headerRemaining = remaining;
  db.oddsApiUsage.headerUsed = used;
  db.oddsApiUsage.headerLast = last;
  const lastCredits = Number(last);
  if (Number.isFinite(lastCredits) && lastCredits >= 0 && lastCredits !== estimatedCredits) {
    const delta = lastCredits - estimatedCredits;
    db.oddsApiUsage.usedToday = Math.max(0, db.oddsApiUsage.usedToday + delta);
    db.oddsApiUsage.usedMonthLocal = Math.max(0, db.oddsApiUsage.usedMonthLocal + delta);
  }
}

async function oddsApiFetch(pathname, params = {}, purpose = "unknown", estimatedCredits = 1) {
  if (!canUseOddsApi(estimatedCredits)) {
    saveDb();
    return null;
  }
  reserveOddsCredits(estimatedCredits, purpose);
  const url = new URL(`${ODDS_API_BASE}${pathname}`);
  url.searchParams.set("apiKey", ODDS_API_KEY);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  try {
    const res = await fetch(url);
    applyOddsApiHeaders(res, estimatedCredits);
    db.oddsApiUsage.lastHttpStatus = res.status;
    if (!res.ok) {
      const text = await res.text();
      db.oddsApiUsage.lastStatus = "http-error";
      db.oddsApiUsage.lastError = `${res.status} ${text.slice(0, 180)}`;
      saveDb();
      return null;
    }
    const data = await res.json();
    db.oddsApiUsage.lastStatus = "ok";
    db.oddsApiUsage.lastError = "";
    saveDb();
    return data;
  } catch (err) {
    db.oddsApiUsage.lastStatus = "network-error";
    db.oddsApiUsage.lastError = err.message || "The Odds API 请求失败";
    saveDb();
    return null;
  }
}

function canUseFootballDataApi() {
  normalizeApiUsage();
  return Boolean(FOOTBALL_DATA_TOKEN) && db.apiUsage.used < FOOTBALL_DATA_DAILY_LIMIT;
}

async function footballDataFetch(pathname, purpose = "unknown") {
  normalizeApiUsage();
  if (!FOOTBALL_DATA_TOKEN) {
    db.apiUsage.lastStatus = "missing-token";
    db.apiUsage.lastError = "FOOTBALL_DATA_TOKEN 未配置";
    saveDb();
    return null;
  }
  if (db.apiUsage.used >= FOOTBALL_DATA_DAILY_LIMIT) {
    db.apiUsage.lastStatus = "daily-limit-reached";
    db.apiUsage.lastError = `已达到每日调用上限 ${FOOTBALL_DATA_DAILY_LIMIT}`;
    saveDb();
    return null;
  }

  const url = `${FOOTBALL_DATA_BASE}${pathname}`;
  db.apiUsage.used += 1;
  db.apiUsage.lastRequestAt = new Date().toISOString();
  db.apiUsage.lastPurpose = purpose;
  saveDb();

  try {
    const res = await fetch(url, {
      headers: { "X-Auth-Token": FOOTBALL_DATA_TOKEN },
    });
    db.apiUsage.remainingMinute = res.headers.get("x-requests-available-minute");
    db.apiUsage.lastHttpStatus = res.status;
    if (!res.ok) {
      const text = await res.text();
      db.apiUsage.lastStatus = "http-error";
      db.apiUsage.lastError = `${res.status} ${text.slice(0, 180)}`;
      saveDb();
      return null;
    }
    const data = await res.json();
    db.apiUsage.lastStatus = "ok";
    db.apiUsage.lastError = "";
    saveDb();
    return data;
  } catch (err) {
    db.apiUsage.lastStatus = "network-error";
    db.apiUsage.lastError = err.message || "网络请求失败";
    saveDb();
    return null;
  }
}

function makeDemoOddsFromRealMatch(match) {
  const seedText = `${match.id || ""}-${match.homeTeam?.name || ""}-${match.awayTeam?.name || ""}`;
  const random = seededRandom(seedText);
  const statusBias = match.status === "IN_PLAY" || match.status === "PAUSED" ? 0.86 : 1;
  const homeOdd = (1.55 + random() * 2.2) * statusBias;
  const drawOdd = 2.75 + random() * 1.55;
  const awayOdd = (1.65 + random() * 2.5) * statusBias;
  return [homeOdd, drawOdd, awayOdd].map(clampOdds);
}

function mapFootballDataMatch(match, index = 0) {
  const utcDate = match.utcDate ? new Date(match.utcDate) : new Date();
  const mm = String(utcDate.getMonth() + 1).padStart(2, "0");
  const dd = String(utcDate.getDate()).padStart(2, "0");
  const hh = String(utcDate.getHours()).padStart(2, "0");
  const min = String(utcDate.getMinutes()).padStart(2, "0");
  const score = match.score?.fullTime;
  const half = match.score?.halfTime;
  let realResult = null;
  if (match.status === "FINISHED" && Number.isFinite(score?.home) && Number.isFinite(score?.away)) {
    const outcome = score.home > score.away ? "win" : score.home === score.away ? "draw" : "loss";
    realResult = {
      outcome,
      score: `${score.home}:${score.away}`,
      totalGoals: Math.min(score.home + score.away, 7),
      half: Number.isFinite(half?.home) && Number.isFinite(half?.away)
        ? `${half.home > half.away ? "胜" : half.home === half.away ? "平" : "负"}${outcome === "win" ? "胜" : outcome === "draw" ? "平" : "负"}`
        : null,
    };
  }
  return {
    id: Number(match.id) || Number(`${mm}${dd}${String(index + 1).padStart(2, "0")}`),
    realMatchId: match.id,
    code: `${weekdayCn(utcDate)}${String(index + 1).padStart(3, "0")}`,
    league: match.competition?.name || match.area?.name || "真实赛程",
    time: `${mm}-${dd} ${hh}:${min}`,
    home: match.homeTeam?.shortName || match.homeTeam?.name || "主队",
    away: match.awayTeam?.shortName || match.awayTeam?.name || "客队",
    status: match.status || "SCHEDULED",
    odds: makeDemoOddsFromRealMatch(match),
    realResult,
  };
}

async function fetchRealMatchesFromApi() {
  const from = dateKey();
  const toDate = new Date();
  toDate.setDate(toDate.getDate() + Math.max(0, FOOTBALL_DATA_MATCH_DAYS - 1));
  const params = new URLSearchParams({ dateFrom: from, dateTo: dateKey(toDate) });
  if (FOOTBALL_DATA_COMPETITIONS.length) params.set("competitions", FOOTBALL_DATA_COMPETITIONS.join(","));
  const data = await footballDataFetch(`/matches?${params.toString()}`, "matches");
  if (!data || !Array.isArray(data.matches)) return [];
  return data.matches.map(mapFootballDataMatch).slice(0, 12);
}

function extractH2HOdds(event) {
  const market = event.bookmakers
    ?.flatMap((bookmaker) => bookmaker.markets || [])
    ?.find((item) => item.key === "h2h");
  const outcomes = market?.outcomes || [];
  const home = outcomes.find((item) => item.name === event.home_team)?.price;
  const away = outcomes.find((item) => item.name === event.away_team)?.price;
  const draw = outcomes.find((item) => /draw/i.test(item.name))?.price;
  if (!Number.isFinite(Number(home)) || !Number.isFinite(Number(away))) return null;
  return [Number(home), Number(draw || 3.2), Number(away)].map(clampOdds);
}

function mapOddsApiEvent(event, index = 0) {
  const date = event.commence_time ? new Date(event.commence_time) : new Date();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return {
    id: Number(String(event.id || "").replace(/\D/g, "").slice(0, 12)) || Number(`${mm}${dd}${String(index + 1).padStart(2, "0")}`),
    oddsEventId: event.id,
    code: `${weekdayCn(date)}${String(index + 1).padStart(3, "0")}`,
    league: event.sport_title || event.sport_key || "赔率赛程",
    time: `${mm}-${dd} ${hh}:${min}`,
    home: event.home_team || "主队",
    away: event.away_team || "客队",
    status: "SCHEDULED",
    odds: extractH2HOdds(event) || [2.1, 3.2, 3.1],
  };
}

async function discoverSoccerSportsFromOddsApi() {
  if (ODDS_API_SPORTS.length) return ODDS_API_SPORTS.slice(0, ODDS_API_MAX_SPORTS_PER_REFRESH);
  // The Odds API 文档说明 /sports 不消耗使用额度；仍然只在刷新赛程时调用。
  const url = new URL(`${ODDS_API_BASE}/sports`);
  url.searchParams.set("apiKey", ODDS_API_KEY);
  try {
    const res = await fetch(url);
    if (!res.ok) return ["soccer_epl"];
    const sports = await res.json();
    return (Array.isArray(sports) ? sports : [])
      .filter((sport) => sport.active && String(sport.key || "").startsWith("soccer_"))
      .map((sport) => sport.key)
      .slice(0, ODDS_API_MAX_SPORTS_PER_REFRESH);
  } catch {
    return ["soccer_epl"];
  }
}

async function fetchOddsMatchesFromApi() {
  const sports = await discoverSoccerSportsFromOddsApi();
  const regions = ODDS_API_REGIONS;
  const markets = ODDS_API_MARKETS;
  const estimatedPerSport = Math.max(1, regions.split(",").filter(Boolean).length * markets.split(",").filter(Boolean).length);
  const events = [];
  for (const sportKey of sports) {
    if (!canUseOddsApi(estimatedPerSport)) break;
    const data = await oddsApiFetch(
      `/sports/${encodeURIComponent(sportKey)}/odds`,
      {
        regions,
        markets,
        oddsFormat: "decimal",
        dateFormat: "iso",
      },
      `odds:${sportKey}`,
      estimatedPerSport,
    );
    if (Array.isArray(data)) events.push(...data);
  }
  return events
    .filter((event) => event.home_team && event.away_team && event.commence_time)
    .sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time))
    .slice(0, 12)
    .map(mapOddsApiEvent);
}

const defaultDb = () => ({
  version: 2,
  matchDate: dateKey(),
  matchSource: ODDS_API_KEY ? "the-odds-api" : FOOTBALL_DATA_TOKEN ? "football-data.org" : "simulated",
  oddsUpdatedAt: new Date().toISOString(),
  matches: generateDailyMatches(),
  options: {
    score: scoreDefaults,
    goals: goalsDefaults,
    half: halfDefaults,
  },
  tickets: [],
  totalBet: 0,
  totalReturn: 0,
  history: [],
  apiUsage: apiUsageDefaults(),
  oddsApiUsage: oddsApiUsageDefaults(),
});

let db = loadDb();
normalizeApiUsage();
normalizeOddsApiUsage();
maybeDailyScheduleRefresh();
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
    matchDate: db.matchDate,
    matchSource: db.matchSource || "simulated",
    apiUsage: {
      date: db.apiUsage?.date,
      used: db.apiUsage?.used || 0,
      limit: FOOTBALL_DATA_DAILY_LIMIT,
      lastStatus: db.apiUsage?.lastStatus || "",
      remainingMinute: db.apiUsage?.remainingMinute ?? null,
    },
    oddsApiUsage: {
      date: db.oddsApiUsage?.date,
      month: db.oddsApiUsage?.month,
      usedToday: db.oddsApiUsage?.usedToday || 0,
      usedMonthLocal: db.oddsApiUsage?.usedMonthLocal || 0,
      dailyLimit: ODDS_API_DAILY_LIMIT,
      monthlyLimit: ODDS_API_MONTHLY_LIMIT,
      headerRemaining: db.oddsApiUsage?.headerRemaining ?? null,
      headerUsed: db.oddsApiUsage?.headerUsed ?? null,
      headerLast: db.oddsApiUsage?.headerLast ?? null,
      lastStatus: db.oddsApiUsage?.lastStatus || "",
    },
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

async function refreshDailyMatches(force = false) {
  const now = new Date();
  const today = dateKey(now);
  const shouldRefresh = force
    || db.matchDate !== today
    || (ODDS_API_KEY && db.matchSource !== "the-odds-api" && canUseOddsApi(1))
    || (!ODDS_API_KEY && FOOTBALL_DATA_TOKEN && db.matchSource === "simulated" && canUseFootballDataApi());
  if (!shouldRefresh) return false;

  // 只刷新“可投注赛程”和赔率；历史投注与全站盈亏继续保留。
  let nextMatches = [];
  if (ODDS_API_KEY && canUseOddsApi(1)) {
    nextMatches = await fetchOddsMatchesFromApi();
  }
  if (!nextMatches.length && canUseFootballDataApi()) {
    nextMatches = await fetchRealMatchesFromApi();
  }
  db.matchDate = today;
  db.matches = nextMatches.length ? nextMatches : generateDailyMatches(now);
  db.matchSource = nextMatches.length
    ? (nextMatches.some((match) => match.oddsEventId) ? "the-odds-api" : "football-data.org")
    : "simulated";
  db.options = {
    score: scoreDefaults.map((opt) => ({ ...opt, odds: jitterOdd(opt.odds) })),
    goals: goalsDefaults.map((opt) => ({ ...opt, odds: jitterOdd(opt.odds) })),
    half: halfDefaults.map((opt) => ({ ...opt, odds: jitterOdd(opt.odds) })),
  };
  db.oddsUpdatedAt = now.toISOString();
  saveDb();
  broadcast();
  console.log(`已刷新 ${today} 可投注赛程，来源：${db.matchSource}`);
  return true;
}

function maybeDailyScheduleRefresh() {
  const now = new Date();
  if (now.getHours() >= DAILY_REFRESH_HOUR) {
    refreshDailyMatches(false).catch((err) => console.error("每日赛程刷新失败：", err));
  }
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
    const realMatch = db.matches.find((match) => Number(match.id) === Number(id) && match.realResult);
    if (forced === "real" && realMatch?.realResult) {
      results[id] = {
        ...realMatch.realResult,
        half: realMatch.realResult.half || randomHalf(realMatch.realResult.outcome),
      };
      return;
    }
    const outcome = forced === "random" ? weightedOutcome() : forced;
    const score = randomScoreFor(outcome);
    const totalGoals = score.split(":").map(Number).reduce((a, b) => a + b, 0);
    results[id] = { outcome, score, totalGoals: Math.min(totalGoals, 7), half: randomHalf(outcome) };
  });
  return results;
}

async function syncRealResultsFromApi() {
  if (!canUseFootballDataApi()) return false;
  const realMatches = await fetchRealMatchesFromApi();
  if (!realMatches.length) return false;
  const byRealId = new Map(realMatches.map((match) => [String(match.realMatchId || match.id), match]));
  db.matches = db.matches.map((match) => {
    const latest = byRealId.get(String(match.realMatchId || match.id));
    return latest ? { ...match, status: latest.status, realResult: latest.realResult } : match;
  });
  db.oddsUpdatedAt = new Date().toISOString();
  saveDb();
  broadcast();
  return true;
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
  const pending = db.tickets.filter((ticket) => {
    if (ticket.settled || (allow && !allow.has(ticket.id))) return false;
    if (forced !== "real") return true;
    return ticket.selections.every((selection) => db.matches.some((match) => Number(match.id) === Number(selection.matchId) && match.realResult));
  });
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
      const result = ["win", "draw", "loss", "random", "real"].includes(body.result) ? body.result : "random";
      if (result === "real") await syncRealResultsFromApi();
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

    if (url.pathname === "/api/admin/odds-api" && req.method === "POST") {
      const matches = await fetchOddsMatchesFromApi();
      if (matches.length) {
        db.matches = matches;
        db.matchDate = dateKey();
        db.matchSource = "the-odds-api";
        db.oddsUpdatedAt = new Date().toISOString();
        saveDb();
        broadcast();
      }
      sendJson(res, 200, { ok: true, updated: matches.length, state: publicState() });
      return;
    }

    if (url.pathname === "/api/admin/matches" && req.method === "POST") {
      await refreshDailyMatches(true);
      sendJson(res, 200, { ok: true, state: publicState() });
      return;
    }

    if (url.pathname === "/api/admin/results" && req.method === "POST") {
      const synced = await syncRealResultsFromApi();
      const settled = settlePending("real");
      sendJson(res, 200, { ok: true, synced, ...settled, state: publicState() });
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
setInterval(maybeDailyScheduleRefresh, 60 * 60 * 1000);
