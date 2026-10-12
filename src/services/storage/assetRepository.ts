import type { MediaAsset } from '@/types';
import { getDb } from './db';

/** Stores asset metadata and its blob in a single transaction. */
export async function saveAsset(asset: MediaAsset, blob: Blob): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['assets', 'assetBlobs'], 'readwrite');
  await Promise.all([
    tx.objectStore('assets').put({ ...asset, size: blob.size, mimeType: blob.type || asset.mimeType }),
    tx.objectStore('assetBlobs').put(blob, asset.id),
    tx.done,
  ]);
}

export async function listAssets(projectId: string): Promise<MediaAsset[]> {
  return (await getDb()).getAllFromIndex('assets', 'by-project', projectId);
}

export async function getAssetBlob(assetId: string): Promise<Blob | undefined> {
  return (await getDb()).get('assetBlobs', assetId);
}
