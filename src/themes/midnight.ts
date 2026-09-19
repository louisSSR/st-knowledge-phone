import type { PhoneTheme } from './types.js';

export const midnight: PhoneTheme = {
  id: 'midnight', name: '午夜书房', description: '墨紫、薄金与安静的阅读时光',
  tokens: {
    background: '#15131e', surface: '#201c2d', elevated: '#2b263b', border: '#393146',
    text: '#f0eaf5', muted: '#b8aec8', accent: '#c4b0f2', accentText: '#251b3e',
    gold: '#d4ba89', danger: '#ffacb0', success: '#a7d4bd',
    artwork: 'radial-gradient(ellipse at 94% 5%, #75619645, transparent 65%), linear-gradient(130deg, #2f263e, #201c2d)',
  },
};
