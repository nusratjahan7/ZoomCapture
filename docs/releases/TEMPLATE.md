<!--
Copy to docs/releases/vX.Y.Z.md for each release. The workflow uses that file as the GitHub
Release text (it fails if the file for the pushed tag is missing). Delete sections with nothing
in them, and this comment.
-->
One or two sentences: what this release is about.

## Install or update

- **New install:** download **`ZoomCapture-vX.Y.Z.zip`** below, extract it to a folder you will keep, then open `chrome://extensions` → **Developer mode** → **Load unpacked**, and choose the folder that contains `manifest.json`.
- **Updating:** replace the files in your existing ZoomCapture folder with the new ones, then click **Reload** on ZoomCapture's card in `chrome://extensions`. Don't click **Remove**: that deletes your recordings. Details: [README → Updating](https://github.com/nusratjahan7/ZoomCapture#updating-to-a-newer-version).

## New features

-

## Bug fixes

-

## Improvements

-

## Known issues

-

## Checksum

Compare the SHA-256 in `ZoomCapture-vX.Y.Z.zip.sha256` with `Get-FileHash ZoomCapture-vX.Y.Z.zip -Algorithm SHA256` (Windows), `shasum -a 256 …` (macOS) or `sha256sum …` (Linux).
