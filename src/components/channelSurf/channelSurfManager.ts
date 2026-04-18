/**
 * Singleton that owns the channel-surf queue, patches playbackManager's
 * nextTrack / previousTrack while active, and fires a window CustomEvent
 * that the ChannelSurfOverlay component listens to in order to show the
 * static → tuning animation between channels.
 */

import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client';
import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { ItemFields } from '@jellyfin/sdk/lib/generated-client/models/item-fields';
import { getItemsApi } from '@jellyfin/sdk/lib/utils/api/items-api';
import { getUserLibraryApi } from '@jellyfin/sdk/lib/utils/api/user-library-api';

import type { JellyfinApiContext } from 'hooks/useApi';
import { playbackManager } from 'components/playback/playbackmanager';
import {
    dateChannelSeed,
    seededShuffle,
    GENRE_THEMES,
    MIN_CHANNEL_ITEMS,
    FALLBACK_PALETTE
} from 'components/channelGuide/channelGuideUtils';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Fired when the surf transition starts (show static immediately). */
export const CHANNEL_SURF_TRANSITION = 'channelsurf:transition';
/** Fired when play() resolves and the player has started (transition static → tuning). */
export const CHANNEL_SURF_READY = 'channelsurf:ready';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SurfQueueItem {
    id: string;
    runTimeTicks: number;
    /** Lowercase genre strings, used for genre-channel assignment. */
    genres: string[];
    /** For episodes: parent series ID (used for sequential scheduling). */
    seriesId?: string | null;
    /** For episodes: season number (ParentIndexNumber). */
    parentIndexNumber?: number | null;
    /** For episodes: episode number within the season (IndexNumber). */
    indexNumber?: number | null;
}

/**
 * Each channel has its own independently-shuffled schedule of movies.
 * Named channels (ACTION, SCI-FI, etc.) contain only genre-matching items.
 * The shuffle is seeded by (utcDay × channelIndex) so Channel Surf and the
 * Channel Guide always agree on what's playing on a given channel.
 */
interface ChannelSchedule {
    items: SurfQueueItem[];
    /** Human-readable name shown in the guide gutter and surf overlay. */
    name: string;
    /** CSS background tint for the channel row. */
    tint: string;
    /** CSS accent colour for borders and hover effects. */
    accent: string;
}

interface SurfQueue {
    channels: ChannelSchedule[];
    maxChannels: number;
    index: number;
    libraryIds: string[];
    /** Date.now() when this queue was first built — used for clock-progress positioning. */
    wallStartMs: number;
    clockProgress: boolean;
}

