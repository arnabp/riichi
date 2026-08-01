import { createHash } from "node:crypto";

const UNITY_VERSION = "2021.3.38f1";
const CLIENT_VERSION = "2.2.3.89215";

// Candidate servers tried in parallel; fastest that responds wins.
const CANDIDATE_SERVERS = [
  "http://13.112.183.79",
  "https://aga-alb.mahjong-jp.net",
];

const BASE_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": `UnityPlayer/${UNITY_VERSION}`,
  "X-Unity-Version": UNITY_VERSION,
};

export interface RCPlayer {
  uid: number;
  nickname: string;
  points: number;
  rank: number; // 1-indexed placement
}

export interface RCGame {
  paiPuId: string;
  endTime: number; // unix seconds
  playerCount: number;
  players: RCPlayer[];
}

export interface RCLeaderboardEntry {
  rank: number;
  userID: number;
  nickname: string;
  rankScore: number;
  gamesPlayed: number;
}

export interface RCTournamentInfo {
  classifyId: string;
  matchId: number;
  onlineSize: number;   // total people in the lobby
  ongoingGames: number; // game rooms currently in progress (roomSize)
  queueSize: number;    // players waiting for a match (startedSize)
}

interface RawLogEntry {
  paiPuId: string;
  endTime: number;
  isMiddlePause: boolean;
  playerCount: number;
  players: { userId: number; nickname: string; points: number; rank: number }[];
}

interface RCApiResponse<T> {
  code: number;
  message?: string;
  data?: T;
}

interface LoginData {
  user: { id: number; nickname: string };
}

interface EnterSelfBuildData {
  classifyID: string;
  matchID: number;
  onlineSize: number;
  startedSize: number; // total players in active state (in games + in queue)
  roomSize: number;
}


interface SelfRankData {
  rankList: {
    rank: number;
    userID: number;
    nickname: string;
    rankScore: number;
    roomSize: number;
  }[];
}

export class RiichiCityClient {
  private baseUrl = "";
  private sid = "";
  private uid = "";
  private email: string;
  private emailSuffix: string;
  private passwordMd5: string;
  private deviceId: string;
  private guid: string;

  constructor(
    email: string,
    password: string,
    alreadyHashed = false,
    emailSuffix = "",
    deviceId = "0000000000000000000000000000000000000000",
  ) {
    this.email = email;
    this.emailSuffix = emailSuffix;
    this.passwordMd5 = alreadyHashed
      ? password
      : createHash("md5").update(password).digest("hex");
    this.deviceId = deviceId;
    // 38-char guid derived consistently from device ID
    const h1 = createHash("md5").update(deviceId).digest("hex");
    const h2 = createHash("md5").update(deviceId + "g").digest("hex");
    this.guid = h1 + h2.slice(0, 6);
  }

  // ── Auth ────────────────────────────────────────────────────────────────────

  async login(): Promise<void> {
    this.baseUrl = await this.selectServer();
    console.log(`[RC] baseUrl=${this.baseUrl}`);
    await this.fetchSid();
    await this.fetchUid();
    console.log(`[RC] Logged in as uid=${this.uid}`);
  }

