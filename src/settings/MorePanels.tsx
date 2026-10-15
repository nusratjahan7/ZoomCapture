import { useEffect, useState } from 'react';
import { ClipboardCopy, Eraser, ShieldCheck, Trash2 } from 'lucide-react';
import { clearDiagnostics, diagnosticReport, readDiagnostics, type DiagnosticEntry } from '@/services/diagnostics';
import { DB_VERSION } from '@/services/storage/db';
import { findOrphanedMedia, listLibrary, removeOrphanedMedia, type OrphanReport } from '@/services/storage/libraryRepository';
import { Button, ConfirmDialog, Panel, SegmentedControl, Select, Toggle, useToast } from '@/shared/components';
import { usePermissionState, type DevicePermission } from '@/shared/hooks/usePermissionState';
import { CAMERA_BUBBLE_SCALE, type AspectRatio, type CameraLayout, type ExportResolution, type UserSettings } from '@/types';
import { formatBytes } from '@/utils/format';
import { getErrorMessage } from '@/utils/errors';

const RESOLUTIONS: Array<{ value: ExportResolution; label: string }> = [
  { value: 'source', label: 'Full size (as recorded)' },
  { value: '2160p', label: '2160p (4K)' },
  { value: '1440p', label: '1440p' },
  { value: '1080p', label: '1080p' },
  { value: '720p', label: '720p' },
  { value: '480p', label: '480p' },
];

const ASPECTS: Array<{ value: AspectRatio; label: string }> = [
  { value: 'source', label: 'Recording’s own shape' },
  { value: '16:9', label: '16:9 (landscape)' },
  { value: '9:16', label: '9:16 (vertical)' },
  { value: '1:1', label: '1:1 (square)' },
  { value: '4:3', label: '4:3' },
];

/** Export size, shape and format given to new projects. */
export function ProjectDefaultsPanel({ value, onChange }: { value: UserSettings['projectDefaults']; onChange: (patch: Partial<UserSettings['projectDefaults']>) => void }) {
  return (
    <Panel title="New projects" description="Export settings each new recording’s project starts with. Every project can still be changed in the editor.">
      <div className="space-y-5">
        <div>
          <p className="text-sm font-medium">Export format</p>
          <div className="mt-2">
            <SegmentedControl
              label="Export format"
              options={[
                { value: 'mp4', label: 'MP4 (plays everywhere)' },
                { value: 'webm', label: 'WebM' },
              ]}
              value={value.exportFormat}
              onChange={(exportFormat) => onChange({ exportFormat })}
            />
          </div>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <Select label="Export resolution" description="Never larger than the recording." options={RESOLUTIONS} value={value.exportResolution} onValueChange={(exportResolution) => onChange({ exportResolution: exportResolution as ExportResolution })} />
          <Select label="Aspect ratio" description="The shape of the edited video." options={ASPECTS} value={value.aspectRatio} onValueChange={(aspectRatio) => onChange({ aspectRatio: aspectRatio as AspectRatio })} />
        </div>
      </div>
    </Panel>
  );
}

const CORNERS: Array<{ value: string; label: string; x: number; y: number }> = [
  { value: 'bottom-right', label: 'Bottom right', x: 0.86, y: 0.78 },
  { value: 'bottom-left', label: 'Bottom left', x: 0.14, y: 0.78 },
  { value: 'top-right', label: 'Top right', x: 0.86, y: 0.22 },
  { value: 'top-left', label: 'Top left', x: 0.14, y: 0.22 },
];

