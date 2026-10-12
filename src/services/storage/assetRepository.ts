import type { MediaAsset } from '@/types';
import { getDb } from './db';

/** Original and generated media of a recording (screen, camera, audio stems, thumbnail). */
export async function listRecordingAssets(recordingId: string): Promise<MediaAsset[]> {
  return (await getDb()).getAllFromIndex('assets', 'by-recording', recordingId);
}

export async function getAssetBlob(assetId: string): Promise<Blob | undefined> {
  return (await getDb()).get('assetBlobs', assetId);
}
