import { useEffect, useState } from 'react';
import { getAssetBlob } from '@/services/storage/assetRepository';
import type { MediaAsset, MediaAssetKind } from '@/types';

export type AssetUrls = ReadonlyMap<string, { url: string; kind: MediaAssetKind; width?: number; height?: number }>;

/**
 * Temporary `blob:` URLs for every playable asset of the project (not thumbnails). URLs are
 * created as assets appear and revoked as soon as an asset is removed or the editor closes, so
 * media memory is released promptly.
 */
export function useAssetUrls(assets: readonly MediaAsset[]): AssetUrls {
  const [urls, setUrls] = useState<AssetUrls>(new Map());
  const key = assets
    .filter((asset) => asset.kind !== 'thumbnail')
    .map((asset) => asset.id)
    .join(',');

  useEffect(() => {
    let active = true;
    const created: string[] = [];
    const playable = assets.filter((asset) => asset.kind !== 'thumbnail');
    void Promise.all(
      playable.map(async (asset) => {
        const blob = await getAssetBlob(asset.id).catch(() => undefined);
        if (!blob) return null;
        const url = URL.createObjectURL(blob);
        created.push(url);
        return [asset.id, { url, kind: asset.kind, width: asset.width, height: asset.height }] as const;
      }),
    ).then((entries) => {
      if (active) setUrls(new Map(entries.filter((entry) => entry !== null)));
    });
    return () => {
      active = false;
      created.forEach((url) => URL.revokeObjectURL(url));
    };
    // `key` captures which assets are present; the array identity changes on every reload.
  }, [key]);

  return urls;
}
