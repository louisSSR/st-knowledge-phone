import { midnight } from './midnight.js';
import { noGameNoLife } from './no-game-no-life.js';
/** Register local, reviewed theme modules here. Themes contain tokens, never executable pack data. */
const themes = [midnight, noGameNoLife];
export function availableThemes() { return themes; }
export function themeCSS(id) {
    const theme = themes.find(item => item.id === id) ?? midnight;
    return `:host{${Object.entries(theme.tokens).map(([key, value]) => `--kp-${key}:${value}`).join(';')}}`;
}
