import { midnight } from './midnight.js';
import { noGameNoLife } from './no-game-no-life.js';
import type { PhoneTheme } from './types.js';

/** Register local, reviewed theme modules here. Themes contain tokens, never executable pack data. */
const themes: PhoneTheme[] = [midnight, noGameNoLife];
export function availableThemes(): readonly PhoneTheme[] { return themes; }
export function themeCSS(id: string): string {
  const theme = themes.find(item => item.id === id) ?? midnight;
  return `:host{${Object.entries(theme.tokens).map(([key, value]) => `--kp-${key}:${value}`).join(';')}}`;
}
