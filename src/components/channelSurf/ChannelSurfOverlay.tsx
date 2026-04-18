/**
 * Always-mounted root-level component that shows the static → tuning
 * animation whenever channelSurfManager fires CHANNEL_SURF_TRANSITION.
 * Also keeps the manager's apiContext current.
 */

import React, { FC, useCallback, useEffect, useRef, useState } from 'react';

import { useApi } from 'hooks/useApi';
import { channelSurfManager, CHANNEL_SURF_TRANSITION, CHANNEL_SURF_READY } from './channelSurfManager';

import './ChannelSurfButton.scss';

type TuningPhase = 'idle' | 'static' | 'tuning' | 'playing';

const TUNING_MS = 800;
const PLAYING_MS = 500; // brief fade before auto-dismiss
const STATIC_TIMEOUT_MS = 15_000; // safety cap — hide static if ready never fires

const ChannelSurfOverlay: FC = () => {
    const apiContext = useApi();
    const [ phase, setPhase ] = useState<TuningPhase>('idle');
    const [ channelNumber, setChannelNumber ] = useState<string | null>(null);
    const [ channelName, setChannelName ] = useState<string | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const staticCanvasRef = useStaticCanvas();

    // Keep manager hydrated with the current API context.
    useEffect(() => {
        channelSurfManager.setApiContext(apiContext);
    }, [ apiContext ]);

    const clearTimer = useCallback(() => {
        if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    useEffect(() => {
        const afterPlaying = () => {
            setPhase('idle');
        };
        const afterTuning = () => {
            setPhase('playing');
            timerRef.current = setTimeout(afterPlaying, PLAYING_MS);
        };
        const startTuning = () => {
            clearTimer();
            setPhase('tuning');
            timerRef.current = setTimeout(afterTuning, TUNING_MS);
        };
        const handleReady = () => {
            startTuning();
        };
        const handleTransition = (e: Event) => {
            const detail = (e as CustomEvent<{ channelNumber?: string; channelName?: string }>).detail ?? {};
            const num = detail.channelNumber ?? null;
            const name = detail.channelName ?? null;
            setChannelNumber(num);
            setChannelName(name);
            clearTimer();
            setPhase('static');
            // Safety: if ready never fires (e.g. fetch error), dismiss anyway.
            timerRef.current = setTimeout(startTuning, STATIC_TIMEOUT_MS);
        };

        window.addEventListener(CHANNEL_SURF_TRANSITION, handleTransition);
        window.addEventListener(CHANNEL_SURF_READY, handleReady);
        return () => {
            window.removeEventListener(CHANNEL_SURF_TRANSITION, handleTransition);
            window.removeEventListener(CHANNEL_SURF_READY, handleReady);
            clearTimer();
        };
    }, [ clearTimer ]);

    if (phase === 'idle') return null;

    return (
        <div className={`channelSurfOverlay channelSurfOverlay--${phase}`} aria-hidden='true'>
            {phase === 'static' && (
                <>
                    <canvas className='channelSurfStatic' ref={staticCanvasRef} />
                    {channelNumber && (
                        <div className='channelSurfChDisplay'>
                            <span className='channelSurfChLabel'>{'CH'}</span>
                            <span className='channelSurfChNum'>{channelNumber}</span>
                            {channelName && <span className='channelSurfChTheme'>{channelName}</span>}
                        </div>
                    )}
                </>
            )}
            {phase === 'tuning' && (
                <div className='channelSurfTuning'>
                    {channelNumber && (
                        <div className='channelSurfTuningCh'>
                            <span className='channelSurfChLabel'>{'CH'}</span>
                            <span className='channelSurfChNum'>{channelNumber}</span>
                            {channelName && <span className='channelSurfChTheme'>{channelName}</span>}
                        </div>
                    )}
                    <span className='channelSurfTuningDot' />
                    <span className='channelSurfTuningLabel'>{'Tuning in\u2026'}</span>
                </div>
            )}
        </div>
    );
};

/** Callback ref that drives an rAF static-noise loop while mounted. */
function useStaticCanvas() {
    const rafRef = useRef<number | null>(null);

    return useCallback((canvas: HTMLCanvasElement | null) => {
        if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const draw = () => {
            const { width: w, height: h } = canvas;
            const imageData = ctx.createImageData(w, h);
            const buf = imageData.data;
            for (let i = 0; i < buf.length; i += 4) {
                // eslint-disable-next-line sonarjs/pseudo-random
                const v = (Math.random() * 255) | 0;
                buf[i] = v;
                buf[i + 1] = v;
                buf[i + 2] = v;
                buf[i + 3] = 255;
            }
            ctx.putImageData(imageData, 0, 0);
            rafRef.current = requestAnimationFrame(draw);
        };

        draw();
    }, []);
}

export default ChannelSurfOverlay;