  private async selectServer(): Promise<string> {
    if (process.env.RIICHI_BASE_URL) return process.env.RIICHI_BASE_URL;

    const race = CANDIDATE_SERVERS.map(async (url) => {
      const start = Date.now();
      try {
        const res = await fetch(`${url}/users/checkVersion`, {
          method: "POST", headers: BASE_HEADERS, body: "{}",
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error();
        await res.json();
        return { latency: Date.now() - start, url };
      } catch {
        return { latency: Infinity, url };
      }
    });

    const results = await Promise.all(race);
    const best = results.reduce((a, b) => a.latency <= b.latency ? a : b);
    if (best.latency === Infinity) throw new Error("No game server reachable");
    console.log(`[RC] Selected server: ${best.url} (${best.latency}ms)`);
    return best.url;
  }

  private async fetchSid(): Promise<void> {
    const sid = await this.post<string>("/users/initSession", {});
    if (!sid) throw new Error("initSession response missing sid");
    this.sid = sid;
  }

  private async fetchUid(): Promise<void> {
    const data = await this.post<LoginData>("/users/emailLogin", {
      adjustId: "",
      guid: this.guid,
      email: this.email + this.emailSuffix,
      passwd: this.passwordMd5,
    });
    if (data.user?.id == null) throw new Error("emailLogin response missing user.id");
    this.uid = String(data.user.id);
  }

  // ── Tournament ──────────────────────────────────────────────────────────────

  async enterTournament(tournamentId: string): Promise<RCTournamentInfo> {
    const data = await this.post<EnterSelfBuildData>("/lobbys/enterSelfBuild", {
      id: tournamentId,
    });
    if (data.classifyID == null) throw new Error("enterSelfBuild response missing classifyID");
    const classifyId = String(data.classifyID);

    // readOnlineRoom gives us the actual ongoing game rooms; derive queue from the difference
    const rooms = await this.post<{ playerCount: number }[]>("/record/readOnlineRoom", {
      classifyID: classifyId,
    });
    const ongoingGames = rooms.length;
    const playersInGames = rooms.reduce((sum, r) => sum + r.playerCount, 0);

    return {
      classifyId,
      matchId: data.matchID,
      onlineSize: data.onlineSize,
      ongoingGames,
      queueSize: Math.max(0, data.startedSize - playersInGames),
    };
  }

  async getLeaderboard(classifyId: string, matchId: number): Promise<RCLeaderboardEntry[]> {
    const data = await this.post<SelfRankData>("/stats/getSelfRankV2", {
      classifyID: classifyId,
      matchID: matchId,
    });
    return (data.rankList ?? []).map((e) => ({
      rank: e.rank,
      userID: e.userID,
      nickname: e.nickname,
      rankScore: e.rankScore,
      gamesPlayed: e.roomSize,
    }));
  }

  // ── Game queries ─────────────────────────────────────────────────────────────

  async getCompletedGames(
    classifyId: string,
    skip = 0,
    limit = 20
  ): Promise<RCGame[]> {
    const { games } = await this.getCompletedGamesPage(classifyId, skip, limit);
    return games;
  }

  // Same as getCompletedGames but also reports how many entries the server sent
  // before abandoned (isMiddlePause) games were filtered out. Callers paging
  // through full history must stop on rawCount === 0, not games.length === 0 —
  // a page can filter down to empty while more history still follows.
  async getCompletedGamesPage(
    classifyId: string,
    skip = 0,
    limit = 20
  ): Promise<{ games: RCGame[]; rawCount: number }> {
    const entries = await this.post<RawLogEntry[]>("/record/readPaiPuList", {
      classifyID: classifyId,
      skip,
      limit,
      startTime: 0,
      endTime: 0,
      isAiAnalysis: false,
      gamePlay: 1002,
      classType: 1002,
      isSelf: true,
    });

    const games = entries
      .filter((e) => !e.isMiddlePause)
      .map((e) => ({
        paiPuId: e.paiPuId,
        endTime: e.endTime,
        playerCount: e.playerCount,
        players: rankPlayers(e.players),
      }));

    return { games, rawCount: entries.length };
  }

  // ── Internal HTTP ────────────────────────────────────────────────────────────

  private cookieHeader(): string {
    return JSON.stringify({
      deviceid: this.deviceId,
      sid: this.sid,
      version: CLIENT_VERSION,
      uid: Number(this.uid) || 0,
      region: "cn",
      channel: "default",
      platform: "linux",
      datatype: "0",
      lang: "en",
    });
  }

  private async post<T>(path: string, body: object): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...BASE_HEADERS,
        Cookies: this.cookieHeader(),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);

    const json = await res.json() as RCApiResponse<T>;
    if (json.code !== 0) {
      if (json.code === 401 || json.code === 10001 || json.code === 10) {
        throw new SessionExpiredError(path, json.code);
      }
      throw new Error(`RC API error ${json.code} on ${path}: ${json.message}`);
    }

    if (json.data === undefined) throw new Error(`RC API response missing 'data' on ${path}`);
    return json.data;
  }
}

export class SessionExpiredError extends Error {
  constructor(
    public readonly path: string,
    public readonly code: number
  ) {
    super(`Session expired (code ${code}) on ${path}`);
  }
}

export function rankPlayers(
  players: { userId: number; nickname: string; points: number }[]
): RCPlayer[] {
  const sorted = [...players].sort((a, b) => b.points - a.points);
  return sorted.map((p, i) => ({ uid: p.userId, nickname: p.nickname, points: p.points, rank: i + 1 }));
}
