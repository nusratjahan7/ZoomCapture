import { useEffect, useState, type ReactNode } from 'react';
import { EyeOff, FolderOpen, KeyRound, Mic, PictureInPicture2, RotateCcw, Video, Volume2 } from 'lucide-react';
import { sendMessage } from '@/services/messaging';
import { resetSettings } from '@/services/settings';
import { subscribeLibrary } from '@/services/storage/libraryEvents';
import { listDrafts } from '@/services/storage/recordingDraftRepository';
import { countRecordings } from '@/services/storage/recordingRepository';
import { getStorageStatus, requestPersistentStorage, type StorageStatus } from '@/services/storage/storageStatus';
import { CAPTURE_SOURCE_OPTIONS } from '@/shared/captureSources';
import { Button, ConfirmDialog, Logo, Panel, SegmentedControl, Select, Toggle, useToast } from '@/shared/components';
import { useSettings } from '@/shared/hooks/useSettings';
import type { CaptureFrameRate, CaptureResolution, CountdownSeconds } from '@/types';
import { describeMediaError, getErrorMessage } from '@/utils/errors';
import { formatBytes } from '@/utils/format';
import { useMediaDevices } from '@/shared/hooks/useMediaDevices';
import { AutoZoomSettingsPanel } from './AutoZoomSettingsPanel';
import { NativeControlsSetting } from './NativeControlsSetting';

const RESOLUTION_OPTIONS: Array<{ value: CaptureResolution; label: string }> = [
  { value: '1080p', label: 'Up to 1080p (1920×1080)' },
  { value: '1440p', label: 'Up to 1440p (2560×1440)' },
  { value: '2160p', label: 'Up to 4K (3840×2160)' },
  { value: 'native', label: 'Native resolution' },
];

const COUNTDOWN_OPTIONS = [
  { value: 0, label: 'Off' },
  { value: 3, label: '3 seconds' },
  { value: 5, label: '5 seconds' },
] as const;

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

type StorageSummary = StorageStatus & { recordings: number; unfinished: number };

function useStorageSummary() {
  const [summary, setSummary] = useState<StorageSummary | null>(null);
  useEffect(() => {
    const load = async () => {
      await requestPersistentStorage();
      const [recordings, drafts, status] = await Promise.all([countRecordings(), listDrafts(), getStorageStatus()]);
      setSummary({ ...status, recordings, unfinished: drafts.length });
    };
    void load().catch(() => setSummary({ persisted: null, recordings: 0, unfinished: 0 }));
    return subscribeLibrary(() => void load().catch(() => undefined));
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

            <AutoZoomSettingsPanel
              value={settings.autoZoom}
              onChange={(patch) => save({ autoZoom: { ...settings.autoZoom, ...patch } })}
            />

            <Panel title="Recording" description="How recording starts and how you control it.">
              <div className="space-y-5">
                <Field label="Countdown" description="Time to get ready after pressing Start recording.">
                  <SegmentedControl
                    label="Countdown"
                    options={COUNTDOWN_OPTIONS}
                    value={settings.countdownSeconds}
                    onChange={(countdownSeconds: CountdownSeconds) => save({ countdownSeconds })}
                  />
                </Field>
                <Toggle
                  icon={PictureInPicture2}
                  label="Floating camera bubble and controls"
                  description="A small always-on-top window you can move anywhere, with the countdown and recording controls."
                  checked={settings.floatingControls}
                  onCheckedChange={(floatingControls) => save({ floatingControls })}
                />
                <Toggle
                  icon={EyeOff}
                  label="Hide it while recording the entire screen"
                  description="A tab or window recording never includes the floating window, so it stays on screen. An entire-screen recording captures everything visible, so the window closes when recording starts. Pause or stop from the ZoomCapture toolbar icon or the studio tab."
                  checked={settings.hideFloatingWhileRecording}
                  disabled={!settings.floatingControls}
                  onCheckedChange={(hideFloatingWhileRecording) => save({ hideFloatingWhileRecording })}
                />
                <NativeControlsSetting enabled={settings.nativeControls} onChange={(nativeControls) => void save({ nativeControls })} />
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
              description="Recordings are stored only on this device, in this browser profile. Nothing is uploaded."
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
              <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-fg-subtle">Recordings</dt>
                  <dd className="mt-1 text-lg font-semibold">{storage ? storage.recordings : '–'}</dd>
                </div>
                <div>
                  <dt className="text-fg-subtle">Unfinished</dt>
                  <dd className="mt-1 text-lg font-semibold">{storage ? storage.unfinished : '–'}</dd>
                </div>
                <div>
                  <dt className="text-fg-subtle">Space used</dt>
                  <dd className="mt-1 text-lg font-semibold">
                    {storage?.usage !== undefined ? formatBytes(storage.usage) : '–'}
                  </dd>
                </div>
                <div>
                  <dt className="text-fg-subtle">Available</dt>
                  <dd className="mt-1 text-lg font-semibold">
                    {storage?.usage !== undefined && storage.quota !== undefined
                      ? formatBytes(Math.max(0, storage.quota - storage.usage))
                      : '–'}
                  </dd>
                </div>
              </dl>
              <p className="mt-4 text-xs text-fg-subtle">
                {storage?.persisted
                  ? 'Persistent storage is on: the browser will not clear recordings to free space.'
                  : 'The browser may clear site data under severe storage pressure; download recordings you want to keep.'}{' '}
                ZoomCapture itself never deletes recordings unless you ask it to.
              </p>
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
