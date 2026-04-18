import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getItemsApi } from '@jellyfin/sdk/lib/utils/api/items-api';
import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import { ItemFields } from '@jellyfin/sdk/lib/generated-client/models/item-fields';
import { getUserLibraryApi } from '@jellyfin/sdk/lib/utils/api/user-library-api';

import { useApi } from 'hooks/useApi';
import { useChannelSurfConfig } from 'hooks/useChannelSurfConfig';
import { channelSurfManager } from 'components/channelSurf/channelSurfManager';
import {
    WINDOW_MS,
    computeSchedule,
    fmtTime,
    fmtRuntime,
    type GuideItem
} from './channelGuideUtils';
import { playbackManager } from 'components/playback/playbackmanager';

import './ChannelGuide.scss';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const ROW_H_PX = 100;   // keep in sync with $row-h in ChannelGuide.scss
// Seconds per row for the continuous scroll — lower = faster
const SCROLL_SPEED_S_PER_ROW = 5;

// ---------------------------------------------------------------------------
// Shared channel-row type
// ---------------------------------------------------------------------------

type ChannelRow = {
    index: number;
    name: string;
    number: string;
    tint: string;
    accent: string;
    items: GuideItem[];
};

// ---------------------------------------------------------------------------
// ProgressPie — SVG donut showing elapsed fraction
// ---------------------------------------------------------------------------

const ProgressPie: FC<{ progress: number }> = ({ progress }) => {
    const r = 32;
    const cx = 44;
    const cy = 44;
    const strokeW = 8;
    const circumference = 2 * Math.PI * r;
    const offset = circumference * (1 - Math.min(1, Math.max(0, progress)));
    const pct = Math.round(progress * 100);

    return (
        <svg className='cg-meta-pie' viewBox='0 0 88 88' aria-label={`${pct}% complete`}>
            {/* track */}
            <circle cx={cx} cy={cy} r={r} fill='none'
                stroke='rgba(255,255,255,0.08)' strokeWidth={strokeW} />
            {/* progress arc */}
            <circle
                cx={cx} cy={cy} r={r}
                fill='none'
                stroke='#ff3ea5'
                strokeWidth={strokeW}
                strokeLinecap='round'
                strokeDasharray={circumference}
                strokeDashoffset={offset}
                transform={`rotate(-90 ${cx} ${cy})`}
                style={{ transition: 'stroke-dashoffset 1.5s ease' }}
            />
            {/* centre label */}
            <text x={cx} y={cy - 5} textAnchor='middle' fill='#fff'
                fontSize='16' fontFamily='VT323, monospace' dominantBaseline='middle'>
                {pct}
            </text>
            <text x={cx} y={cx + 11} textAnchor='middle' fill='rgba(255,255,255,0.45)'
                fontSize='10' fontFamily='Space Mono, monospace' dominantBaseline='middle'>
                {'%'}
            </text>
        </svg>
    );
};

// ---------------------------------------------------------------------------
// NowPlayingPanel — metadata for the focused / top channel
// ---------------------------------------------------------------------------

interface NowPlayingPanelProps {
    channel: ChannelRow | null;
    nowMs: number;
    serverUrl: string;
    onJump: (item: GuideItem) => void;
}

