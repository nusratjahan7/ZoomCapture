import { useState } from 'react';
import { Mic, Settings, Video } from 'lucide-react';
import { sendMessage } from '@/services/messaging';
import { CAPTURE_SOURCE_OPTIONS } from '@/shared/captureSources';
import { Button, IconButton, Logo, SegmentedControl, Toggle, useToast } from '@/shared/components';
import { useActiveSession } from '@/shared/hooks/useActiveSession';
import { useSettings } from '@/shared/hooks/useSettings';
import { getErrorMessage } from '@/utils/errors';
import { ActiveSessionCard } from './components/ActiveSessionCard';
import { RecentRecordings } from './components/RecentRecordings';

/**
 * Lightweight launcher. All capture work happens in the Recording Studio page, because the
 * popup closes as soon as Chrome's screen picker (or anything else) takes focus.
 */
export function Popup() {
  const { settings, update } = useSettings();
  const { session, loaded: sessionLoaded } = useActiveSession();
  const toast = useToast();
  const [starting, setStarting] = useState(false);

  const openSettings = async () => {
    await chrome.runtime.openOptionsPage();
    window.close();
  };

  const startRecording = async () => {
    if (!settings) return;
    setStarting(true);
    try {
      await sendMessage('session/start', {
        options: {
          source: settings.defaultSource,
          camera: settings.cameraEnabled,
          microphone: settings.microphoneEnabled,
        },
      });
      window.close();
    } catch (error) {
      toast.show({ variant: 'error', title: 'Could not start recording', description: getErrorMessage(error) });
      setStarting(false);
    }
  };

  return (
    <div className="w-[360px] bg-canvas">
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <Logo subtitle="Screen recorder with auto-zoom" />
        <IconButton
          icon={Settings}
          label="Settings"
          tooltipSide="bottom"
          tooltipAlign="end"
          onClick={() => void openSettings()}
        />
      </header>

      <main className="space-y-5 p-4">
        {sessionLoaded && session ? (
          <ActiveSessionCard session={session} />
        ) : (
          <section aria-labelledby="capture-heading" className="space-y-3">
            <h2 id="capture-heading" className="text-xs font-semibold tracking-wider text-fg-subtle uppercase">
              Capture source
            </h2>
            <SegmentedControl
              label="Capture source"
              appearance="tiles"
              options={CAPTURE_SOURCE_OPTIONS}
              value={settings?.defaultSource ?? 'screen'}
              onChange={(defaultSource) => void update({ defaultSource })}
              disabled={!settings}
            />
            <div className="grid grid-cols-2 gap-2">
              <Toggle
                appearance="card"
                icon={Video}
                label="Camera"
                description={settings?.cameraEnabled ? 'On' : 'Off'}
                checked={settings?.cameraEnabled ?? false}
                onCheckedChange={(cameraEnabled) => void update({ cameraEnabled })}
                disabled={!settings}
              />
              <Toggle
                appearance="card"
                icon={Mic}
                label="Microphone"
                description={settings?.microphoneEnabled ? 'On' : 'Off'}
                checked={settings?.microphoneEnabled ?? false}
                onCheckedChange={(microphoneEnabled) => void update({ microphoneEnabled })}
                disabled={!settings}
              />
            </div>
            <Button
              variant="record"
              size="lg"
              fullWidth
              loading={starting}
              disabled={!settings || !sessionLoaded}
              onClick={() => void startRecording()}
            >
              {!starting && <span aria-hidden className="size-2.5 rounded-full bg-white" />}
              Start Recording
            </Button>
            <p className="text-center text-[11px] text-fg-subtle">
              Opens the Recording Studio, where Chrome asks what to share.
            </p>
          </section>
        )}

        <RecentRecordings />
      </main>
    </div>
  );
}