/** The camera bubble new recordings start with (moved and styled per project in the editor). */
export function CameraBubblePanel({ value, onChange }: { value: CameraLayout; onChange: (layout: CameraLayout) => void }) {
  const corner = CORNERS.find((option) => Math.abs(option.x - value.x) < 0.2 && Math.abs(option.y - value.y) < 0.2)?.value ?? 'custom';
  const set = (patch: Partial<CameraLayout>) => onChange({ ...value, ...patch });
  const size = value.scale === undefined ? value.size : (Object.entries(CAMERA_BUBBLE_SCALE).find(([, scale]) => Math.abs(scale - value.scale!) < 0.005)?.[0] as CameraLayout['size'] | undefined) ?? 'custom';
  const shape = value.shape ?? 'circle';
  const width = 22 * ((value.scale ?? CAMERA_BUBBLE_SCALE[value.size]) / CAMERA_BUBBLE_SCALE.medium);
  return (
    <Panel title="Camera bubble" description="Where the camera appears in new recordings, and how it looks. Drag it in the studio, or restyle it per project in the editor.">
      <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_11rem]">
        <div className="space-y-4">
          <Select
            label="Position"
            options={[...CORNERS.map(({ value: v, label }) => ({ value: v, label })), ...(corner === 'custom' ? [{ value: 'custom', label: 'Where you last placed it' }] : [])]}
            value={corner}
            onValueChange={(next) => {
              const target = CORNERS.find((option) => option.value === next);
              if (target) set({ x: target.x, y: target.y });
            }}
          />
          <div>
            <p className="text-sm font-medium">Size</p>
            <div className="mt-2">
              <SegmentedControl
                label="Size"
                options={[
                  { value: 'small', label: 'Small' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'large', label: 'Large' },
                  ...(size === 'custom' ? [{ value: 'custom' as const, label: 'Custom' }] : []),
                ]}
                value={size}
                onChange={(next) => next !== 'custom' && set({ size: next, scale: undefined })}
              />
            </div>
          </div>
          <div>
            <p className="text-sm font-medium">Shape</p>
            <div className="mt-2">
              <SegmentedControl
                label="Shape"
                options={[
                  { value: 'circle', label: 'Circle' },
                  { value: 'rounded', label: 'Rounded rectangle' },
                ]}
                value={shape}
                onChange={(next) => set({ shape: next })}
              />
            </div>
          </div>
          <Toggle label="Border" description="A thin white outline" checked={(value.borderWidth ?? 0.012) > 0} onCheckedChange={(on) => set({ borderWidth: on ? 0.012 : 0 })} />
          <Toggle label="Shadow" checked={(value.shadow ?? 0) > 0} onCheckedChange={(on) => set({ shadow: on ? 0.6 : 0 })} />
        </div>
        {/* A small preview of the frame with the bubble. */}
        <div aria-hidden className="relative aspect-video self-start overflow-hidden rounded-lg border border-line bg-surface-3">
          <div
            className="absolute -translate-x-1/2 -translate-y-1/2 bg-gradient-to-br from-accent/70 to-accent-2/70"
            style={{
              left: `${value.x * 100}%`,
              top: `${value.y * 100}%`,
              width: `${width}%`,
              aspectRatio: shape === 'rounded' ? String(value.aspect ?? 4 / 3) : '1',
              borderRadius: shape === 'circle' ? '9999px' : '18%',
              border: (value.borderWidth ?? 0.012) > 0 ? '1.5px solid rgba(255,255,255,0.85)' : undefined,
              boxShadow: (value.shadow ?? 0) > 0 ? '0 4px 10px rgba(0,0,0,0.5)' : undefined,
            }}
          />
        </div>
      </div>
    </Panel>
  );
}

const PERMISSION_TEXT: Record<DevicePermission, string> = {
  granted: 'Allowed',
  prompt: 'Chrome will ask',
  denied: 'Blocked',
  unknown: 'Unknown',
};

/** Live camera / microphone permission (read from Chrome, never stored). */
export function PermissionStatus() {
  const camera = usePermissionState('camera');
  const microphone = usePermissionState('microphone');
  const blocked = camera === 'denied' || microphone === 'denied';
  return (
    <div className="rounded-lg bg-surface-2 p-3 text-xs" data-testid="permission-status">
      <p className="flex flex-wrap gap-x-4 gap-y-1">
        <span>
          Camera: <strong className={camera === 'denied' ? 'text-danger' : 'text-fg'}>{PERMISSION_TEXT[camera]}</strong>
        </span>
        <span>
          Microphone: <strong className={microphone === 'denied' ? 'text-danger' : 'text-fg'}>{PERMISSION_TEXT[microphone]}</strong>
        </span>
      </p>
      <p className="mt-1.5 text-fg-subtle">
        {blocked
          ? 'Blocked devices can only be allowed again in Chrome: click the lock or tune icon in the address bar of a ZoomCapture page, or open chrome://settings/content. ZoomCapture can’t change this itself.'
          : 'Chrome decides and remembers these permissions; ZoomCapture only reads them, and checks again whenever you come back to this page.'}
      </p>
    </div>
  );
}

/** Media left behind by an interrupted operation: shown, and removed only when asked. */
export function OrphanedMedia() {
  const toast = useToast();
  const [report, setReport] = useState<OrphanReport | null>(null);
  const [confirm, setConfirm] = useState(false);
  const load = () => void findOrphanedMedia().then(setReport, () => setReport(null));
  useEffect(load, []);
  if (!report || report.count === 0) return null;
  return (
    <div className="mt-4 rounded-lg bg-warning/10 p-3 text-xs text-warning" data-testid="orphaned-media">
      <p>
        {report.count} stored {report.count === 1 ? 'file is' : 'files are'} not part of any recording or project ({formatBytes(report.bytes)}), probably left by an interrupted operation.
      </p>
      <Button size="sm" className="mt-2" icon={Trash2} onClick={() => setConfirm(true)}>
        Remove unused files
      </Button>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          try {
            const removed = await removeOrphanedMedia(report.ids);
            toast.show({ variant: 'success', title: `Removed ${removed} unused ${removed === 1 ? 'file' : 'files'}` });
          } catch (error) {
            toast.show({ variant: 'error', title: 'Could not remove them', description: getErrorMessage(error) });
          }
          load();
        }}
        title="Remove unused files?"
        description={`${formatBytes(report.bytes)} of media that no recording or project uses will be deleted. Recordings and projects are not touched.`}
        confirmLabel="Remove"
        tone="danger"
      />
    </div>
  );
}

