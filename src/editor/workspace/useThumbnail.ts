import { useEffect, useState } from 'react';
import { thumbnailFor } from '@/services/media/thumbnails';
import type { MediaAsset } from '@/types';

/** A file's (or PDF page's) thumbnail URL once it is ready; null for audio or unreadable files. */
export function useThumbnail(asset: MediaAsset | undefined, page = 1, enabled = true): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!asset || !enabled) return;
    let active = true;
    void thumbnailFor(asset, page).then((value) => active && setUrl(value));
    return () => {
      active = false;
    };
  }, [asset, page, enabled]);
  return asset && enabled ? url : null;
}
