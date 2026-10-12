export interface MediaDeviceOption {
  deviceId: string;
  label: string;
}

export interface MediaDeviceInventory {
  cameras: MediaDeviceOption[];
  microphones: MediaDeviceOption[];
  /** Chrome hides device labels until the extension has been granted access. */
  labelsAvailable: boolean;
}

function deviceConstraint(deviceId: string): ConstrainDOMString | undefined {
  return deviceId ? { exact: deviceId } : undefined;
}

export function requestCameraStream(deviceId = ''): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: { deviceId: deviceConstraint(deviceId), width: { ideal: 1280 }, height: { ideal: 720 } },
  });
}

export function requestMicrophoneStream(deviceId = ''): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceConstraint(deviceId), echoCancellation: true, noiseSuppression: true },
  });
}

/** Prompts for camera and microphone access in one request, then releases the devices. */
export async function grantDeviceAccess(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  stopStream(stream);
}

export async function listMediaDevices(): Promise<MediaDeviceInventory> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const toOption = (device: MediaDeviceInfo, index: number, fallback: string): MediaDeviceOption => ({
    deviceId: device.deviceId,
    label: device.label || `${fallback} ${index + 1}`,
  });
  // The "default"/"communications" entries are aliases of real devices; "system default" covers them.
  const real = devices.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return {
    cameras: real.filter((d) => d.kind === 'videoinput').map((d, i) => toOption(d, i, 'Camera')),
    microphones: real.filter((d) => d.kind === 'audioinput').map((d, i) => toOption(d, i, 'Microphone')),
    labelsAvailable: devices.some((d) => d.label !== ''),
  };
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}
