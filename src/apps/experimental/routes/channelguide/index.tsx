import Toolbar from '@mui/material/Toolbar';
import React, { FC } from 'react';

import Page from 'components/Page';
import ChannelGuide from 'components/channelGuide/ChannelGuide';

const ChannelGuidePage: FC = () => (
    <Page
        id='channelGuidePage'
        className='mainAnimatedPage backdropPage'
        isBackButtonEnabled={false}
    >
        {/* Spacer that matches the fixed AppBar height (dense Toolbar = 48px) */}
        <Toolbar variant='dense' />
        <ChannelGuide />
    </Page>
);

export default ChannelGuidePage;
