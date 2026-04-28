# exif-viewer – Hover EXIF Viewer

A Chrome / Edge Manifest V3 extension that shows a small button only while the pointer is over an image, then displays the image's EXIF metadata in-page.

[日本語版 README](README.ja.md)

![Hover EXIF Viewer preview](./assets/hover-exif-viewer-preview.svg)

## Features

- Shows an `EXIF` button near the lower-right corner of the hovered image
- Ignores tiny icon-like images that are too small to comfortably show the hover button
- Reads EXIF metadata from JPEG, PNG (`eXIf`), WebP (`EXIF`), and TIFF payloads
- Surfaces more high-value metadata such as camera model, lens, capture time, exposure, image size, GPS, and other useful EXIF fields
- Adds clearer per-field titles and hover tooltips so each EXIF item is easier to understand
- Includes a `Decode XMP` button that opens a side-by-side XMP hex/binary view and decoded property list
- Fetches cross-origin images through the extension service worker so Chrome and Edge can inspect images loaded from CDNs
- Renders metadata in a lightweight in-page modal with no external dependencies

## Files

```text
exif-viewer/
├── manifest.json      Manifest V3 configuration
├── shared.js          Pure EXIF parsing helpers used by runtime + tests
├── background.js      Service worker for cross-origin image fetches
├── content.js         Hover button and in-page metadata modal
└── tests/             Node-based parser / UI tests
```

## Load the extension

1. Open `chrome://extensions` or `edge://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `exif-viewer/` directory

## Testing

```bash
node --test exif-viewer/tests/*.test.js
```
