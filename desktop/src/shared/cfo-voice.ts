export const CFO_VOICE_CHANNEL = 'shensi:cfo-voice:command';
export type GreetingVoice = 'male' | 'female';
export interface GreetingPreferences { muted: boolean; voice: GreetingVoice; random: boolean; }
export interface CfoVoiceStatus extends GreetingPreferences { speaking: boolean; }
export interface CfoVoiceBridge {
  status(): Promise<CfoVoiceStatus>;
  greet(workspaceId: string): Promise<CfoVoiceStatus>;
  preview(workspaceId: string, preferences?: GreetingPreferences): Promise<CfoVoiceStatus>;
  stop(): Promise<CfoVoiceStatus>;
  setMuted(muted: boolean): Promise<CfoVoiceStatus>;
  setPreferences(preferences: GreetingPreferences): Promise<CfoVoiceStatus>;
}