const NowPlayingPanel: FC<NowPlayingPanelProps> = ({ channel, nowMs, serverUrl, onJump }) => {
    const { api, user } = useApi();

    const currentItem = useMemo(() =>
        channel?.items.find(i => i.startMs <= nowMs && i.endMs > nowMs)
        ?? channel?.items.find(i => i.startMs > nowMs)   // next up
        ?? null
    , [ channel, nowMs ]);

    const { data: people = [] } = useQuery({
        queryKey: [ 'channelGuide', 'people', currentItem?.id ],
        queryFn: async () => {
            if (!api || !user?.Id || !currentItem?.id) return [];
            const res = await getUserLibraryApi(api).getItem({ userId: user.Id, itemId: currentItem.id });
            return (res.data.People ?? []).filter(p => p.Type === 'Actor').slice(0, 10);
        },
        enabled: !!api && !!user?.Id && !!currentItem?.id,
        staleTime: 10 * 60 * 1000
    });

    if (!channel || !currentItem) return null;

    const isLive = currentItem.startMs <= nowMs && currentItem.endMs > nowMs;
    const elapsed = isLive ? Math.max(0, nowMs - currentItem.startMs) : 0;
    const totalMs = (currentItem.runTimeTicks ?? 0) / 10_000;
    const progress = totalMs > 0 ? elapsed / totalMs : 0;
    const remainingTicks = Math.max(0, currentItem.runTimeTicks - elapsed * 10_000);

    const imgUrl = currentItem.primaryImageTag
        ? `${serverUrl}/Items/${currentItem.id}/Images/Primary?tag=${currentItem.primaryImageTag}&maxHeight=400&quality=80`
        : null;

    const actorNames = people.map(p => p.Name).filter(Boolean).join('  ·  ');

    const handleJump = useCallback(() => onJump(currentItem), [ currentItem, onJump ]);

    return (
        <div className='cg-meta-panel' style={{ '--accent': channel.accent } as React.CSSProperties}>
            {imgUrl && <img className='cg-meta-thumb' src={imgUrl} alt='' />}

            <div className='cg-meta-info'>
                <div className='cg-meta-channel'>
                    {`CH ${channel.number}  —  ${channel.name}`}
                    {!isLive && <span className='cg-meta-up-next'>{'UP NEXT'}</span>}
                </div>
                <div className='cg-meta-title'>{currentItem.seriesName ?? currentItem.title}</div>
                {currentItem.seriesName && (
                    <div className='cg-meta-episode'>{currentItem.title}</div>
                )}
                <div className='cg-meta-sub'>
                    {[ currentItem.year, currentItem.rating, fmtRuntime(currentItem.runTimeTicks) ]
                        .filter(Boolean).join('  ·  ')}
                </div>
                {currentItem.overview && (
                    <p className='cg-meta-overview'>{currentItem.overview}</p>
                )}
                {actorNames && (
                    <div className='cg-meta-actors'>
                        <span className='cg-meta-actors-label'>{'CAST'}</span>
                        {actorNames}
                    </div>
                )}
            </div>

            <div className='cg-meta-sidebar'>
                <ProgressPie progress={progress} />
                {isLive && (
                    <div className='cg-meta-pie-label'>
                        {fmtRuntime(remainingTicks)}{' left'}
                    </div>
                )}
                <button className='cg-jump-btn cg-meta-watch-btn' onClick={handleJump}>
                    {'▶ WATCH NOW'}
                </button>
            </div>
        </div>
    );
};

// ---------------------------------------------------------------------------
// ProgramBlock
// ---------------------------------------------------------------------------

interface ProgramBlockProps {
    item: GuideItem;
    viewStartMs: number; // left edge of the track = hourStart (start of the current clock-hour)
    nowMs: number;       // actual current time — used only for the isNow highlight
    accent: string;
    serverUrl: string;
    onJump: (item: GuideItem) => void;
}

const ProgramBlock: FC<ProgramBlockProps> = ({ item, viewStartMs, nowMs, accent, serverUrl, onJump }) => {
    const leftPct = Math.max(0, (item.startMs - viewStartMs) / WINDOW_MS * 100);
    const rightPct = Math.max(0, (viewStartMs + WINDOW_MS - item.endMs) / WINDOW_MS * 100);
    const isNow = item.startMs <= nowMs && item.endMs > nowMs;

    const imgUrl = item.primaryImageTag
        ? `${serverUrl}/Items/${item.id}/Images/Primary?tag=${item.primaryImageTag}&maxHeight=120&quality=70`
        : null;

    const handleJump = useCallback(() => onJump(item), [ item, onJump ]);

    return (
        <div
            className={`cg-block${isNow ? ' cg-block--now' : ''}`}
            style={{ left: `${leftPct}%`, right: `${rightPct}%`, '--accent': accent } as React.CSSProperties}
        >
            <div className='cg-block-inner'>
                <span className='cg-block-title'>{item.seriesName ?? item.title}</span>
                <span className='cg-block-meta'>
                    {item.year ? `${item.year} · ` : ''}{fmtRuntime(item.runTimeTicks)}
                </span>
            </div>
            <div className='cg-popover'>
                {imgUrl && <img className='cg-popover-img' src={imgUrl} alt='' loading='lazy' />}
                <div className='cg-popover-body'>
                    <div className='cg-popover-title'>{item.seriesName ?? item.title}</div>
                    {item.seriesName && (
                        <div className='cg-popover-episode'>{item.title}</div>
                    )}
                    {(item.year || item.rating) && (
                        <div className='cg-popover-sub'>
                            {[ item.year, item.rating ].filter(Boolean).join(' · ')}
                            {' · '}{fmtRuntime(item.runTimeTicks)}
                        </div>
                    )}
                    {item.overview && <p className='cg-popover-overview'>{item.overview}</p>}
                    <div className='cg-popover-time'>
                        {fmtTime(item.startMs)} – {fmtTime(item.endMs)}
                    </div>
                    <button className='cg-jump-btn' onClick={handleJump}>
                        {'▶ JUMP TO BROADCAST'}
                    </button>
                </div>
            </div>
        </div>
    );
};

