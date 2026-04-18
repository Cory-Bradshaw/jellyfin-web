/**
 * Shared types, seeded PRNG, and schedule computation for the Channel Guide.
 * Schedules are deterministic per (UTC day × channel index) so every client
 * sees the same programming at the same time.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RawGuideItem {
    id: string;
    title: string;
    /** For episodes: the series name. Null for movies. */
    seriesName?: string | null;
    /** For episodes: the parent series ID. Null for movies. */
    seriesId?: string | null;
    year: number | null;
    rating: string | null;
    overview: string | null;
    runTimeTicks: number;
    primaryImageTag: string | null;
}

export interface GuideItem extends RawGuideItem {
    /** Wall-clock ms when this item starts airing on this channel. */
    startMs: number;
    /** Wall-clock ms when this item finishes. */
    endMs: number;
}

export interface ChannelDef {
    index: number;
    number: string;
    name: string;
    /** CSS background tint for the channel row. */
    tint: string;
    /** CSS border/accent color for hover effects. */
    accent: string;
}

export interface GuideChannel extends ChannelDef {
    items: GuideItem[];
}

// ---------------------------------------------------------------------------
// Genre theme definitions
// ---------------------------------------------------------------------------

export interface GenreTheme {
    /** Display name shown in the channel gutter and overlay. */
    name: string;
    /** Lowercase genre strings to match against item genres. */
    genres: string[];
    tint: string;
    accent: string;
}

/**
 * Ordered list of genre-themed channels.  The surfer builds one channel per
 * theme (skipping themes with fewer than MIN_CHANNEL_ITEMS matching items).
 * Genres are matched case-insensitively against Jellyfin item genre tags.
 */
export const GENRE_THEMES: GenreTheme[] = [
    { name: 'ACTION',      genres: [ 'action', 'adventure', 'war' ],                   tint: 'rgba(255,60,0,0.07)',    accent: '#ff5533' },
    { name: 'COMEDY',      genres: [ 'comedy', 'sitcom' ],                             tint: 'rgba(255,200,0,0.07)',   accent: '#ffcc00' },
    { name: 'DRAMA',       genres: [ 'drama' ],                                        tint: 'rgba(60,100,200,0.07)',  accent: '#4488ff' },
    { name: 'HORROR',      genres: [ 'horror' ],                                       tint: 'rgba(180,0,0,0.08)',     accent: '#ee2222' },
    { name: 'THRILLER',    genres: [ 'thriller', 'mystery', 'crime', 'noir' ],         tint: 'rgba(80,80,80,0.10)',    accent: '#bbbbbb' },
    { name: 'SCI-FI',      genres: [ 'science fiction', 'sci-fi', 'superhero' ],       tint: 'rgba(0,150,255,0.07)',   accent: '#22aaff' },
    { name: 'FANTASY',     genres: [ 'fantasy', 'fairy tale', 'fairy-tale' ],          tint: 'rgba(150,50,255,0.07)', accent: '#9955ff' },
    { name: 'WESTERN',     genres: [ 'western' ],                                      tint: 'rgba(180,120,20,0.08)', accent: '#cc9922' },
    { name: 'ANIMATION',   genres: [ 'animation', 'animated' ],                        tint: 'rgba(0,200,100,0.07)',   accent: '#00cc66' },
    { name: 'FAMILY',      genres: [ 'family', 'kids', 'children', "children's" ],     tint: 'rgba(100,200,255,0.07)', accent: '#66ccff' },
    { name: 'DOCUMENTARY', genres: [ 'documentary', 'history', 'biography' ],          tint: 'rgba(100,200,200,0.07)', accent: '#44cccc' },
    { name: 'ROMANCE',     genres: [ 'romance', 'romantic' ],                          tint: 'rgba(255,80,150,0.07)', accent: '#ff5599' },
];

/** Minimum items required to create a genre channel (avoids single-movie channels). */
export const MIN_CHANNEL_ITEMS = 5;

/**
 * Fallback palette for numbered channels (used when no genres are tagged or
 * as a safety net for the "MIXED" overflow channel).
 */
export const FALLBACK_PALETTE = [
    { tint: 'rgba(0,200,220,0.06)',   accent: '#3ee8ff' },
    { tint: 'rgba(160,80,240,0.06)',  accent: '#c97fff' },
    { tint: 'rgba(255,120,40,0.06)',  accent: '#ff8844' },
    { tint: 'rgba(255,200,50,0.06)',  accent: '#ffcc33' },
    { tint: 'rgba(50,220,100,0.06)',  accent: '#33dd66' },
    { tint: 'rgba(255,50,120,0.06)',  accent: '#ff3ea5' },
];

