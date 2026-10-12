import { useEffect, useState, type ReactNode } from 'react';
import { FolderOpen, KeyRound, Mic, RotateCcw, Video, Volume2 } from 'lucide-react';
import { sendMessage } from '@/services/messaging';
import { resetSettings } from '@/services/settings';
import { countProjects } from '@/services/storage/projectRepository';
import { CAPTURE_SOURCE_OPTIONS } from '@/shared/captureSources';
import { Button, ConfirmDialog, Logo, Panel, SegmentedControl, Select, Toggle, useToast } from '@/shared/components';
import { useSettings } from '@/shared/hooks/useSettings';
import type { CaptureFrameRate, CaptureResolution } from '@/types';
import { describeMediaError, getErrorMessage } from '@/utils/errors';
import { formatBytes } from '@/utils/format';
import { useMediaDevices } from './useMediaDevices';

const RESOLUTION_OPTIONS: Array<{ value: CaptureResolution; label: string }> = [
  { value: '1080p', label: 'Up to 1080p (1920×1080)' },
  { value: '1440p', label: 'Up to 1440p (2560×1440)' },
  { value: '2160p', label: 'Up to 4K (3840×2160)' },
  { value: 'native', label: 'Native resolution' },
];

const FRAME_RATE_OPTIONS = [
  { value: 30, label: '30 fps' },
  { value: 60, label: '60 fps' },
] as const;

function Field({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-sm font-medium">{label}</p>
      {description && <p className="mt-0.5 text-xs text-fg-subtle">{description}</p>}
      <div className="mt-2">{children}</div>
    </div>
  );
}

function deviceOptions(devices: Array<{ deviceId: string; label: string }>, selected: string) {
  const options = [{ value: '', label: 'System default' }, ...devices.map((d) => ({ value: d.deviceId, label: d.label }))];
  if (selected && !devices.some((d) => d.deviceId === selected)) {
    options.push({ value: selected, label: 'Previously selected device (not connected)' });
  }
  return options;
}

function useStorageSummary() {
  const [summary, setSummary] = useState<{ projects: number; usage?: number; quota?: number } | null>(null);
  useEffect(() => {
    void Promise.all([countProjects(), navigator.storage.estimate()]).then(([projects, estimate]) =>
      setSummary({ projects, usage: estimate.usage, quota: estimate.quota }),
    );
  }, []);
  return summary;
}

