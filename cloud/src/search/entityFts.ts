import type { Env } from '../env';

export interface QueryPlanRow {
    id: number;
    parent: number;
    notused: number;
    detail: string;
}

export interface GameLogSearchRow {
    id: number;
    created_at: string;
    type: string;
    display_name: string;
    location: string;
    user_id: string;
    time: number;
}

export interface WorldLocationSearchRow {
    id: number;
    created_at: string;
    location: string;
    world_id: string;
    world_name: string;
    time: number;
    group_name: string;
}

export interface EntitySearchResult {
    query: string;
    strategy: 'trigram_fts' | 'bounded_short_query' | 'empty';
    matchedUserIds: string[];
    matchedWorldIds: string[];
    joinLeaveRows: GameLogSearchRow[];
    locationRows: WorldLocationSearchRow[];
    metrics: {
        coreRowsRead: number;
        gamelogRowsRead: number;
        totalRowsRead: number;
    };
    queryPlans?: {
        usersDictionary: string[];
        worldsDictionary: string[];
        joinLeaveLookup: string[];
        locationLookup: string[];
    };
}

const MAX_ENTITY_IDS = 30;
const MAX_RESULT_LIMIT = 100;
const SHORT_QUERY_SCAN_CAP = 50;

/**
 * Escapes arbitrary user input into a safe literal phrase for FTS5 trigram MATCH.
 * Wrapping in double quotes neutralizes FTS5 operators (AND/OR/NOT/NEAR/:/-/*).
 */
export function buildSafeTrigramMatch(raw: string): string {
    const escaped = raw.replaceAll('"', '""');
    return `"${escaped}"`;
}

function clampLimit(limit: number): number {
    if (!Number.isFinite(limit) || limit <= 0) {
        return 50;
    }
    return Math.min(Math.floor(limit), MAX_RESULT_LIMIT);
}

async function explainPlan(db: D1Database, sql: string, params: unknown[]): Promise<string[]> {
    const res = await db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...params)
        .all<QueryPlanRow>();
    return (res.results ?? []).map((row) => row.detail);
}

/**
 * Searches deduplicated entity dictionaries in DB_CORE via FTS5 trigram,
 * then resolves matching events in DB_GAMELOG using indexed B-tree lookups.
 */
