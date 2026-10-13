import { useEffect, useState } from 'react';
import { createFilmstrip, revoke, type Filmstrip } from '@/services/media/filmstrip';
import { getAssetBlob } from '@/services/storage/assetRepository';
import type { MediaAsset } from '@/types';

const VISUAL_KINDS = new Set<MediaAsset['kind']>(['screen', 'camera', 'video']);

/**
 * Preview frames for every video file of the project, decoded one file at a time in the
 * background. Frames appear on timeline clips as they become ready; object URLs are released
 * when a file leaves the project or the editor closes.
 */
export function useFilmstrips(assets: readonly MediaAsset[]): ReadonlyMap<string, Filmstrip> {
  const [strips, setStrips] = useState<ReadonlyMap<string, Filmstrip>>(new Map());
  const key = assets
    .filter((asset) => VISUAL_KINDS.has(asset.kind) && (asset.durationMs ?? 0) > 0)
    .map((asset) => asset.id)
    .join(',');

  useEffect(() => {
    const controller = new AbortController();
    const made: Filmstrip[] = [];
    const wanted = assets.filter((asset) => key.split(',').includes(asset.id));
    void (async () => {
      for (const asset of wanted) {
        if (controller.signal.aborted) return;
        const blob = await getAssetBlob(asset.id).catch(() => undefined);
        if (!blob) continue;
        const strip = await createFilmstrip(blob, asset.durationMs ?? 0, controller.signal);
        if (!strip) continue;
        if (controller.signal.aborted) {
          revoke(strip.frames);
          return;
        }
        made.push(strip);
        setStrips((current) => new Map(current).set(asset.id, strip));
      }
    })();
    return () => {
      controller.abort();
      for (const strip of made) revoke(strip.frames);
      setStrips(new Map());
    };
    // `key` captures which video files are present.
  }, [key]);

  return strips;
}
