import { Router, type IRouter } from "express";

const router: IRouter = Router();

const CFBD_BASE_URL = "https://api.collegefootballdata.com";
const MSU = "Michigan State";
const DEFAULT_YEAR = 2026;
const CACHE_TTL_MS = 5 * 60 * 1000;

type AnyRecord = Record<string, unknown>;

type DashboardData = {
  generated_at: string;
  source: {
    provider: "CFBD";
    season: number;
    fetched_at: string;
    cached: boolean;
  };
  record: { wins: number; losses: number };
  matrix: {
    all: Array<{
      bucket: string;
      sub: string;
      plays: number;
      rate: number;
      epa: number;
    }>;
  };
  special_teams: {
    punts: Array<{ opp: string; net: number }>;
    field_position: Array<{ opp: string; msu: number | null; vs: number | null }>;
  };
  games: Array<{
    opp: string;
    tag: string;
    result: "W" | "L";
    score: string;
    wp: number[];
    swings: Array<{ time: string; desc: string; wpa: number }>;
  }>;
  team: {
    id: number | null;
    school: string;
    abbreviation: string;
    conference: string;
    color: string | null;
    logo: string | null;
    location: string | null;
  } | null;
  schedule: Array<{
    id: number | null;
    week: number | null;
    date: string | null;
    opponent: string;
    homeAway: "home" | "away" | "neutral";
    venue: string | null;
    status: "completed" | "scheduled";
    result: "W" | "L" | null;
    msuScore: number | null;
    opponentScore: number | null;
  }>;
  seasonStats: Record<string, string>;
  advancedSeason: AnyRecord | null;
  roster: Array<{
    id: string;
    name: string;
    position: string | null;
    jersey: number | null;
    classYear: number | null;
  }>;
};

type CacheEntry = { expiresAt: number; data: DashboardData };
const cache = new Map<number, CacheEntry>();

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" ? (value as AnyRecord) : {};
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function value(record: AnyRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function teamTag(team: string): string {
  const normalized = team.replace(/[^a-zA-Z]/g, "").toUpperCase();
  return normalized.slice(0, 3) || "OPP";
}

function isMsuGame(game: AnyRecord): boolean {
  return text(value(game, "homeTeam", "home_team")) === MSU ||
    text(value(game, "awayTeam", "away_team")) === MSU;
}

function isCompleted(game: AnyRecord): boolean {
  if (typeof game.completed === "boolean") return game.completed;
  return asNumber(value(game, "homePoints", "home_points")) !== null &&
    asNumber(value(game, "awayPoints", "away_points")) !== null;
}

function bucketFor(down: number, distance: number): string | null {
  if (down === 1 && distance >= 7) return "1st & 10";
  if (down === 2 && distance >= 4 && distance <= 6) return "2nd & Medium";
  if ((down === 3 || down === 4) && distance >= 1 && distance <= 3) return "3rd & Short";
  if ((down === 3 || down === 4) && distance >= 7) return "3rd & Long";
  return null;
}

function successTarget(down: number, distance: number): number {
  if (down === 1) return 0.5;
  if (down === 2) return distance >= 4 ? 0.5 : 0.6;
  return 1;
}

function buildMatrix(plays: AnyRecord[]) {
  const subtitles: Record<string, string> = {
    "1st & 10": "Standard down",
    "2nd & Medium": "4–6 yds to go",
    "3rd & Short": "1–3 yds to go",
    "3rd & Long": "7+ yds to go",
  };
  const aggregate = new Map<string, { plays: number; successes: number; epa: number }>();

  for (const play of plays) {
    const offense = text(value(play, "offense"));
    if (offense && offense !== MSU) continue;
    const down = asNumber(value(play, "down"));
    const distance = asNumber(value(play, "distance"));
    const gained = asNumber(value(play, "yardsGained", "yards_gained"));
    if (down === null || distance === null || gained === null) continue;
    const bucket = bucketFor(down, distance);
    if (!bucket) continue;
    const row = aggregate.get(bucket) ?? { plays: 0, successes: 0, epa: 0 };
    row.plays += 1;
    row.successes += gained >= successTarget(down, distance) * distance ? 1 : 0;
    row.epa += asNumber(value(play, "ppa", "epa")) ?? 0;
    aggregate.set(bucket, row);
  }

  return [...aggregate.entries()].map(([bucket, row]) => ({
    bucket,
    sub: subtitles[bucket] ?? "",
    plays: row.plays,
    rate: row.plays ? Number((row.successes / row.plays).toFixed(3)) : 0,
    epa: row.plays ? Number((row.epa / row.plays).toFixed(2)) : 0,
  }));
}

function gameId(game: AnyRecord): number | null {
  return asNumber(value(game, "gameId", "game_id", "id"));
}

function gameOpponent(game: AnyRecord): { name: string; tag: string; isHome: boolean } {
  const home = text(value(game, "homeTeam", "home_team"));
  const away = text(value(game, "awayTeam", "away_team"));
  const isHome = home === MSU;
  const name = isHome ? away : home;
  return { name, tag: teamTag(name), isHome };
}

function isMsuOffense(play: AnyRecord): boolean {
  const offense = text(value(play, "offense"));
  return !offense || offense === MSU;
}

function buildPunts(games: AnyRecord[], plays: AnyRecord[][]) {
  return games.map((game, index) => {
    const opponent = gameOpponent(game);
    const punts = (plays[index] ?? []).filter((play) => {
      const type = text(value(play, "playType", "play_type")).toLowerCase();
      return isMsuOffense(play) && type.includes("punt");
    });
    const netValues = punts
      .map((punt) => {
        const puntText = text(value(punt, "playText", "play_text"));
        const distance = puntText.match(/\bpunt\s+(\d+)\s+yards?\b/i)?.[1];
        const returned = puntText.match(/\breturn\s+(\d+)\s+yards?\b/i)?.[1];
        const measured = asNumber(value(punt, "yardsGained", "yards_gained"));
        if (distance) return Number(distance) - (returned ? Number(returned) : 0);
        return measured;
      })
      .filter((yards): yards is number => yards !== null);
    return { opp: opponent.tag, net: netValues.length ? Number((netValues.reduce((a, b) => a + b, 0) / netValues.length).toFixed(1)) : 0 };
  });
}

function average(values: number[]): number | null {
  return values.length ? Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(1)) : null;
}

