import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Copy, Info, Loader2, MonitorX, RefreshCw, TriangleAlert } from 'lucide-react';
import { checkNativeHelper, requestNativePermission, type NativeHelperStatus } from '@/services/nativeControls';
import { Button, Toggle, useToast } from '@/shared/components';

/**
 * Settings for the Windows controls helper: turn it on (asks for the native messaging permission),
 * see whether it is installed, and the install command with this extension's ID filled in.
 */
export function NativeControlsSetting({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  const toast = useToast();
  const [windows, setWindows] = useState<boolean | null>(null);
  const [status, setStatus] = useState<NativeHelperStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const command = `powershell -ExecutionPolicy Bypass -File native\\windows\\install.ps1 -ExtensionId ${chrome.runtime.id}`;

  useEffect(() => {
    void chrome.runtime
      .getPlatformInfo()
      .then((info) => setWindows(info.os === 'win'))
      .catch(() => setWindows(navigator.userAgent.includes('Windows')));
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await checkNativeHelper());
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (enabled && windows) void check();
  }, [enabled, windows, check]);

  if (!windows) return null;

  const toggle = async (on: boolean) => {
    if (!on) return onChange(false);
    // The permission prompt needs this click.
    if (!(await requestNativePermission())) {
      toast.show({ variant: 'error', title: 'Not turned on', description: 'ZoomCapture needs permission to talk to the controls helper.' });
      return;
    }
    onChange(true);
    void check();
  };

  return (
    <div className="space-y-3">
      <Toggle
        icon={MonitorX}
        label="On screen, but not in the video (Windows helper)"
        description="When recording the entire screen, shows the controls in a small window that Windows leaves out of the recording. Needs the ZoomCapture controls helper, installed once."
        checked={enabled}
        onCheckedChange={(on) => void toggle(on)}
      />
      {enabled && (
        <div className="space-y-3 rounded-xl bg-surface-2 p-3 text-xs text-fg-muted" role="status" aria-live="polite">
          {checking || !status ? (
            <p className="flex items-center gap-2">
              <Loader2 size={14} aria-hidden className="animate-spin" /> Checking for the controls helper…
            </p>
          ) : status.state === 'ready' ? (
            status.excluded ? (
              <p className="flex items-start gap-2 text-success">
                <CheckCircle2 size={14} aria-hidden className="mt-0.5 shrink-0" />
                <span>Controls helper {status.version} is ready. During entire-screen recordings the controls stay on screen and are left out of the video.</span>
              </p>
            ) : (
              <p className="flex items-start gap-2 text-warning">
                <TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />
                <span>The helper works, but this version of Windows can’t leave windows out of screen captures (it needs Windows 10 version 2004 or later), so the controls would appear in the video.</span>
              </p>
            )
          ) : (
            <>
              <p className="flex items-start gap-2 text-warning">
                <TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />
                <span>{status.state === 'no-permission' ? 'ZoomCapture isn’t allowed to talk to the helper yet. Turn this off and on again to allow it.' : status.reason}</span>
              </p>
              {status.state === 'unavailable' && (
                <div className="space-y-2">
                  <p className="flex items-start gap-2">
                    <Info size={14} aria-hidden className="mt-0.5 shrink-0" />
                    <span>
                      To install it, open PowerShell in the ZoomCapture folder and run this command (it builds the helper with tools that come with Windows and
                      registers it for your user only, for this extension’s ID). Then click <strong>Check again</strong>.
                    </span>
                  </p>
                  <div className="flex items-start gap-2">
                    <code className="min-w-0 flex-1 rounded-lg border border-line bg-canvas p-2 font-mono text-[11px] break-all text-fg" data-testid="native-install-command">
                      {command}
                    </code>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={Copy}
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(command)
                          .then(() => toast.show({ title: 'Command copied' }))
                          .catch(() => toast.show({ variant: 'error', title: 'Could not copy', description: 'Select the command and copy it.' }))
                      }
                    >
                      Copy
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
          {!checking && status?.state !== 'ready' && (
            <Button size="sm" icon={RefreshCw} onClick={() => void check()}>
              Check again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
