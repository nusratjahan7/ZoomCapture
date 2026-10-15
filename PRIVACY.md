# ZoomCapture privacy policy

_Last updated: 14 October 2026_

ZoomCapture is a Chrome extension that records your screen, a window or a browser tab, and lets you edit and export the recording. It is built to keep your recordings on your own device.

## What ZoomCapture stores, and where

Everything is stored **only on your device**, inside your Chrome profile's storage for the extension:

- **Recordings:** the video and audio you record, the camera and microphone tracks, and their thumbnails.
- **Projects:** your edits (cuts, zoom effects, text, subtitles, backgrounds, music and other settings), and any files you import into a project (videos, audio, images, PDFs).
- **Click positions:** these are recorded only in the tab you record, and only while recording. ZoomCapture stores where and when you clicked and where the pointer was. It never stores page content, form contents or keystrokes.
- **Settings:** your preferences, stored in Chrome's local extension storage. They are not synced.
- **A diagnostic log:** up to 50 recent error messages. Names, file paths, web addresses and e-mail addresses are removed before saving, and media and text are never logged. It stays on your device; you can copy it to your clipboard yourself, or clear it, in Settings.

Nothing is uploaded, synced or shared. ZoomCapture has **no accounts, no analytics, no advertising and no tracking**, and it does not sell or transfer any data.

## Network use

ZoomCapture makes no network requests of its own, with one exception you start yourself:

- **Automatic subtitles:** the first time you click *Generate subtitles*, the chosen speech-recognition model (OpenAI Whisper, about 40–80 MB) is downloaded from Hugging Face (`huggingface.co`) and cached by your browser. Recognition then runs entirely on your device. **Your audio is never sent anywhere.** Hugging Face receives an ordinary download request (with your IP address, as with any download) and no recording data. See [Hugging Face's privacy policy](https://huggingface.co/privacy).

The extension's Content Security Policy blocks network access to anything other than the extension itself and the Hugging Face model hosts.

## Permissions

| Permission | Why |
| --- | --- |
| `storage`, `unlimitedStorage` | To keep settings, recordings and projects on your device, without the browser evicting large recordings. |
| `activeTab`, `scripting` | When you click the toolbar icon and choose to record a tab, the click tracker is added to **that tab only**, until you leave the site. |
| `tabCapture` | To record the tab you chose without showing Chrome's picker again. |
| `nativeMessaging` (optional, off by default) | Only if you turn on the Windows controls helper, which shows recording controls that Windows leaves out of screen captures. |
| Website access (optional, off by default) | Asked for one site at a time, only if you choose "Always allow on this site", so click tracking continues after navigating away and back. |

Camera, microphone and screen access is granted by Chrome itself, with Chrome's own prompts and sharing indicator. ZoomCapture never starts recording without your action.

## Deleting your data

- **One recording:** delete it from the dashboard. Its media, edits and imported files are removed permanently.
- **Everything:** remove the extension from `chrome://extensions`. Chrome deletes all of its data.

## Contact

Questions about this policy: open an issue in the project's repository, or contact the publisher listed on the Chrome Web Store page.