function buildFieldPosition(games: AnyRecord[], drives: AnyRecord[][]) {
  return games.map((game, index) => {
    const opponent = gameOpponent(game);
    const gameDrives = drives[index] ?? [];
    const msuStarts = gameDrives
      .filter((drive) => text(value(drive, "offense")) === MSU)
      .map((drive) => asNumber(value(drive, "startYardsToGoal", "start_yards_to_goal")))
      .filter((yards): yards is number => yards !== null);
    const opponentStarts = gameDrives
      .filter((drive) => text(value(drive, "offense")) !== "" && text(value(drive, "offense")) !== MSU)
      .map((drive) => asNumber(value(drive, "startYardsToGoal", "start_yards_to_goal")))
      .filter((yards): yards is number => yards !== null);
    return { opp: opponent.tag, msu: average(msuStarts), vs: average(opponentStarts) };
  });
}

function formatClock(value: unknown): string {
  const clock = asRecord(value);
  const minutes = asNumber(clock.minutes);
  const seconds = asNumber(clock.seconds);
  if (minutes === null || seconds === null) return "";
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function normalizeSchedule(games: AnyRecord[]) {
  return games.map((game) => {
    const opponent = gameOpponent(game);
    const homePoints = asNumber(value(game, "homePoints", "home_points"));
    const awayPoints = asNumber(value(game, "awayPoints", "away_points"));
    const msuScore = opponent.isHome ? homePoints : awayPoints;
    const opponentScore = opponent.isHome ? awayPoints : homePoints;
    const completed = isCompleted(game);
    return {
      id: gameId(game),
      week: asNumber(value(game, "week")),
      date: text(value(game, "startDate", "start_date"), null as unknown as string) || null,
      opponent: opponent.name,
      homeAway: value(game, "neutralSite", "neutral_site") === true ? "neutral" as const : opponent.isHome ? "home" as const : "away" as const,
      venue: text(value(game, "venue"), null as unknown as string) || null,
      status: completed ? "completed" as const : "scheduled" as const,
      result: completed && msuScore !== null && opponentScore !== null ? (msuScore >= opponentScore ? "W" as const : "L" as const) : null,
      msuScore,
      opponentScore,
    };
  });
}

function normalizeSeasonStats(stats: AnyRecord[]) {
  return Object.fromEntries(
    stats
      .map((stat) => [text(value(stat, "statName", "stat_name")), text(value(stat, "statValue", "stat_value"))] as const)
      .filter(([name]) => Boolean(name)),
  );
}

function normalizeRoster(roster: AnyRecord[]) {
  return roster.map((player) => ({
    id: text(value(player, "id"), ""),
    name: `${text(value(player, "firstName", "first_name"))} ${text(value(player, "lastName", "last_name"))}`.trim() || text(value(player, "name"), "Unknown player"),
    position: text(value(player, "position"), null as unknown as string) || null,
    jersey: asNumber(value(player, "jersey")),
    classYear: asNumber(value(player, "year")),
  })).filter((player) => player.id);
}

async function optionalCfbdGet(path: string, query: Record<string, string | number | undefined>): Promise<unknown | null> {
  try {
    return await cfbdGet(path, query);
  } catch {
    return null;
  }
}

function buildGameShell(game: AnyRecord) {
  const opponent = gameOpponent(game);
  const homePoints = asNumber(value(game, "homePoints", "home_points")) ?? 0;
  const awayPoints = asNumber(value(game, "awayPoints", "away_points")) ?? 0;
  const msuPoints = opponent.isHome ? homePoints : awayPoints;
  const opponentPoints = opponent.isHome ? awayPoints : homePoints;
  return {
    opp: opponent.name,
    tag: opponent.tag,
    result: msuPoints >= opponentPoints ? "W" as const : "L" as const,
    score: `${msuPoints}-${opponentPoints}`,
  };
}

async function cfbdGet(path: string, query: Record<string, string | number | undefined>): Promise<unknown> {
  const apiKey = process.env.CFBD_API_KEY;
  if (!apiKey) {
    const error = new Error("CFBD_API_KEY is not configured");
    error.name = "MissingCfbdKey";
    throw error;
  }
  const url = new URL(`${CFBD_BASE_URL}${path}`);
  for (const [key, queryValue] of Object.entries(query)) {
    if (queryValue !== undefined) url.searchParams.set(key, String(queryValue));
  }
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`CFBD ${response.status} on ${path}: ${body.slice(0, 240)}`);
  }
  return response.json();
}

