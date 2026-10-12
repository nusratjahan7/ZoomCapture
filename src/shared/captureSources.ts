import { AppWindow, Monitor, PanelTop } from 'lucide-react';
import type { CaptureSource } from '@/types';
import type { SegmentOption } from './components/SegmentedControl';

export const CAPTURE_SOURCE_OPTIONS: readonly SegmentOption<CaptureSource>[] = [
  { value: 'screen', label: 'Screen', icon: Monitor },
  { value: 'window', label: 'Window', icon: AppWindow },
  { value: 'tab', label: 'Browser Tab', shortLabel: 'Tab', icon: PanelTop },
];

export const CAPTURE_SOURCE_NOUN: Record<CaptureSource, string> = {
  screen: 'screen',
  window: 'window',
  tab: 'browser tab',
};