export interface SurfConfig {
    libraryIds: string[];
    clockProgress: boolean;
    /** Maximum number of distinct channels to create (default 50). */
    maxChannels: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ITEMS_PER_FETCH = 500;

function sortedCopy(ids: string[]): string[] {
    return [ ...ids ].sort((a, b) => a.localeCompare(b));
}

/**
 * Walk a shuffled channel queue and ensure that when two consecutive items are
 * episodes from the same series, the second is replaced with the next sequential
 * episode (by season + episode number) after the first.
 * `pool` is the full sorted item list available to that channel — used to find
 * the "next" episode even if the shuffled order skipped it.
 */
function applyEpisodeContinuity(
    items: SurfQueueItem[],
    pool: SurfQueueItem[]
): SurfQueueItem[] {
    // Build per-series sorted episode map from the pool (not just from shuffled items
    // so we can pick the true "next" episode in broadcast order).
    const seriesMap = new Map<string, SurfQueueItem[]>();
    for (const item of pool) {
        if (!item.seriesId) continue;
        let list = seriesMap.get(item.seriesId);
        if (!list) { list = []; seriesMap.set(item.seriesId, list); }
        list.push(item);
    }
    for (const list of seriesMap.values()) {
        list.sort((a, b) => {
            const sa = a.parentIndexNumber ?? 0;
            const sb = b.parentIndexNumber ?? 0;
            if (sa !== sb) return sa - sb;
            return (a.indexNumber ?? 0) - (b.indexNumber ?? 0);
        });
    }

    const result = [ ...items ];
    for (let i = 0; i < result.length - 1; i++) {
        const cur = result[i];
        const next = result[i + 1];
        if (!cur.seriesId || cur.seriesId !== next.seriesId) continue;

        // Two consecutive episodes from the same series — pick the next episode
        // in broadcast order after `cur`.
        const eps = seriesMap.get(cur.seriesId);
        if (!eps || eps.length < 2) continue;
        const curIdx = eps.findIndex(e => e.id === cur.id);
        if (curIdx < 0) continue;
        const nextEp = eps[(curIdx + 1) % eps.length];
        // Only replace if it's not already the correct episode.
        if (nextEp.id !== next.id) {
            result[i + 1] = nextEp;
        }
    }
    return result;
}

function utcMidnightMs(nowMs = Date.now()): number {
    const d = new Date(nowMs);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
}

// ---------------------------------------------------------------------------
// Manager class
// ---------------------------------------------------------------------------

class ChannelSurfManager {
    private _queue: SurfQueue | null = null;
    private _isActive = false;
    private _apiContext: JellyfinApiContext | null = null;
    private _origNext: ((player?: unknown) => void) | null = null;
    private _origPrev: ((player?: unknown) => void) | null = null;
    private _styleEl: HTMLStyleElement | null = null;

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    get isActive(): boolean {
        return this._isActive;
    }

    /**
     * Debug helper: clock-progress mode now anchors to UTC midnight, so there
     * is no longer a wall-start offset to shift.  Use the browser's system clock
     * or manually test at a specific time-of-day instead.
     *
     * @deprecated No-op since v2 UTC-midnight anchor.
     */
    shiftWallClock(_seconds: number): void {
        console.warn('[ChannelSurf] shiftWallClock() is a no-op since switching to UTC-midnight anchoring. The schedule is now locked to real wall-clock time, matching the Channel Guide.');
    }

    setApiContext(ctx: JellyfinApiContext): void {
        this._apiContext = ctx;
    }

    /**
     * Build (or restore) the queue without starting playback.
     * Called by ChannelGuide so it can display the schedule before the user taps Surf.
     * Returns true if the queue is ready.
     */
    async prepareQueue(config: SurfConfig): Promise<boolean> {
        const queue = await this._ensureQueue(config);
        return queue !== null;
    }

    /**
     * Returns the schedule-ordered item list for a channel.
     * The ordering is identical to what the surfer uses for playback.
     * Returns null if the queue has not been built yet.
     */
    getChannelQueue(channelIndex: number): ReadonlyArray<{ id: string; runTimeTicks: number }> | null {
        if (!this._queue || this._queue.channels.length === 0) return null;
        const ch = this._queue.channels[channelIndex % this._queue.channels.length];
        return ch?.items ?? null;
    }

    /**
     * Returns display metadata (name, number, tint, accent) for a channel.
     * Returns null if the queue has not been built yet.
     */
    getChannelDef(channelIndex: number): { name: string; number: string; tint: string; accent: string } | null {
        if (!this._queue || this._queue.channels.length === 0) return null;
        const ch = this._queue.channels[channelIndex % this._queue.channels.length];
        if (!ch) return null;
        return {
            name: ch.name,
            number: String(channelIndex + 1).padStart(2, '0'),
            tint: ch.tint,
            accent: ch.accent
        };
    }

    /** Total number of channels in the current queue (0 if not yet built). */
    get totalChannels(): number {
        return this._queue?.channels.length ?? 0;
    }

    invalidate(): void {
        this._queue = null;
        try { sessionStorage.removeItem(ChannelSurfManager.SESSION_KEY); } catch { /* ignore */ }
    }

