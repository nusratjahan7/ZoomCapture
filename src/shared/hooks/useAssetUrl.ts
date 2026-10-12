import { useEffect, useState } from 'react';
import { getAssetBlob } from '@/services/storage/assetRepository';

/**
 * Temporary `blob:` URL for a stored asset. The URL is revoked as soon as the asset changes, the
 * caller passes `undefined` (e.g. a preview dialog closes) or the component unmounts, so media
 * memory is released promptly.
 */
export function useAssetUrl(assetId: string | undefined): { url: string | null; error: boolean } {
  const [state, setState] = useState<{ url: string | null; error: boolean }>({ url: null, error: false });

  useEffect(() => {
    if (!assetId) return;
    let active = true;
    let objectUrl: string | null = null;
    getAssetBlob(assetId).then(
      (blob) => {
        if (!active) return;
        if (!blob) return setState({ url: null, error: true });
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, error: false });
      },
      () => active && setState({ url: null, error: true }),
    );
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setState({ url: null, error: false });
    };
  }, [assetId]);

  return state;
}
