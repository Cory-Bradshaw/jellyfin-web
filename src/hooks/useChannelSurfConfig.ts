import { useLocalStorage } from 'hooks/useLocalStorage';

export interface ChannelSurfConfig {
    /** Library IDs to include. Empty array means all movie + episode libraries. */
    libraryIds: string[];
    /**
     * Always true — each channel's virtual clock advances in real time so the
     * Channel Guide and surf playback stay in sync. Not user-configurable.
     */
    clockProgress: true;
    /** Maximum number of distinct channels to create. Default 50. */
    maxChannels: number;
}

const DEFAULT_CONFIG: ChannelSurfConfig = { libraryIds: [], clockProgress: true, maxChannels: 50 };
const STORAGE_KEY = 'channelSurf.config';

export function useChannelSurfConfig() {
    const [ stored, setConfig ] = useLocalStorage<Partial<ChannelSurfConfig>>(STORAGE_KEY, DEFAULT_CONFIG);
    // Merge with defaults, then force clockProgress: true regardless of any
    // stale stored value (older sessions may have had it set to false).
    const config: ChannelSurfConfig = { ...DEFAULT_CONFIG, ...stored, clockProgress: true };

    const setLibraryIds = (ids: string[]) => setConfig(prev => ({ ...prev, libraryIds: ids }));
    const setMaxChannels = (n: number) => setConfig(prev => ({ ...prev, maxChannels: Math.max(1, Math.min(100, n)) }));

    return { config, setLibraryIds, setMaxChannels };
}