async function buildDashboardData(year: number): Promise<DashboardData> {
  const gamesResponse = await cfbdGet("/games", { year, team: MSU });
  const rawGames = Array.isArray(gamesResponse) ? gamesResponse : [];
  const games = (rawGames as unknown[]).map(asRecord).filter(isMsuGame).filter(isCompleted);
  const [teamsResponse, statsResponse, advancedResponse, rosterResponse] = await Promise.all([
    optionalCfbdGet("/teams", { year }),
    optionalCfbdGet("/stats/season", { year, team: MSU }),
    optionalCfbdGet("/stats/season/advanced", { year, team: MSU, excludeGarbageTime: "true" }),
    optionalCfbdGet("/roster", { year, team: MSU }),
  ]);
  const weekData = await Promise.all(
    games.map(async (game) => {
      const week = asNumber(value(game, "week"));
      const [allWeekPlays, allWeekDrives] = await Promise.all([
        cfbdGet("/plays", { year, week: week ?? undefined, team: MSU }),
        cfbdGet("/drives", { year, week: week ?? undefined, team: MSU }),
      ]);
      const id = gameId(game);
      const plays = (Array.isArray(allWeekPlays) ? allWeekPlays : [])
        .map(asRecord)
        .filter((play) => id === null || gameId(play) === null || gameId(play) === id);
      const drives = (Array.isArray(allWeekDrives) ? allWeekDrives : [])
        .map(asRecord)
        .filter((drive) => id === null || gameId(drive) === null || gameId(drive) === id);
      return { plays, drives };
    }),
  );
  const weekPlays = weekData.map((item) => item.plays);
  const weekDrives = weekData.map((item) => item.drives);
  const allPlays = weekPlays.flat();
  const wins = games.filter((game) => buildGameShell(game).result === "W").length;

  const enrichedGames = await Promise.all(games.map(async (game, index) => {
    const shell = buildGameShell(game);
    const id = gameId(game);
    let probability: AnyRecord[] = [];
    if (id !== null) {
      const rawProbability = await cfbdGet("/metrics/wp", { gameId: id });
      probability = Array.isArray(rawProbability) ? rawProbability.map(asRecord) : [];
    }
    const wp = probability.map((point) => {
      const homeProbability = asNumber(value(point, "homeWinProbability", "home_win_probability"));
      if (homeProbability === null) return null;
      return Number(((shell.opp && gameOpponent(game).isHome ? homeProbability : 1 - homeProbability) * 100).toFixed(1));
    }).filter((point): point is number => point !== null);
    const trace = wp.length
      ? Array.from({ length: 61 }, (_, minute) => wp[Math.min(wp.length - 1, Math.round((minute / 60) * (wp.length - 1)))])
      : [50];
    const swings = probability
      .map((point, pointIndex) => {
        const homeProbability = asNumber(value(point, "homeWinProbability", "home_win_probability"));
        if (homeProbability === null || pointIndex === 0) return null;
        const current = (gameOpponent(game).isHome ? homeProbability : 1 - homeProbability) * 100;
        const previousPoint = probability[pointIndex - 1];
        const previousHome = asNumber(value(previousPoint, "homeWinProbability", "home_win_probability"));
        if (previousHome === null) return null;
        const previous = (gameOpponent(game).isHome ? previousHome : 1 - previousHome) * 100;
        return {
          time: formatClock(value(point, "clock")) || `Play ${text(value(point, "playNumber"), "?")}`,
          desc: text(value(point, "playText", "play_text"), "Win probability update"),
          wpa: Number((current - previous).toFixed(1)),
        };
      })
      .filter((swing): swing is { time: string; desc: string; wpa: number } => swing !== null)
      .sort((a, b) => Math.abs(b.wpa) - Math.abs(a.wpa))
      .slice(0, 4);
    return { ...shell, wp: trace, swings };
  }));

  const teams = Array.isArray(teamsResponse) ? teamsResponse.map(asRecord) : [];
  const team = teams.find((item) => text(value(item, "school")) === MSU);
  const rawStats = Array.isArray(statsResponse) ? statsResponse.map(asRecord) : [];
  const rawRoster = Array.isArray(rosterResponse) ? rosterResponse.map(asRecord) : [];
  const rawAdvanced = Array.isArray(advancedResponse) ? advancedResponse.map(asRecord) : [];

  return {
    generated_at: new Date().toISOString(),
    source: { provider: "CFBD", season: year, fetched_at: new Date().toISOString(), cached: false },
    record: { wins, losses: games.length - wins },
    matrix: { all: buildMatrix(allPlays) },
    special_teams: { punts: buildPunts(games, weekPlays), field_position: buildFieldPosition(games, weekDrives) },
    games: enrichedGames,
    team: team ? {
      id: asNumber(value(team, "id")),
      school: text(value(team, "school"), MSU),
      abbreviation: text(value(team, "abbreviation"), "MSU"),
      conference: text(value(team, "conference"), "Big Ten"),
      color: text(value(team, "color"), null as unknown as string) || null,
      logo: Array.isArray(team.logos) && typeof team.logos[0] === "string" ? team.logos[0] : null,
      location: text(asRecord(value(team, "location")).name, null as unknown as string) || null,
    } : null,
    schedule: normalizeSchedule(rawGames.map(asRecord).filter(isMsuGame)),
    seasonStats: normalizeSeasonStats(rawStats),
    advancedSeason: rawAdvanced[0] ?? null,
    roster: normalizeRoster(rawRoster),
  };
}