// Legacy 3-channel definitions kept for reference — no longer used at runtime.
export const CHANNEL_DEFS: ChannelDef[] = [
    { index: 0, number: '01', name: 'CLASSICS', tint: 'rgba(0,200,220,0.06)',   accent: '#3ee8ff' },
    { index: 1, number: '02', name: 'ACTION',   tint: 'rgba(160,80,240,0.06)',  accent: '#c97fff' },
    { index: 2, number: '03', name: 'FAMILY',   tint: 'rgba(255,120,40,0.06)', accent: '#ff8844' },
];

// Visible window: 2.5 hours
export const WINDOW_MS = 2.5 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32 (exported so Channel Surf can share the same schedule)
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
    return () => {
        // eslint-disable-next-line no-param-reassign
        let z = (seed += 0x6D2B79F5);
        z = Math.imul(z ^ (z >>> 15), z | 1);
        z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
        return ((z ^ (z >>> 14)) >>> 0) / 0x100000000;
    };
}

export function dateChannelSeed(utcDay: number, channelIndex: number): number {
    return (utcDay * 31 + channelIndex) | 0;
}

export function seededShuffle<T>(arr: T[], seed: number): T[] {
    const copy = [ ...arr ];
    const rand = mulberry32(seed);
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [ copy[i], copy[j] ] = [ copy[j], copy[i] ];
    }
    return copy;
}

// ---------------------------------------------------------------------------
// Schedule computation
// ---------------------------------------------------------------------------

/**
 * Given a flat item pool and a channel index, return the items airing in the
 * 2.5-hour window starting at `nowMs`.  The schedule anchors to UTC midnight
 * so all clients agree on what's playing.
 */
export function computeChannelItems(
    rawItems: RawGuideItem[],
    channelIndex: number,
    nowMs: number
): GuideItem[] {
    if (rawItems.length === 0) return [];

    // Anchor to UTC midnight of the current day
    const utcMidnight = new Date(nowMs);
    utcMidnight.setUTCHours(0, 0, 0, 0);
    const dayStartMs = utcMidnight.getTime();

    const utcDay = Math.floor(dayStartMs / 86_400_000);
    const seed = dateChannelSeed(utcDay, channelIndex);
    // Sort by ID first so the shuffle input is identical regardless of API response order.
    const sorted = [ ...rawItems ].sort((a, b) => a.id.localeCompare(b.id));
    const shuffled = seededShuffle(sorted, seed);

    const result: GuideItem[] = [];
    let cursor = dayStartMs;

    // Walk up to 3 full passes through the library to fill the window
    outer: for (let pass = 0; pass < 3; pass++) {
        for (const raw of shuffled) {
            const runtimeMs = raw.runTimeTicks / 10_000;
            if (runtimeMs <= 0) continue;

            const startMs = cursor;
            const endMs = cursor + runtimeMs;
            cursor = endMs;

            if (endMs <= nowMs) continue;            // entirely before now
            if (startMs > nowMs + WINDOW_MS) break outer; // past visible window

            result.push({ ...raw, startMs, endMs });
        }
    }

    return result;
}

/**
 * Like computeChannelItems but for items that are ALREADY in schedule order
 * (i.e. from channelSurfManager.getChannelQueue — pre-sorted and pre-shuffled).
 * No sorting or shuffling is applied; the caller owns the ordering.
 */
export function computeSchedule(
    items: ReadonlyArray<{ id: string; runTimeTicks: number }>,
    nowMs: number
): Array<{ id: string; startMs: number; endMs: number }> {
    if (items.length === 0) return [];

    const utcMidnight = new Date(nowMs);
    utcMidnight.setUTCHours(0, 0, 0, 0);
    const dayStartMs = utcMidnight.getTime();

    const result: Array<{ id: string; startMs: number; endMs: number }> = [];
    let cursor = dayStartMs;

    outer: for (let pass = 0; pass < 3; pass++) {
        for (const item of items) {
            const runtimeMs = item.runTimeTicks / 10_000;
            if (runtimeMs <= 0) continue;

            const startMs = cursor;
            const endMs = cursor + runtimeMs;
            cursor = endMs;

            if (endMs <= nowMs) continue;
            if (startMs > nowMs + WINDOW_MS) break outer;

            result.push({ id: item.id, startMs, endMs });
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// Formatting helpers (shared with component)
// ---------------------------------------------------------------------------

export function fmtTime(ms: number): string {
    return new Date(ms).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: false
    });
}

export function fmtOffset(ms: number): string {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function fmtRuntime(ticks: number): string {
    const totalMin = Math.round(ticks / 10_000_000 / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}m`;
}
