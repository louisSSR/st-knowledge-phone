export interface PhoneTheme {
  id: string;
  name: string;
  description: string;
  tokens: {
    background: string; surface: string; elevated: string; border: string;
    text: string; muted: string; accent: string; accentText: string;
    gold: string; danger: string; success: string; artwork: string;
  };
}