router.get("/games/:gameId", async (req, res) => {
  const id = asNumber(req.params.gameId);
  const yearValue = asNumber(req.query.year);
  const year = yearValue && yearValue >= 2000 && yearValue <= 2100 ? yearValue : DEFAULT_YEAR;
  if (id === null) return res.status(400).json({ code: "INVALID_GAME_ID", message: "A numeric game id is required." });

  try {
    const gameResponse = await cfbdGet("/games", { id });
    const game = Array.isArray(gameResponse) ? asRecord(gameResponse[0]) : {};
    if (!Object.keys(game).length) return res.status(404).json({ code: "GAME_NOT_FOUND", message: "CFBD returned no game for that id." });
    const week = asNumber(value(game, "week"));
    const [teamStats, playerStats, driveResponse, playResponse, advancedResponse] = await Promise.all([
      cfbdGet("/games/teams", { id }),
      cfbdGet("/games/players", { id }),
      cfbdGet("/drives", { year, week: week ?? undefined, team: MSU }),
      cfbdGet("/plays", { year, week: week ?? undefined, team: MSU }),
      optionalCfbdGet("/stats/game/advanced", { year, team: MSU, week: week ?? undefined, opponent: gameOpponent(game).name }),
    ]);
    const drives = (Array.isArray(driveResponse) ? driveResponse : []).map(asRecord).filter((drive) => gameId(drive) === id);
    const plays = (Array.isArray(playResponse) ? playResponse : []).map(asRecord).filter((play) => gameId(play) === id);
    const requestedPage = asNumber(req.query.page);
    const requestedPageSize = asNumber(req.query.pageSize);
    const pageSize = Math.min(100, Math.max(10, requestedPageSize ?? 50));
    const totalPages = Math.max(1, Math.ceil(plays.length / pageSize));
    const page = Math.min(totalPages, Math.max(1, requestedPage ?? 1));
    const pageStart = (page - 1) * pageSize;
    return res.json({
      source: { provider: "CFBD", season: year, fetched_at: new Date().toISOString() },
      game,
      teamStats: Array.isArray(teamStats) ? teamStats : [],
      playerStats: Array.isArray(playerStats) ? playerStats : [],
      drives,
      plays: plays.slice(pageStart, pageStart + pageSize),
      pagination: { page, pageSize, total: plays.length, totalPages },
      advanced: Array.isArray(advancedResponse) ? advancedResponse.find((item) => asNumber(value(asRecord(item), "gameId", "game_id")) === id) ?? null : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load game data";
    req.log.error({ err: error, gameId: id }, "CFBD game detail failed");
    return res.status(502).json({ code: "CFBD_GAME_FETCH_FAILED", message });
  }
});

router.get("/live/msu", async (req, res) => {
  const yearValue = asNumber(req.query.year);
  const year = yearValue && yearValue >= 2000 && yearValue <= 2100 ? yearValue : DEFAULT_YEAR;
  try {
    const gamesResponse = await cfbdGet("/games", { year, team: MSU });
    const games = (Array.isArray(gamesResponse) ? gamesResponse : []).map(asRecord).filter(isMsuGame);
    const activeGame = games.find((game) => game.completed !== true);
    if (!activeGame || gameId(activeGame) === null) {
      return res.json({ active: false, provider: "CFBD", checked_at: new Date().toISOString(), message: "No active MSU game is listed by CFBD." });
    }
    const id = gameId(activeGame) as number;
    const live = await cfbdGet("/live/plays", { gameId: id });
    return res.json({ active: true, provider: "CFBD", checked_at: new Date().toISOString(), game: activeGame, live });
  } catch (error) {
    const upstreamMessage = error instanceof Error ? error.message : "";
    const message = upstreamMessage.includes("401") || upstreamMessage.toLowerCase().includes("patreon")
      ? "CFBD live play polling is provider-dependent for this account."
      : "Live CFBD data is temporarily unavailable.";
    return res.json({ active: false, provider: "CFBD", checked_at: new Date().toISOString(), availability: "provider-dependent", message });
  }
});

router.get("/research", async (req, res) => {
  const yearValue = asNumber(req.query.year);
  const year = yearValue && yearValue >= 2000 && yearValue <= 2100 ? yearValue : DEFAULT_YEAR;
  const queryText = text(req.query.q).trim().toLowerCase();
  try {
    let dashboard = cache.get(year)?.data;
    if (!dashboard || dashboard.source.fetched_at === "") dashboard = await buildDashboardData(year);
    const completedWeeks = dashboard.schedule
      .filter((game) => game.status === "completed" && game.week !== null)
      .map((game) => game.week as number);
    const requestedWeek = asNumber(req.query.week);
    const week = requestedWeek ?? Math.max(...completedWeeks, 1);
    const [rankingsResponse, recruitingResponse, transferResponse] = await Promise.all([
      optionalCfbdGet("/rankings", { year, week }),
      optionalCfbdGet("/recruiting/players", { year, team: MSU }),
      optionalCfbdGet("/transfer/portal", { year, team: MSU }),
    ]);
    const rankingPolls = Array.isArray(asRecord(Array.isArray(rankingsResponse) ? rankingsResponse[0] : {}).polls)
      ? asRecord(Array.isArray(rankingsResponse) ? rankingsResponse[0] : {}).polls as unknown[]
      : [];
    const rankings = rankingPolls.flatMap((poll) => {
      const pollRecord = asRecord(poll);
      const pollName = text(value(pollRecord, "poll"), "Unknown poll");
      const ranks = Array.isArray(pollRecord.ranks) ? pollRecord.ranks : [];
      return ranks.slice(0, 25).map((rank) => ({ poll: pollName, ...asRecord(rank) }));
    });
    const recruiting = Array.isArray(recruitingResponse) ? recruitingResponse.map(asRecord).slice(0, 50) : [];
    const transfers = Array.isArray(transferResponse) ? transferResponse.map(asRecord).slice(0, 50) : [];
    const searchPool = [
      ...(dashboard.roster ?? []).map((player) => ({ kind: "player", id: player.id, name: player.name, detail: player.position ?? "Position unavailable" })),
      ...dashboard.schedule.map((game) => ({ kind: "game", id: String(game.id ?? ""), name: game.opponent, detail: `Week ${game.week ?? "—"}` })),
      ...(dashboard.team ? [{ kind: "team", id: String(dashboard.team.id ?? ""), name: dashboard.team.school, detail: dashboard.team.conference }] : []),
    ];
    const search = queryText
      ? searchPool.filter((item) => `${item.name} ${item.detail}`.toLowerCase().includes(queryText)).slice(0, 25)
      : [];
    return res.json({
      source: { provider: "CFBD", season: year, week, fetched_at: new Date().toISOString() },
      rankings,
      recruiting,
      transfers,
      availability: { rankings: rankings.length > 0, recruiting: recruiting.length > 0, transfers: transfers.length > 0 },
      search,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Research data unavailable";
    req.log.error({ err: error, year }, "CFBD research fetch failed");
    return res.status(502).json({ code: "CFBD_RESEARCH_FETCH_FAILED", message });
  }
});

router.get("/analytics", async (req, res) => {
  const requestedYear = asNumber(req.query.year);
  const year = requestedYear && requestedYear >= 2000 && requestedYear <= 2100 ? requestedYear : DEFAULT_YEAR;
  const forceRefresh = req.query.refresh === "true";
  const cached = cache.get(year);

  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return res.json({ ...cached.data, source: { ...cached.data.source, cached: true } });
  }

  try {
    const data = await buildDashboardData(year);
    cache.set(year, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return res.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown CFBD error";
    if (error instanceof Error && error.name === "MissingCfbdKey") {
      return res.status(503).json({ code: "CFBD_API_KEY_MISSING", message: "Live CFBD data is not configured on the server." });
    }
    req.log.error({ err: error, year }, "CFBD analytics refresh failed");
    return res.status(502).json({ code: "CFBD_FETCH_FAILED", message });
  }
});

export default router;