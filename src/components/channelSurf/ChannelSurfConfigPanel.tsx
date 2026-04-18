import React, { FC, useCallback } from 'react';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client';
import Checkbox from '@mui/material/Checkbox';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormGroup from '@mui/material/FormGroup';
import Popover from '@mui/material/Popover';
import Slider from '@mui/material/Slider';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';

import { useApi } from 'hooks/useApi';
import { useChannelSurfConfig } from 'hooks/useChannelSurfConfig';
import { useUserViews } from 'hooks/useUserViews';

// ---------------------------------------------------------------------------
// Sub-component: one library row (avoids arrow-function-in-JSX lint error)
// ---------------------------------------------------------------------------

interface LibraryRowProps {
    lib: BaseItemDto;
    isChecked: boolean;
    isDisabled: boolean;
    onToggle: (id: string, checked: boolean) => void;
}

const LibraryRow: FC<LibraryRowProps> = ({ lib, isChecked, isDisabled, onToggle }) => {
    const handleChange = useCallback((_e: React.ChangeEvent, checked: boolean) => {
        onToggle(lib.Id ?? '', checked);
    }, [ lib.Id, onToggle ]);

    return (
        <FormControlLabel
            control={
                <Checkbox
                    checked={isChecked}
                    disabled={isDisabled}
                    onChange={handleChange}
                    size='small'
                />
            }
            label={lib.Name ?? lib.Id ?? ''}
        />
    );
};

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

interface ChannelSurfConfigPanelProps {
    anchorEl: HTMLElement | null;
    onClose: () => void;
    onLibraryChange: () => void;
}

const MAX_CHANNELS_MIN = 1;
const MAX_CHANNELS_MAX = 100;

const ChannelSurfConfigPanel: FC<ChannelSurfConfigPanelProps> = ({
    anchorEl,
    onClose,
    onLibraryChange
}) => {
    const { user } = useApi();
    const { config, setLibraryIds, setMaxChannels } = useChannelSurfConfig();
    const { data: views, isLoading } = useUserViews(user?.Id);

    const libraries = views?.Items ?? [];
    const allChecked = config.libraryIds.length === 0;

    const handleToggle = useCallback((libraryId: string, checked: boolean) => {
        const next = checked ?
            [ ...config.libraryIds, libraryId ] :
            config.libraryIds.filter(id => id !== libraryId);
        setLibraryIds(next);
        onLibraryChange();
    }, [ config.libraryIds, setLibraryIds, onLibraryChange ]);

    const handleAllToggle = useCallback((_e: React.ChangeEvent, checked: boolean) => {
        if (checked) {
            setLibraryIds([]);
            onLibraryChange();
        }
    }, [ setLibraryIds, onLibraryChange ]);

    const handleMaxChannelsChange = useCallback((_e: Event, value: number | number[]) => {
        setMaxChannels(Array.isArray(value) ? value[0] : value);
        onLibraryChange();
    }, [ setMaxChannels, onLibraryChange ]);

    return (
        <Popover
            open={Boolean(anchorEl)}
            anchorEl={anchorEl}
            onClose={onClose}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
            transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        >
            <div className='channelSurfConfig'>
                <Typography variant='subtitle2' className='channelSurfConfigTitle'>
                    {'Surf from'}
                </Typography>

                {isLoading ? (
                    <CircularProgress size={20} />
                ) : (
                    <FormGroup>
                        <FormControlLabel
                            control={
                                <Checkbox
                                    checked={allChecked}
                                    onChange={handleAllToggle}
                                    size='small'
                                />
                            }
                            label='All libraries'
                        />

                        {libraries.map(lib => (
                            <LibraryRow
                                key={lib.Id}
                                lib={lib}
                                isChecked={!allChecked && config.libraryIds.includes(lib.Id ?? '')}
                                isDisabled={false}
                                onToggle={handleToggle}
                            />
                        ))}
                    </FormGroup>
                )}

                <Divider sx={{ my: 1 }} />

                <div className='channelSurfMaxChannels'>
                    <Typography variant='body2'>
                        {`Channels: ${config.maxChannels}`}
                    </Typography>
                    <Slider
                        value={config.maxChannels}
                        min={MAX_CHANNELS_MIN}
                        max={MAX_CHANNELS_MAX}
                        step={1}
                        onChange={handleMaxChannelsChange}
                        size='small'
                        valueLabelDisplay='auto'
                        aria-label='Max channels'
                    />
                </div>
            </div>
        </Popover>
    );
};

export default ChannelSurfConfigPanel;