    deactivate(): void {
        if (!this._isActive) return;
        this._isActive = false;

        const pm = playbackManager as unknown as Record<string, unknown>;
        if (this._origNext) {
            pm.nextTrack = this._origNext;
            this._origNext = null;
        }
        if (this._origPrev) {
            pm.previousTrack = this._origPrev;
            this._origPrev = null;
        }
        if (this._styleEl) {
            this._styleEl.remove();
            this._styleEl = null;
        }
    }

    /** Build (or restore) the channel schedules and start playback at channel 0. */
    async buildAndSurf(config: SurfConfig): Promise<void> {
        const queue = await this._ensureQueue(config);
        if (!queue) return;

        queue.index = 0;
        this._activate();
        await this._playAtIndex(queue);
    }

    /** Jump directly to a specific channel index and start playback. */
    async surfAtChannel(channelIndex: number): Promise<void> {
        if (!this._queue) return;
        this._queue.index = channelIndex % this._queue.channels.length;
        this._activate();
        await this._playAtIndex(this._queue);
    }

    /** Step forward or backward through channels (wraps around). */
    async advance(direction: 'next' | 'prev'): Promise<void> {
        if (!this._queue) return;

        const numChannels = this._queue.channels.length;
        this._queue.index = direction === 'next' ?
            (this._queue.index + 1) % numChannels :
            (this._queue.index - 1 + numChannels) % numChannels;

        await this._playAtIndex(this._queue);
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    private _activate(): void {
        if (this._isActive) return;
        this._isActive = true;

        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this;
        const pm = playbackManager as unknown as Record<string, unknown>;

        this._origNext = pm.nextTrack as (player?: unknown) => void;
        this._origPrev = pm.previousTrack as (player?: unknown) => void;

        pm.nextTrack = function () {
            void self.advance('next');
        };
        pm.previousTrack = function () {
            void self.advance('prev');
        };

        // Force the player OSD next/prev track buttons visible.
        // updatePlaylist() in the video controller hides them when
        // playlist.length <= 1; override via CSS instead of patching
        // getPlaylist(), which caused unexpected queue re-plays.
        const style = document.createElement('style');
        style.textContent = '.btnNextTrack, .btnPreviousTrack { display: inline-flex !important; }';
        document.head.appendChild(style);
        this._styleEl = style;
    }

    private async _playAtIndex(queue: SurfQueue): Promise<void> {
        const channelIdx = queue.index % queue.channels.length;
        const channel = queue.channels[channelIdx];
        const channelNumber = String(channelIdx + 1).padStart(2, '0');
        const channelName = channel.name;

        // Fire the transition immediately so static noise appears before
        // the network fetch — covers any loading delay.
        window.dispatchEvent(new CustomEvent(CHANNEL_SURF_TRANSITION, {
            detail: { channelNumber, channelName }
        }));

        // Safety timer: CHANNEL_SURF_READY MUST fire within 12s regardless of
        // what happens below (slow fetch, play() hanging, or exception).
        let readyFired = false;
        const fireReady = () => {
            if (readyFired) return;
            readyFired = true;
            window.dispatchEvent(new CustomEvent(CHANNEL_SURF_READY));
        };
        const safetyTimer = setTimeout(fireReady, 12_000);

        try {
            let itemId: string;
            let startPositionTicks: number | null = null;

            if (queue.clockProgress) {
                const tv = this._computeTvPosition(queue);
                itemId = tv.itemId;
                startPositionTicks = tv.positionTicks;
            } else {
                itemId = channel.items[0].id;
            }

            const item = await this._fetchItem(itemId);
            if (!item) {
                console.error('[ChannelSurf] _fetchItem returned null for itemId:', itemId);
                return;
            }

            if (startPositionTicks === null) {
                startPositionTicks = this._computeRandomTicks(
                    item.RunTimeTicks ?? 0,
                    item.UserData?.PlaybackPositionTicks ?? 0
                );
            }

            const ticksToHms = (t: number) => {
                const totalSec = Math.floor(t / 10_000_000);
                const h = Math.floor(totalSec / 3600);
                const m = Math.floor((totalSec % 3600) / 60);
                const s = totalSec % 60;
                return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
            };

            const nowMs = Date.now();
            const midnightMs = utcMidnightMs(nowMs);
            const elapsedSinceMidnight = nowMs - midnightMs;

            console.group(`[ChannelSurf] ch${channelIdx + 1} → "${item.Name}"`);
            console.log('system clock      ', new Date(nowMs).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }));
            if (queue.clockProgress) {
                console.log('UTC midnight      ', new Date(midnightMs).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }));
                console.log('elapsed since midnight', `${(elapsedSinceMidnight / 1000).toFixed(0)}s`);
            }
            console.log('startPosition     ', ticksToHms(startPositionTicks));
            console.log('resume(UserData)  ', ticksToHms(item.UserData?.PlaybackPositionTicks ?? 0));
            console.log('mode              ', queue.clockProgress ? 'clock-progress (UTC-midnight anchor)' : 'random/resume');
            console.groupEnd();

