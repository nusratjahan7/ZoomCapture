import { useCallback, useEffect, useState } from 'react';
import { listProjects } from '@/services/storage/projectRepository';
import type { ProjectSummary } from '@/types';
import { getErrorMessage } from '@/utils/errors';

/** Project summaries from IndexedDB, refreshed when the page becomes visible again. */
export function useProjects(limit?: number) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setProjects(await listProjects(limit));
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  return { projects, loading, error, refresh };
}