export async function searchGameLogByEntity(
    env: Env,
    rawQuery: string,
    options: { limit?: number; includeExplain?: boolean } = {}
): Promise<EntitySearchResult> {
    const query = rawQuery.trim();
    const limit = clampLimit(options.limit ?? 50);

    if (!query) {
        return {
            query: '',
            strategy: 'empty',
            matchedUserIds: [],
            matchedWorldIds: [],
            joinLeaveRows: [],
            locationRows: [],
            metrics: { coreRowsRead: 0, gamelogRowsRead: 0, totalRowsRead: 0 }
        };
    }

    const codePointLength = Array.from(query).length;
    const useTrigramFts = codePointLength >= 3;

    let userSql: string;
    let userParams: unknown[];
    let worldSql: string;
    let worldParams: unknown[];

    if (useTrigramFts) {
        const matchExpr = buildSafeTrigramMatch(query);
        userSql = `
            SELECT u.user_id
            FROM entity_users_fts f
            JOIN entity_users u ON u.rowid = f.rowid
            WHERE entity_users_fts MATCH ?
            LIMIT ?
        `;
        userParams = [matchExpr, MAX_ENTITY_IDS];

        worldSql = `
            SELECT w.world_id
            FROM entity_worlds_fts f
            JOIN entity_worlds w ON w.rowid = f.rowid
            WHERE entity_worlds_fts MATCH ?
            LIMIT ?
        `;
        worldParams = [matchExpr, MAX_ENTITY_IDS];
    } else {
        // Short 1-2 char queries stay strictly bounded on the most recently seen entities
        // to prevent full-table scans on D1 Free tier.
        const likePattern = `%${query}%`;
        userSql = `
            SELECT user_id
            FROM (
                SELECT user_id, display_name, aliases_text
                FROM entity_users
                ORDER BY rowid DESC
                LIMIT ?
            )
            WHERE display_name LIKE ? OR aliases_text LIKE ?
            LIMIT ?
        `;
        userParams = [SHORT_QUERY_SCAN_CAP, likePattern, likePattern, MAX_ENTITY_IDS];

        worldSql = `
            SELECT world_id
            FROM (
                SELECT world_id, world_name
                FROM entity_worlds
                ORDER BY rowid DESC
                LIMIT ?
            )
            WHERE world_name LIKE ?
            LIMIT ?
        `;
        worldParams = [SHORT_QUERY_SCAN_CAP, likePattern, MAX_ENTITY_IDS];
    }

    const [userRes, worldRes] = await env.DB_CORE.batch([
        env.DB_CORE.prepare(userSql).bind(...userParams),
        env.DB_CORE.prepare(worldSql).bind(...worldParams)
    ]);

    const matchedUserIds = ((userRes?.results ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
    const matchedWorldIds = ((worldRes?.results ?? []) as Array<{ world_id: string }>).map((r) => r.world_id);

    const coreRowsRead = (userRes?.meta?.rows_read ?? 0) + (worldRes?.meta?.rows_read ?? 0);

    let joinLeaveRows: GameLogSearchRow[] = [];
    let locationRows: WorldLocationSearchRow[] = [];
    let gamelogRowsRead = 0;

    let jlSql = '';
    let jlParams: unknown[] = [];
    let locSql = '';
    let locParams: unknown[] = [];

    const gamelogStatements: D1PreparedStatement[] = [];
    let jlBatchIndex = -1;
    let locBatchIndex = -1;

    if (matchedUserIds.length > 0) {
        const placeholders = matchedUserIds.map(() => '?').join(', ');
        jlSql = `
            SELECT id, created_at, type, display_name, location, user_id, time
            FROM gamelog_join_leave
            WHERE user_id IN (${placeholders})
            ORDER BY id DESC
            LIMIT ?
        `;
        jlParams = [...matchedUserIds, limit];
        jlBatchIndex = gamelogStatements.length;
        gamelogStatements.push(env.DB_GAMELOG.prepare(jlSql).bind(...jlParams));
    }

    if (matchedWorldIds.length > 0) {
        const placeholders = matchedWorldIds.map(() => '?').join(', ');
        locSql = `
            SELECT id, created_at, location, world_id, world_name, time, group_name
            FROM gamelog_location
            WHERE world_id IN (${placeholders})
            ORDER BY id DESC
            LIMIT ?
        `;
        locParams = [...matchedWorldIds, limit];
        locBatchIndex = gamelogStatements.length;
        gamelogStatements.push(env.DB_GAMELOG.prepare(locSql).bind(...locParams));
    }

    if (gamelogStatements.length > 0) {
        const results = await env.DB_GAMELOG.batch(gamelogStatements);
        if (jlBatchIndex >= 0) {
            const jlRes = results[jlBatchIndex];
            joinLeaveRows = (jlRes?.results ?? []) as GameLogSearchRow[];
            gamelogRowsRead += jlRes?.meta?.rows_read ?? 0;
        }
        if (locBatchIndex >= 0) {
            const locRes = results[locBatchIndex];
            locationRows = (locRes?.results ?? []) as WorldLocationSearchRow[];
            gamelogRowsRead += locRes?.meta?.rows_read ?? 0;
        }
    }

    const result: EntitySearchResult = {
        query,
        strategy: useTrigramFts ? 'trigram_fts' : 'bounded_short_query',
        matchedUserIds,
        matchedWorldIds,
        joinLeaveRows,
        locationRows,
        metrics: {
            coreRowsRead,
            gamelogRowsRead,
            totalRowsRead: coreRowsRead + gamelogRowsRead
        }
    };

    if (options.includeExplain) {
        const [usersPlan, worldsPlan, jlPlan, locPlan] = await Promise.all([
            explainPlan(env.DB_CORE, userSql, userParams),
            explainPlan(env.DB_CORE, worldSql, worldParams),
            jlSql ? explainPlan(env.DB_GAMELOG, jlSql, jlParams) : Promise.resolve([]),
            locSql ? explainPlan(env.DB_GAMELOG, locSql, locParams) : Promise.resolve([])
        ]);
        result.queryPlans = {
            usersDictionary: usersPlan,
            worldsDictionary: worldsPlan,
            joinLeaveLookup: jlPlan,
            locationLookup: locPlan
        };
    }

    return result;
}