            await (playbackManager as { play: (opts: object) => Promise<void> })
                .play({ items: [ item ], startPositionTicks });
        } catch (err) {
            console.error('[ChannelSurf] Error in _playAtIndex:', err);
        } finally {
            clearTimeout(safetyTimer);
            fireReady();
        }
    }

    /**
     * For clock-progress mode: determine what's currently airing on this channel
     * by anchoring to UTC midnight — the same anchor the Channel Guide uses.
     * This ensures that clicking a program in the guide and switching to that
     * channel in the surfer always lands on the same item at the same position.
     */
    private _computeTvPosition(queue: SurfQueue): { itemId: string; positionTicks: number } {
        // Ticks are 100-nanosecond units: 1 ms = 10,000 ticks.
        const nowMs = Date.now();
        const elapsedMs = nowMs - utcMidnightMs(nowMs);
        const elapsedTicks = Math.floor(elapsedMs * 10_000);

        const channelIdx = queue.index % queue.channels.length;
        const channel = queue.channels[channelIdx];

        // Wrap elapsed time around the total channel duration so playback
        // continues coherently if the library is shorter than a full day.
        const totalTicks = channel.items.reduce((sum, i) => sum + i.runTimeTicks, 0);
        let remainingTicks = totalTicks > 0 ? elapsedTicks % totalTicks : 0;

        for (const item of channel.items) {
            if (remainingTicks < item.runTimeTicks) {
                return { itemId: item.id, positionTicks: remainingTicks };
            }
            remainingTicks -= item.runTimeTicks;
        }

        return { itemId: channel.items[0].id, positionTicks: 0 };
    }

    private _computeRandomTicks(runTimeTicks: number, resumeTicks: number): number {
        if (resumeTicks > 0) return resumeTicks;
        const min = runTimeTicks * 0.25;
        const max = runTimeTicks * 0.75;
        // eslint-disable-next-line sonarjs/pseudo-random
        return Math.floor(min + Math.random() * (max - min));
    }

    // -----------------------------------------------------------------------
    // sessionStorage persistence — survives page reload / crash, not new tabs
    // -----------------------------------------------------------------------

    // v7: added seriesId/indexNumber for sequential episode scheduling
    private static readonly SESSION_KEY = 'channelSurf.queue.v7';

    private _saveQueueToSession(queue: SurfQueue): void {
        try {
            sessionStorage.setItem(ChannelSurfManager.SESSION_KEY, JSON.stringify(queue));
        } catch {
            // sessionStorage may be full (large libraries) or unavailable — non-critical
        }
    }

    private _restoreQueueFromSession(cfgIds: string[], config: SurfConfig): SurfQueue | null {
        try {
            const raw = sessionStorage.getItem(ChannelSurfManager.SESSION_KEY);
            if (!raw) return null;
            const q = JSON.parse(raw) as SurfQueue;
            if (
                JSON.stringify(sortedCopy(q.libraryIds)) === JSON.stringify(cfgIds)
                && q.clockProgress === config.clockProgress
                && q.maxChannels === config.maxChannels
                && Array.isArray(q.channels) && q.channels.length > 0
                && typeof q.wallStartMs === 'number'
                && typeof q.channels[0].name === 'string'  // v5: ensure genre metadata present
            ) {
                return q;
            }
        } catch {
            // Invalid or corrupt stored data
        }
        return null;
    }

    private async _fetchItem(itemId: string): Promise<BaseItemDto | null> {
        const { api, user } = this._apiContext ?? {};
        if (!api || !user?.Id) return null;
        try {
            const res = await getUserLibraryApi(api).getItem({ userId: user.Id, itemId });
            return res.data ?? null;
        } catch {
            return null;
        }
    }

    private async _ensureQueue(config: SurfConfig): Promise<SurfQueue | null> {
        const cfgIds = sortedCopy(config.libraryIds);

        const isValid = (q: SurfQueue) =>
            JSON.stringify(sortedCopy(q.libraryIds)) === JSON.stringify(cfgIds)
            && q.clockProgress === config.clockProgress
            && q.maxChannels === config.maxChannels
            && q.channels.length > 0;

        if (this._queue && isValid(this._queue)) {
            console.log('[ChannelSurf] reusing existing queue');
            return this._queue;
        }

        // Attempt to restore from sessionStorage — preserves wallStartMs across
        // page reloads and crashes so channels continue from where they were.
        const restored = this._restoreQueueFromSession(cfgIds, config);
        if (restored) {
            console.log('[ChannelSurf] Restored queue from session — channels:', restored.channels.length);
            this._queue = restored;
            return this._queue;
        }

        console.warn('[ChannelSurf] REBUILDING queue — wallStartMs will reset to now. Reason:', !this._queue ? 'queue was null (no session data)' : `isValid failed (libraryIds match: ${JSON.stringify(sortedCopy(this._queue.libraryIds)) === JSON.stringify(cfgIds)}, clockProgress match: ${this._queue.clockProgress === config.clockProgress}, maxChannels match: ${this._queue.maxChannels === config.maxChannels}, hasChannels: ${this._queue.channels.length > 0})`);

        const items = await this._fetchQueueItems(config.libraryIds);
        if (items.length === 0) return null;

        // Build up to maxChannels independent channels, each with its own
        // deterministic seeded shuffle keyed to (today's UTC day × channel index).
        // This matches the Channel Guide's scheduling exactly — ch 0 in the surfer
        // is always the same as channel 0 (CLASSICS) in the guide.
        const nowMs = Date.now();
        const utcDay = Math.floor(utcMidnightMs(nowMs) / 86_400_000);

        // Sort by ID before shuffling — must match the sort in computeChannelItems
        // in channelGuideUtils so both systems produce identical channel schedules.
        const sortedItems = [ ...items ].sort((a, b) => a.id.localeCompare(b.id));

        // ---- Genre channels (up to 4 per genre, scaled by item count) ----
        const genreChannels: ChannelSchedule[] = [];

        for (const theme of GENRE_THEMES) {
            if (genreChannels.length >= config.maxChannels) break;

            const themeItems = sortedItems.filter(item =>
                item.genres.some(g => theme.genres.includes(g))
            );
            if (themeItems.length < MIN_CHANNEL_ITEMS) continue;

            // Scale channel count with library size, max 4.
            const numForGenre = themeItems.length >= 50 ? 4
                : themeItems.length >= 30 ? 3
                : themeItems.length >= 15 ? 2 : 1;

            for (let j = 0; j < numForGenre; j++) {
                if (genreChannels.length >= config.maxChannels) break;
                // Suffix only the 2nd+ instance: "DRAMA", "DRAMA 2", "DRAMA 3"…
                const name = j === 0 ? theme.name : `${theme.name} ${j + 1}`;
                const seed = dateChannelSeed(utcDay, genreChannels.length);
                const shuffled = applyEpisodeContinuity(
                    seededShuffle([ ...themeItems ], seed),
                    themeItems
                );
                genreChannels.push({ items: shuffled, name, tint: theme.tint, accent: theme.accent });
            }
        }

        // ---- Random channels: one per genre channel for spontaneity ----
        // Seeds use a large offset (10 000+) so they never collide with genre seeds.
        const randomChannels: ChannelSchedule[] = [];
        for (let i = 0; i < genreChannels.length; i++) {
            const pal = FALLBACK_PALETTE[i % FALLBACK_PALETTE.length];
            const seed = dateChannelSeed(utcDay, 10_000 + i);
            const shuffled = applyEpisodeContinuity(
                seededShuffle([ ...sortedItems ], seed),
                sortedItems
            );
            randomChannels.push({ items: shuffled, name: 'MIX', tint: pal.tint, accent: pal.accent });
        }

        // Final channel list: genre channels first, then random channels.
        // Falls back to plain numbered channels if the library has no genre tags.
        let channels: ChannelSchedule[];
        if (genreChannels.length > 0) {
            channels = [ ...genreChannels, ...randomChannels ];
        } else {
            channels = [];
            const numChannels = Math.min(config.maxChannels, sortedItems.length);
            for (let i = 0; i < numChannels; i++) {
                const pal = FALLBACK_PALETTE[i % FALLBACK_PALETTE.length];
                const seed = dateChannelSeed(utcDay, i);
                const shuffled = applyEpisodeContinuity(
                    seededShuffle([ ...sortedItems ], seed),
                    sortedItems
                );
                channels.push({
                    items: shuffled,
                    name: String(i + 1).padStart(2, '0'),
                    tint: pal.tint,
                    accent: pal.accent
                });
            }
        }

        console.log(
            `[ChannelSurf] ${genreChannels.length} genre + ${randomChannels.length} mix = `
            + `${channels.length} channels from ${sortedItems.length} items (utcDay=${utcDay})`
        );
        console.log('[ChannelSurf] channels:', channels.map((c, i) => `${i + 1}:${c.name}`).join(', '));

        this._queue = {
            channels,
            maxChannels: config.maxChannels,
            index: 0,
            libraryIds: config.libraryIds,
            wallStartMs: Date.now(),
            clockProgress: config.clockProgress
        };
        this._saveQueueToSession(this._queue);
        return this._queue;
    }

    private async _fetchQueueItems(libraryIds: string[]): Promise<SurfQueueItem[]> {
        const { api, user } = this._apiContext ?? {};
        if (!api || !user?.Id) return [];

        const types = [ BaseItemKind.Movie, BaseItemKind.Episode ];

        const fetchParent = async (parentId?: string): Promise<SurfQueueItem[]> => {
            const res = await getItemsApi(api).getItems({
                userId: user.Id!,
                includeItemTypes: types,
                recursive: true,
                // Match the guide's limit exactly so both systems draw from the same pool.
                limit: ITEMS_PER_FETCH,
                ...(parentId ? { parentId } : {}),
                fields: [ ItemFields.Genres ]
            });
            return (res.data.Items ?? [])
                .filter(i => (i.RunTimeTicks ?? 0) > 0 && i.Id)
                .map(i => ({
                    id: i.Id!,
                    runTimeTicks: i.RunTimeTicks!,
                    genres: (i.Genres ?? []).map(g => g.toLowerCase()),
                    seriesId: i.SeriesId ?? null,
                    parentIndexNumber: i.ParentIndexNumber ?? null,
                    indexNumber: i.IndexNumber ?? null
                }));
        };

        if (libraryIds.length === 0) return fetchParent();

        const batches = await Promise.all(libraryIds.map(id => fetchParent(id)));
        const seen = new Set<string>();
        return batches.flat().filter(item => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
        });
    }

}

export const channelSurfManager = new ChannelSurfManager();

// Expose for browser-console debugging (e.g. shiftWallClock to test overflow).
(window as unknown as Record<string, unknown>).channelSurfManager = channelSurfManager;
