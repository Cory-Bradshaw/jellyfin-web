import { useCallback, useState } from 'react';

import { useApi } from 'hooks/useApi';
import { useChannelSurfConfig } from 'hooks/useChannelSurfConfig';
import { channelSurfManager } from 'components/channelSurf/channelSurfManager';

export function useChannelSurf() {
    const apiContext = useApi();
    const { config } = useChannelSurfConfig();
    const [ isSurfing, setIsSurfing ] = useState(false);

    const surf = useCallback(async () => {
        if (isSurfing) return;
        setIsSurfing(true);
        try {
            channelSurfManager.setApiContext(apiContext);
            await channelSurfManager.buildAndSurf(config);
        } catch (err) {
            console.error('[useChannelSurf] failed to surf', err);
        } finally {
            setIsSurfing(false);
        }
    }, [ isSurfing, apiContext, config ]);

    return { surf, isSurfing };
}