export function SettingsPage() {
  const { settings, update } = useSettings();
  const { inventory, requestAccess } = useMediaDevices();
  const storage = useStorageSummary();
  const toast = useToast();
  const [confirmReset, setConfirmReset] = useState(false);
  const [requesting, setRequesting] = useState(false);

  const save = (patch: Parameters<typeof update>[0]) =>
    void update(patch).catch((error: unknown) =>
      toast.show({ variant: 'error', title: 'Could not save settings', description: getErrorMessage(error) }),
    );

  const allowDevices = async () => {
    setRequesting(true);
    try {
      await requestAccess();
      toast.show({ variant: 'success', title: 'Device access granted' });
    } catch (error) {
      toast.show({ variant: 'error', title: 'Device access not granted', description: describeMediaError(error, 'camera or microphone') });
    } finally {
      setRequesting(false);
    }
  };

  const reset = async () => {
    await resetSettings();
    toast.show({ variant: 'success', title: 'Settings restored to defaults' });
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-line px-6 py-3">
        <div className="mx-auto flex max-w-3xl items-center">
          <Logo subtitle="Settings" />
          <span className="ml-auto text-xs text-fg-subtle">Version {chrome.runtime.getManifest().version}</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 p-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-fg-muted">Changes are saved automatically and apply to new sessions.</p>
        </div>

        {settings && (
          <>
            <Panel title="Capture" description="Defaults used when you start a recording.">
              <div className="space-y-5">
                <Field label="Default source" description="Pre-selected in the popup and in Chrome's sharing picker.">
                  <SegmentedControl
                    label="Default source"
                    options={CAPTURE_SOURCE_OPTIONS}
                    value={settings.defaultSource}
                    onChange={(defaultSource) => save({ defaultSource })}
                  />
                </Field>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Select
                    label="Maximum resolution"
                    description="Larger sources are scaled down to this size."
                    options={RESOLUTION_OPTIONS}
                    value={settings.resolution}
                    onValueChange={(value) => save({ resolution: value as CaptureResolution })}
                  />
                  <Field label="Frame rate" description="60 fps suits fast motion; 30 fps uses less space.">
                    <SegmentedControl
                      label="Frame rate"
                      options={FRAME_RATE_OPTIONS}
                      value={settings.frameRate}
                      onChange={(frameRate: CaptureFrameRate) => save({ frameRate })}
                    />
                  </Field>
                </div>
                <Toggle
                  icon={Volume2}
                  label="Capture tab and system audio"
                  description="Lets Chrome offer to share audio along with the selected source."
                  checked={settings.captureSystemAudio}
                  onCheckedChange={(captureSystemAudio) => save({ captureSystemAudio })}
                />
              </div>
            </Panel>

            <Panel
              title="Camera & microphone"
              description="Choose default devices and whether they start enabled."
              actions={
                inventory && !inventory.labelsAvailable ? (
                  <Button size="sm" icon={KeyRound} loading={requesting} onClick={() => void allowDevices()}>
                    Allow device access
                  </Button>
                ) : undefined
              }
            >
              <div className="space-y-4">
                <div className="divide-y divide-line">
                  <Toggle
                    icon={Video}
                    label="Camera on by default"
                    checked={settings.cameraEnabled}
                    onCheckedChange={(cameraEnabled) => save({ cameraEnabled })}
                  />
                  <Toggle
                    icon={Mic}
                    label="Microphone on by default"
                    checked={settings.microphoneEnabled}
                    onCheckedChange={(microphoneEnabled) => save({ microphoneEnabled })}
                  />
                </div>
                {inventory && !inventory.labelsAvailable && (
                  <p className="text-xs text-fg-subtle">
                    Chrome hides device names until ZoomCapture is allowed to use your camera and microphone.
                  </p>
                )}
                <div className="grid gap-5 sm:grid-cols-2">
                  <Select
                    label="Camera"
                    options={deviceOptions(inventory?.cameras ?? [], settings.cameraDeviceId)}
                    value={settings.cameraDeviceId}
                    onValueChange={(cameraDeviceId) => save({ cameraDeviceId })}
                    disabled={!inventory}
                  />
                  <Select
                    label="Microphone"
                    options={deviceOptions(inventory?.microphones ?? [], settings.microphoneDeviceId)}
                    value={settings.microphoneDeviceId}
                    onValueChange={(microphoneDeviceId) => save({ microphoneDeviceId })}
                    disabled={!inventory}
                  />
                </div>
              </div>
            </Panel>

            <Panel
              title="Storage"
              description="Projects and media are stored locally in this browser profile."
              actions={
                <Button
                  size="sm"
                  icon={FolderOpen}
                  onClick={() => void sendMessage('page/open', { page: 'editor' })}
                >
                  Open library
                </Button>
              }
            >
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-fg-subtle">Projects</dt>
                  <dd className="mt-1 text-lg font-semibold">{storage ? storage.projects : '–'}</dd>
                </div>
                <div>
                  <dt className="text-fg-subtle">Space used</dt>
                  <dd className="mt-1 text-lg font-semibold">
                    {storage?.usage !== undefined ? formatBytes(storage.usage) : '–'}
                    {storage?.quota !== undefined && (
                      <span className="ml-1 text-xs font-normal text-fg-subtle">of {formatBytes(storage.quota)}</span>
                    )}
                  </dd>
                </div>
              </dl>
            </Panel>

            <div className="flex justify-end">
              <Button variant="ghost" icon={RotateCcw} onClick={() => setConfirmReset(true)}>
                Restore defaults
              </Button>
            </div>
          </>
        )}
      </main>

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={reset}
        title="Restore default settings?"
        description="Capture and device preferences will be reset. Your projects are not affected."
        confirmLabel="Restore defaults"
      />
    </div>
  );
}
