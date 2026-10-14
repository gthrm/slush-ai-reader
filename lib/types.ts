import { z } from 'zod';

export const voices = ['marin', 'cedar', 'coral'] as const;
export const settingsSchema = z.object({
  apiKey: z.string().default(''), voice: z.enum(voices).default('marin'),
  speed: z.number().min(0.5).max(2).default(1),
  style: z.enum(['natural', 'calm', 'expressive']).default('natural'),
  instructions: z.string().max(600).default(''),
  highlightWords: z.boolean().default(true),
});
export type Settings = z.infer<typeof settingsSchema>;
export const defaults = settingsSchema.parse({});
export function readStoredSettings(value: unknown): Settings {
  const stored = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  // Validate field by field: one outdated value must not erase the API key or other preferences.
  const result: Record<string, unknown> = { ...defaults };
  for (const [key, field] of Object.entries(settingsSchema.shape)) {
    const parsed = field.safeParse(stored[key]);
    if (parsed.success) result[key] = parsed.data;
  }
  return result as Settings;
}
export interface Block { id: number; kind: 'heading' | 'paragraph' | 'list' | 'quote' | 'table' | 'code' | 'caption'; text: string }
export interface PageContent { url: string; title: string; author: string; site: string; language: string; blocks: Block[]; extraction: 'readability' | 'main' | 'selection' }
export const planSchema = z.object({
  title: z.string(), pageType: z.enum(['article', 'documentation', 'discussion', 'recipe', 'other']),
  language: z.string(),
  excludedBlockIds: z.array(z.number().int()),
  spokenBlocks: z.array(z.object({ id: z.number().int(), text: z.string() })),
});
export type ReadingPlan = z.infer<typeof planSchema>;
export interface Chunk { text: string; section: string; blockId: number; duration: number; exact: boolean }
export interface TranscriptWord { text: string; from: number; to: number; start: number; end: number }
export interface SpeechWord { word: string; start: number; end: number }
export interface PreparedReading { plan: ReadingPlan; savedAt: number }
export type Status = 'idle' | 'ready' | 'preparing' | 'analyzing' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';
export interface PlayerState {
  status: Status; title: string; site: string; pageType: string; language: string;
  section: string; transcript: string; index: number; count: number;
  position: number; duration: number; estimated: boolean; speed: number;
  error: string; tabId: number | null; cached: number;
  voice: string; highlightWords: boolean; words: TranscriptWord[]; activeWord: number;
  wordSync: 'off' | 'pending' | 'timed' | 'estimated'; textCached: boolean;
}
export const emptyState: PlayerState = { status: 'idle', title: '', site: '', pageType: '', language: '', section: '', transcript: '', index: 0, count: 0, position: 0, duration: 0, estimated: true, speed: 1, error: '', tabId: null, cached: 0, voice: 'marin', highlightWords: true, words: [], activeWord: -1, wordSync: 'off', textCached: false };
export type Control = { action: 'toggle' } | { action: 'stop' } | { action: 'retry' } | { action: 'seek'; position: number } | { action: 'skip'; seconds: number } | { action: 'speed'; speed: number };
export interface Reply { ok: boolean; error?: string; state?: PlayerState; settings?: Settings; focusApiKey?: boolean; tabId?: number; prepared?: PreparedReading }
export function formatTime(seconds: number) { const n = Math.max(0, Math.floor(seconds || 0)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; }
export function friendlyError(error: unknown): string {
  const status = (error as { status?: number })?.status;
  if (status === 401) return 'Your API key was rejected. Check it in the extension settings.';
  if (status === 429) return 'OpenAI limit reached. Check your API balance or try again shortly.';
  if (status === 403) return 'Model access denied. Check your API key permissions.';
  if (error instanceof Error && /fetch|network/i.test(error.message)) return 'Unable to reach OpenAI. Check your connection and try again.';
  return error instanceof Error ? error.message : 'Unable to start reading. Please try again.';
}
