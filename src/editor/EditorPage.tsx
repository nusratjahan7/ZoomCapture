import { useEffect, useState } from 'react';
import { getQueryParam } from '@/services/navigation';
import { findRecordingIdByProject } from '@/services/storage/recordingRepository';
import { RecordingLibrary } from './components/RecordingLibrary';
import { RecordingWorkspace } from './components/RecordingWorkspace';

/**
 * `editor/index.html` shows the recording library; `?recording=<id>` opens that recording.
 * Links from earlier versions (`?project=<id>`) are resolved to their recording.
 */
export function EditorPage() {
  const [recordingId, setRecordingId] = useState<string | null | undefined>(() => getQueryParam('recording') ?? undefined);

  useEffect(() => {
    if (recordingId !== undefined) return;
    const projectId = getQueryParam('project');
    if (!projectId) return setRecordingId(null);
    void findRecordingIdByProject(projectId).then((id) => setRecordingId(id ?? projectId));
  }, [recordingId]);

  if (recordingId === undefined) return null;
  return recordingId ? <RecordingWorkspace recordingId={recordingId} /> : <RecordingLibrary />;
}