/** What is stored, where, and what (rarely) goes over the network. */
export function PrivacyPanel() {
  return (
    <Panel title="Privacy & data" description="What ZoomCapture keeps, and where.">
      <ul className="space-y-2 text-sm text-fg-muted" data-testid="privacy">
        <li className="flex gap-2">
          <ShieldCheck size={15} aria-hidden className="mt-0.5 shrink-0 text-success" />
          <span>
            <strong className="text-fg">Recordings, projects and imported files stay on this device</strong>, in this Chrome profile’s extension storage (IndexedDB). They are never uploaded,
            synced or shared. Deleting a recording removes its media for good.
          </span>
        </li>
        <li className="flex gap-2">
          <ShieldCheck size={15} aria-hidden className="mt-0.5 shrink-0 text-success" />
          <span>
            <strong className="text-fg">No accounts, analytics, ads or tracking.</strong> ZoomCapture makes no network requests of its own, with one exception you start yourself (below).
          </span>
        </li>
        <li className="flex gap-2">
          <ShieldCheck size={15} aria-hidden className="mt-0.5 shrink-0 text-success" />
          <span>
            <strong className="text-fg">Automatic subtitles</strong> run on this device. The first time you generate them, the speech model (about 40–80 MB) is downloaded from Hugging Face
            (huggingface.co) and cached by the browser. Your audio is never sent anywhere.
          </span>
        </li>
        <li className="flex gap-2">
          <ShieldCheck size={15} aria-hidden className="mt-0.5 shrink-0 text-success" />
          <span>
            <strong className="text-fg">Recording only starts when you start it</strong>, after Chrome’s own sharing picker (or a tab you chose from the toolbar). Chrome shows its “sharing”
            indicator the whole time. Click tracking runs only in the tab you record, only while recording, and stores positions, never page content or keystrokes.
          </span>
        </li>
        <li className="flex gap-2">
          <ShieldCheck size={15} aria-hidden className="mt-0.5 shrink-0 text-success" />
          <span>
            <strong className="text-fg">Settings</strong> are kept in Chrome’s extension storage on this device (not synced). Camera and microphone permissions belong to Chrome, which
            remembers them; ZoomCapture only reads them.
          </span>
        </li>
      </ul>
    </Panel>
  );
}

/** Recent errors (sanitized) and a report to copy for bug reports. */
export function DiagnosticsPanel() {
  const toast = useToast();
  const [entries, setEntries] = useState<DiagnosticEntry[]>([]);
  const load = () => void readDiagnostics().then(setEntries, () => setEntries([]));
  useEffect(load, []);
  const copy = async () => {
    try {
      const library = await listLibrary().catch(() => []);
      const report = await diagnosticReport({
        schemaVersion: DB_VERSION,
        recordings: library.length,
        projectsMissing: library.filter((entry) => !entry.project).length,
        largestProjectMb: Math.round(Math.max(0, ...library.map((entry) => entry.totalBytes)) / 1024 ** 2),
      });
      await navigator.clipboard.writeText(report);
      toast.show({ variant: 'success', title: 'Diagnostic report copied', description: 'Paste it into your bug report. It contains no recording names or content.' });
    } catch (error) {
      toast.show({ variant: 'error', title: 'Could not copy the report', description: getErrorMessage(error) });
    }
  };
  return (
    <Panel
      title="Diagnostics"
      description="Recent errors, kept on this device to help with bug reports. Names, file paths and addresses are removed; media and text never are logged."
      actions={
        <div className="flex gap-2">
          <Button size="sm" icon={ClipboardCopy} onClick={() => void copy()}>
            Copy report
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={Eraser}
            disabled={entries.length === 0}
            onClick={() => void clearDiagnostics().then(load)}
          >
            Clear
          </Button>
        </div>
      }
    >
      {entries.length === 0 ? (
        <p className="text-sm text-fg-subtle" data-testid="diagnostics-empty">
          No errors recorded.
        </p>
      ) : (
        <ul className="max-h-48 space-y-1 overflow-y-auto font-mono text-[11px] text-fg-muted" data-testid="diagnostics">
          {[...entries].reverse().map((entry, index) => (
            <li key={`${entry.time}-${index}`} className="truncate" title={`${entry.name ?? ''} ${entry.message}`}>
              {new Date(entry.time).toLocaleString()} · {entry.context} · {entry.name ? `${entry.name}: ` : ''}
              {entry.message}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
