import React, { FC, useCallback, useState } from 'react';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import LiveTvIcon from '@mui/icons-material/LiveTv';
import SettingsIcon from '@mui/icons-material/Settings';

import { useChannelSurf } from 'hooks/useChannelSurf';
import { channelSurfManager } from './channelSurfManager';
import ChannelSurfConfigPanel from './ChannelSurfConfigPanel';

import './ChannelSurfButton.scss';

const ChannelSurfButton: FC = () => {
    const { surf, isSurfing } = useChannelSurf();
    const [ configAnchor, setConfigAnchor ] = useState<HTMLElement | null>(null);

    const handleSurf = useCallback(() => {
        void surf();
    }, [ surf ]);

    const handleConfigOpen = useCallback((e: React.MouseEvent<HTMLElement>) => {
        setConfigAnchor(e.currentTarget);
    }, []);

    const handleConfigClose = useCallback(() => {
        setConfigAnchor(null);
        channelSurfManager.invalidate();
    }, []);

    const handleLibraryChange = useCallback(() => {
        // Panel stays open; queue is invalidated on close.
    }, []);

    return (
        <div className='channelSurfBar'>
            <Button
                className='channelSurfButton'
                startIcon={<LiveTvIcon />}
                onClick={handleSurf}
                disabled={isSurfing}
            >
                {'Channel Surf'}
            </Button>

            <Tooltip title='Configure channel surf'>
                <span>
                    <IconButton
                        className='channelSurfNav'
                        onClick={handleConfigOpen}
                        disabled={isSurfing}
                        size='small'
                        aria-label='Configure channel surf'
                    >
                        <SettingsIcon />
                    </IconButton>
                </span>
            </Tooltip>

            <ChannelSurfConfigPanel
                anchorEl={configAnchor}
                onClose={handleConfigClose}
                onLibraryChange={handleLibraryChange}
            />
        </div>
    );
};

export default ChannelSurfButton;
