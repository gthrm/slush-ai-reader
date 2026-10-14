import { createElement, AudioLines, Play, Pause, RotateCcw, RotateCw, X, Minus, ChevronDown, ChevronUp, KeyRound, ArrowUpRight, Headphones, SlidersHorizontal, Check, Eye, EyeOff, Volume2, LoaderCircle, RefreshCw, Sparkles } from 'lucide';

const icons = { audio: AudioLines, play: Play, pause: Pause, back: RotateCcw, forward: RotateCw, close: X, minimize: Minus, down: ChevronDown, up: ChevronUp, key: KeyRound, arrow: ArrowUpRight, headphones: Headphones, settings: SlidersHorizontal, check: Check, eye: Eye, hidden: EyeOff, volume: Volume2, loading: LoaderCircle, retry: RefreshCw, sparkles: Sparkles };
export function icon(name: keyof typeof icons, size = 20): string {
  const [tag, attributes, children] = icons[name];
  return createElement([tag, { ...attributes, width: size, height: size, class: 'slush-icon', style: `width:${size}px;height:${size}px;flex-shrink:0;display:block;`, 'stroke-width': 1.8, 'aria-hidden': 'true', focusable: 'false' }, children]).outerHTML;
}