// ---------------------------------------------------------------------------
// Live clock
// ---------------------------------------------------------------------------

function useLiveClock(intervalMs = 30_000) {
    const [ nowMs, setNowMs ] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNowMs(Date.now()), intervalMs);
        return () => clearInterval(id);
    }, [ intervalMs ]);
    return nowMs;
}

// ---------------------------------------------------------------------------
// Hour axis
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;

function fmtHour(ms: number) {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
}

interface HourAxisProps {
    nowMs: number;
    hourStart: number; // = Math.floor(nowMs / HOUR_MS) * HOUR_MS
}

const HourAxis: FC<HourAxisProps> = ({ nowMs, hourStart }) => {
    const nowLeftPct = (nowMs - hourStart) / WINDOW_MS * 100;
    const hours: number[] = [];
    for (let h = hourStart; h < hourStart + WINDOW_MS; h += HOUR_MS) {
        hours.push(h);
    }

    return (
        <div className='cg-time-axis'>
            <div className='cg-time-gutter' />
            <div className='cg-time-track'>
                {/* NOW line at the actual elapsed position within the first hour block */}
                <div className='cg-time-now-line' style={{ left: `${nowLeftPct}%` }} aria-hidden='true' />
                {hours.map((hStart, i) => {
                    const leftPct = (hStart - hourStart) / WINDOW_MS * 100;
                    const widthPct = HOUR_MS / WINDOW_MS * 100;
                    return (
                        <div
                            key={hStart}
                            className={`cg-hour-block${i === 0 ? ' cg-hour-block--current' : ''}`}
                            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                        >
                            <span className='cg-hour-label'>{fmtHour(hStart)}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

const ChannelGuide: FC = () => {
    const apiContext = useApi();
    const { api, user } = apiContext;
    const { config } = useChannelSurfConfig();
    const nowMs = useLiveClock();
    // Anchor the entire view to the start of the current clock-hour so the NOW
    // marker appears inside the first hour block rather than at the track edge.
    const hourStart = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    const nowFrac = (nowMs - hourStart) / WINDOW_MS; // 0–1 fraction across the full window
    const serverUrl = api?.basePath ?? '';
    const [ isPaused, setIsPaused ] = useState(false);

    // -----------------------------------------------------------------------
    // Track which channel is at the top of the scrolling grid
    // (state + refs declared early; effect runs after totalCh is available)
    // -----------------------------------------------------------------------
    const [ topChannelIdx, setTopChannelIdx ] = useState(0);
    const [ hoveredChannelIdx, setHoveredChannelIdx ] = useState<number | null>(null);
    const elapsedMsRef = useRef(0);
    const lastTickRef = useRef<number | null>(null);

    // Keep the surf manager's API context in sync.
    useEffect(() => {
        if (api && user) channelSurfManager.setApiContext(apiContext);
    }, [ apiContext, api, user ]);

    // -----------------------------------------------------------------------
    // Queue + metadata (surf manager is the single source of truth)
    // -----------------------------------------------------------------------

    const { data: queueReady = false } = useQuery({
        queryKey: [ 'channelGuide', 'queue', user?.Id, config.libraryIds, config.maxChannels, config.clockProgress ],
        queryFn: () => channelSurfManager.prepareQueue(config),
        staleTime: 60 * 60 * 1000,
        enabled: !!api && !!user?.Id
    });

    const { data: metaMap = new Map() } = useQuery({
        queryKey: [ 'channelGuide', 'meta', user?.Id, config.libraryIds ],
        queryFn: async ({ signal }) => {
            if (!api || !user?.Id) return new Map<string, Omit<GuideItem, 'id' | 'startMs' | 'endMs'>>();

            const fetchParent = async (parentId?: string) => {
                const res = await getItemsApi(api).getItems({
                    userId: user.Id!,
                    includeItemTypes: [ BaseItemKind.Movie, BaseItemKind.Episode ],
                    recursive: true,
                    limit: 500,
                    ...(parentId ? { parentId } : {}),
                    fields: [ ItemFields.Overview ],
                    imageTypeLimit: 1,
                    enableImageTypes: [ ImageType.Primary ]
                }, { signal });
                return res.data.Items ?? [];
            };

            const allItems = config.libraryIds.length === 0
                ? await fetchParent()
                : (await Promise.all(config.libraryIds.map(id => fetchParent(id)))).flat();

            const map = new Map<string, Omit<GuideItem, 'id' | 'startMs' | 'endMs'>>();
            for (const i of allItems) {
                if (!i.Id || (i.RunTimeTicks ?? 0) === 0) continue;
                map.set(i.Id, {
                    title: i.Name ?? i.Id,
                    seriesName: i.SeriesName ?? null,
                    seriesId: i.SeriesId ?? null,
                    year: i.ProductionYear ?? null,
                    rating: i.OfficialRating ?? null,
                    overview: i.Overview ?? null,
                    runTimeTicks: i.RunTimeTicks!,
                    primaryImageTag: i.ImageTags?.Primary ?? null
                });
            }
            return map;
        },
        staleTime: 60 * 60 * 1000,
        enabled: !!api && !!user?.Id
    });

    const totalCh = queueReady ? channelSurfManager.totalChannels : 0;

    // Effect for top-channel tracking — placed after totalCh is in scope.
    useEffect(() => {
        if (totalCh === 0) return;
        const id = setInterval(() => {
            const now = Date.now();
            if (!isPaused) {
                if (lastTickRef.current !== null) {
                    elapsedMsRef.current += now - lastTickRef.current;
                }
            }
            lastTickRef.current = now;
            setTopChannelIdx(
                Math.floor(elapsedMsRef.current / (SCROLL_SPEED_S_PER_ROW * 1000)) % totalCh
            );
        }, 250);
        return () => { clearInterval(id); lastTickRef.current = null; };
    }, [ isPaused, totalCh ]);

    // -----------------------------------------------------------------------
    // Build all channel data (no windowing — all channels for seamless scroll)
    // -----------------------------------------------------------------------

    const allChannels = useMemo(() => {
        if (!queueReady || metaMap.size === 0 || totalCh === 0) return [];

        return Array.from({ length: totalCh }, (_, chIdx) => {
            const def = channelSurfManager.getChannelDef(chIdx) ?? {
                name: String(chIdx + 1).padStart(2, '0'),
                number: String(chIdx + 1).padStart(2, '0'),
                tint: 'rgba(100,100,100,0.06)',
                accent: '#aaaaaa'
            };
            const queueItems = channelSurfManager.getChannelQueue(chIdx) ?? [];
            const slots = computeSchedule(queueItems, nowMs);
            const items: GuideItem[] = slots.flatMap(slot => {
                const meta = metaMap.get(slot.id);
                return meta ? [{ id: slot.id, ...meta, startMs: slot.startMs, endMs: slot.endMs }] : [];
            });
            return { index: chIdx, ...def, items } as ChannelRow;
        });
    }, [ queueReady, metaMap, totalCh, nowMs ]);

    const displayedChannel = useMemo(() => {
        const idx = hoveredChannelIdx ?? topChannelIdx;
        return allChannels[idx] ?? null;
    }, [ hoveredChannelIdx, topChannelIdx, allChannels ]);

    // -----------------------------------------------------------------------
    // Jump to broadcast
    // -----------------------------------------------------------------------

    const handleJump = useCallback(async (item: GuideItem) => {
        if (!api || !user?.Id) return;
        const positionTicks = Math.max(0, Math.floor((Date.now() - item.startMs) * 10_000));
        try {
            const res = await getUserLibraryApi(api).getItem({ userId: user.Id, itemId: item.id });
            if (!res.data) return;
            await (playbackManager as { play: (opts: object) => Promise<void> })
                .play({ items: [ res.data ], startPositionTicks: positionTicks });
        } catch { /* ignore */ }
    }, [ api, user?.Id ]);

    // -----------------------------------------------------------------------
    // Surf directly to a channel
    // -----------------------------------------------------------------------

    const handleChannelClick = useCallback((channelIndex: number) => {
        void channelSurfManager.surfAtChannel(channelIndex);
    }, []);

    // -----------------------------------------------------------------------
    // Ticker + clock
    // -----------------------------------------------------------------------

    const tickerText = useMemo(() =>
        allChannels
            .flatMap(ch => ch.items.map(i => `${ch.number}  ·  ${i.title}`))
            .join('     ★     ')
    , [ allChannels ]);

    const clockStr = new Date(nowMs).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });

    if (allChannels.length === 0) return null;

    // Duplicate channels for seamless CSS scroll loop
    const scrollRows = [ ...allChannels, ...allChannels ];
    const scrollDuration = totalCh * SCROLL_SPEED_S_PER_ROW;
    const scrollHeight = totalCh * ROW_H_PX;

    return (
        <div
            className='cg-root'
            onMouseEnter={() => setIsPaused(true)}
            onMouseLeave={() => { setIsPaused(false); setHoveredChannelIdx(null); }}
        >
            <div className='cg-scanlines' aria-hidden='true' />
            <div className='cg-vignette' aria-hidden='true' />

            {/* Now-playing metadata panel — top ≤ 1/3 of screen */}
            <NowPlayingPanel
                channel={displayedChannel}
                nowMs={nowMs}
                serverUrl={serverUrl}
                onJump={handleJump}
            />

            <div className='cg-masthead'>
                <span className='cg-wordmark'>{'CHANNEL GUIDE'}</span>
                <div className='cg-live-badge'>
                    <span className='cg-live-dot' />
                    {'LIVE'}
                </div>
                <span className='cg-ch-counter'>{`${totalCh} channels`}</span>
                <span className='cg-clock'>{clockStr}</span>
            </div>

            <HourAxis nowMs={nowMs} hourStart={hourStart} />

            <div
                className='cg-grid-clip'
                style={{ '--now-frac': nowFrac } as React.CSSProperties}
            >
                {/* NOW bar — full-height line at the elapsed position within the first hour block */}
                <div className='cg-now-bar' aria-hidden='true' />
                <div
                    className='cg-grid-inner'
                    style={{
                        animationDuration: `${scrollDuration}s`,
                        animationPlayState: isPaused ? 'paused' : 'running',
                        '--scroll-h': `${scrollHeight}px`
                    } as React.CSSProperties}
                >
                    {scrollRows.map((ch, rowIdx) => (
                        <div
                            key={`${ch.index}-${rowIdx}`}
                            className='cg-row'
                            style={{ '--tint': ch.tint, '--accent': ch.accent } as React.CSSProperties}
                            onClick={() => handleChannelClick(ch.index)}
                            onMouseEnter={() => setHoveredChannelIdx(ch.index)}
                            onMouseLeave={() => setHoveredChannelIdx(null)}
                        >
                            <div className='cg-gutter'>
                                <span className='cg-ch-number'>{ch.number}</span>
                                <span className='cg-ch-name'>{ch.name}</span>
                            </div>
                            <div className='cg-track'>
                                {ch.items.map(item => (
                                    <ProgramBlock
                                        key={`${item.id}-${item.startMs}`}
                                        item={item}
                                        viewStartMs={hourStart}
                                        nowMs={nowMs}
                                        accent={ch.accent}
                                        serverUrl={serverUrl}
                                        onJump={handleJump}
                                    />
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            <div className='cg-ticker-bar'>
                <span className='cg-ticker-label'>{'NOW PLAYING'}</span>
                <div className='cg-ticker-track'>
                    <span className='cg-ticker-text' aria-hidden='true'>
                        {tickerText}{'     ★     '}{tickerText}
                    </span>
                </div>
            </div>
        </div>
    );
};

export default ChannelGuide;
