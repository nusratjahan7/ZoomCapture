import { MousePointer2, MousePointerClick } from 'lucide-react';
import { Panel, Toggle } from '@/shared/components';
import type { RenderEffects } from '@/types';

/** Cursor and click overlays, drawn in the preview and in the rendered video alike. */
export function RenderEffectsPanel({
  effects,
  clicks,
  cursorSamples,
  busy,
  onChange,
}: {
  effects: RenderEffects;
  clicks: number;
  cursorSamples: number;
  busy: boolean;
  onChange: (patch: Partial<RenderEffects>) => void;
}) {
  return (
    <Panel title="Cursor & clicks" description="Overlays drawn on the video, in the preview and in the rendered file.">
      <div className="divide-y divide-line">
        <Toggle
          icon={MousePointerClick}
          label="Click emphasis"
          description={clicks > 0 ? 'A ring expands where each tracked click happened' : 'No clicks were tracked for this recording'}
          checked={effects.clickEmphasis && clicks > 0}
          disabled={busy || clicks === 0}
          onCheckedChange={(clickEmphasis) => onChange({ clickEmphasis })}
        />
        <Toggle
          icon={MousePointer2}
          label="Cursor highlight"
          description={
            cursorSamples > 0
              ? 'A soft halo follows the pointer'
              : 'Pointer movement was not tracked for this recording (it is tracked for tabs recorded from this version on)'
          }
          checked={effects.cursorHighlight && cursorSamples > 0}
          disabled={busy || cursorSamples === 0}
          onCheckedChange={(cursorHighlight) => onChange({ cursorHighlight })}
        />
      </div>
    </Panel>
  );
}
