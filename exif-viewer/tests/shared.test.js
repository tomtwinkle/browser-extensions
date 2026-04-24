'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseExifMetadata } = require('../shared.js');

const TYPE = {
  ASCII: 2,
  SHORT: 3,
  LONG: 4,
  RATIONAL: 5,
};

const TYPE_SIZES = {
  [TYPE.ASCII]: 1,
  [TYPE.SHORT]: 2,
  [TYPE.LONG]: 4,
  [TYPE.RATIONAL]: 8,
};

function writeUint16LE(buffer, offset, value) {
  buffer.writeUInt16LE(value, offset);
}

function writeUint32LE(buffer, offset, value) {
  buffer.writeUInt32LE(value, offset);
}

function encodeValue(type, value) {
  if (type === TYPE.ASCII) {
    const text = value.endsWith('\0') ? value : `${value}\0`;
    return Buffer.from(text, 'ascii');
  }
  if (type === TYPE.SHORT) {
    const values = Array.isArray(value) ? value : [value];
    const buffer = Buffer.alloc(values.length * 2);
    values.forEach((item, index) => writeUint16LE(buffer, index * 2, item));
    return buffer;
  }
  if (type === TYPE.LONG) {
    const values = Array.isArray(value) ? value : [value];
    const buffer = Buffer.alloc(values.length * 4);
    values.forEach((item, index) => writeUint32LE(buffer, index * 4, item));
    return buffer;
  }
  if (type === TYPE.RATIONAL) {
    const values = Array.isArray(value[0]) ? value : [value];
    const buffer = Buffer.alloc(values.length * 8);
    values.forEach(([numerator, denominator], index) => {
      writeUint32LE(buffer, index * 8, numerator);
      writeUint32LE(buffer, index * 8 + 4, denominator);
    });
    return buffer;
  }
  throw new Error(`Unsupported test TIFF type: ${type}`);
}

function buildTiff() {
  const ifd0Entries = [
    { tag: 0x010f, type: TYPE.ASCII, value: 'Canon' },
    { tag: 0x0110, type: TYPE.ASCII, value: 'EOS R5' },
    { tag: 0x0112, type: TYPE.SHORT, value: 6 },
    { tag: 0x011a, type: TYPE.RATIONAL, value: [300, 1] },
    { tag: 0x011b, type: TYPE.RATIONAL, value: [300, 1] },
    { tag: 0x0128, type: TYPE.SHORT, value: 2 },
    { tag: 0x0131, type: TYPE.ASCII, value: 'Adobe Lightroom Classic' },
    { tag: 0x8769, type: TYPE.LONG, value: ({ offsets }) => offsets.exif },
    { tag: 0x8825, type: TYPE.LONG, value: ({ offsets }) => offsets.gps },
  ];

  const exifEntries = [
    { tag: 0x9003, type: TYPE.ASCII, value: '2026:04:24 10:00:00' },
    { tag: 0x9011, type: TYPE.ASCII, value: '+09:00' },
    { tag: 0x829a, type: TYPE.RATIONAL, value: [1, 125] },
    { tag: 0x829d, type: TYPE.RATIONAL, value: [28, 10] },
    { tag: 0x8827, type: TYPE.SHORT, value: 100 },
    { tag: 0x920a, type: TYPE.RATIONAL, value: [24, 1] },
    { tag: 0xa001, type: TYPE.SHORT, value: 1 },
    { tag: 0xa002, type: TYPE.LONG, value: 8192 },
    { tag: 0xa003, type: TYPE.LONG, value: 5464 },
    { tag: 0xa402, type: TYPE.SHORT, value: 1 },
    { tag: 0xa403, type: TYPE.SHORT, value: 0 },
    { tag: 0xa404, type: TYPE.RATIONAL, value: [1, 1] },
    { tag: 0xa405, type: TYPE.SHORT, value: 24 },
    { tag: 0xa432, type: TYPE.RATIONAL, value: [[24, 1], [70, 1], [28, 10], [28, 10]] },
    { tag: 0xa433, type: TYPE.ASCII, value: 'Canon' },
    { tag: 0xa434, type: TYPE.ASCII, value: 'RF24-70mm F2.8 L IS USM' },
  ];

  const gpsEntries = [
    { tag: 0x0001, type: TYPE.ASCII, value: 'N' },
    { tag: 0x0002, type: TYPE.RATIONAL, value: [[35, 1], [39, 1], [0, 1]] },
    { tag: 0x0003, type: TYPE.ASCII, value: 'E' },
    { tag: 0x0004, type: TYPE.RATIONAL, value: [[139, 1], [44, 1], [0, 1]] },
    { tag: 0x0005, type: TYPE.SHORT, value: 0 },
    { tag: 0x0006, type: TYPE.RATIONAL, value: [52, 1] },
    { tag: 0x0007, type: TYPE.RATIONAL, value: [[1, 1], [23, 1], [45, 1]] },
    { tag: 0x001d, type: TYPE.ASCII, value: '2026:04:24' },
  ];

  const groups = [
    { id: 'ifd0', entries: ifd0Entries },
    { id: 'exif', entries: exifEntries },
    { id: 'gps', entries: gpsEntries },
  ];

  const tableOffsets = {};
  let cursor = 8;
  for (const group of groups) {
    tableOffsets[group.id] = cursor;
    cursor += 2 + group.entries.length * 12 + 4;
  }

  const dataChunks = [];
  let dataOffset = cursor;

  for (const group of groups) {
    for (const entry of group.entries) {
      const resolvedValue =
        typeof entry.value === 'function' ? entry.value({ offsets: tableOffsets }) : entry.value;
      const encoded = encodeValue(entry.type, resolvedValue);
      entry.count = encoded.length / TYPE_SIZES[entry.type];
      if (encoded.length <= 4) {
        entry.inline = Buffer.alloc(4);
        encoded.copy(entry.inline, 0);
      } else {
        entry.offset = dataOffset;
        dataChunks.push({ offset: dataOffset, buffer: encoded });
        dataOffset += encoded.length;
      }
    }
  }

  const output = Buffer.alloc(dataOffset);
  output.write('II', 0, 'ascii');
  writeUint16LE(output, 2, 42);
  writeUint32LE(output, 4, tableOffsets.ifd0);

  for (const group of groups) {
    const groupOffset = tableOffsets[group.id];
    writeUint16LE(output, groupOffset, group.entries.length);
    group.entries.forEach((entry, index) => {
      const entryOffset = groupOffset + 2 + index * 12;
      writeUint16LE(output, entryOffset, entry.tag);
      writeUint16LE(output, entryOffset + 2, entry.type);
      writeUint32LE(output, entryOffset + 4, entry.count);
      if (entry.inline) {
        entry.inline.copy(output, entryOffset + 8);
      } else {
        writeUint32LE(output, entryOffset + 8, entry.offset);
      }
    });
    writeUint32LE(output, groupOffset + 2 + group.entries.length * 12, 0);
  }

  dataChunks.forEach(({ offset, buffer }) => buffer.copy(output, offset));
  return output;
}

function buildApp1Segment(payload) {
  const segment = Buffer.alloc(4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([segment, payload]);
}

function wrapJpeg(tiff, extraSegments = []) {
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...extraSegments,
    buildApp1Segment(exif),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function wrapPng(tiff) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const exifChunk = Buffer.alloc(8 + tiff.length + 4);
  exifChunk.writeUInt32BE(tiff.length, 0);
  exifChunk.write('eXIf', 4, 'ascii');
  tiff.copy(exifChunk, 8);
  const iendChunk = Buffer.alloc(12);
  iendChunk.writeUInt32BE(0, 0);
  iendChunk.write('IEND', 4, 'ascii');
  return Buffer.concat([signature, exifChunk, iendChunk]);
}

function wrapWebp(tiff) {
  const chunkSize = tiff.length;
  const padding = chunkSize % 2 === 1 ? Buffer.from([0x00]) : Buffer.alloc(0);
  const riffSize = 4 + 8 + chunkSize + padding.length;
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(riffSize, 4);
  header.write('WEBP', 8, 'ascii');
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write('EXIF', 0, 'ascii');
  chunkHeader.writeUInt32LE(chunkSize, 4);
  return Buffer.concat([header, chunkHeader, tiff, padding]);
}

function entryValue(metadata, sectionLabel, entryName) {
  const section = metadata.sections.find((item) => item.label === sectionLabel);
  return section?.entries.find((item) => item.name === entryName)?.displayValue || null;
}

function entryInfo(metadata, sectionLabel, entryName) {
  const section = metadata.sections.find((item) => item.label === sectionLabel);
  return section?.entries.find((item) => item.name === entryName) || null;
}

test('parseExifMetadata reads JPEG EXIF metadata and formats common tags', () => {
  const metadata = parseExifMetadata(wrapJpeg(buildTiff()));

  assert.equal(metadata.container, 'jpeg');
  assert.equal(metadata.hasExif, true);
  assert.equal(entryValue(metadata, 'Image', 'Make'), 'Canon');
  assert.equal(entryValue(metadata, 'Image', 'Model'), 'EOS R5');
  assert.equal(entryValue(metadata, 'Image', 'Orientation'), 'Rotate 90° CW');
  assert.equal(entryValue(metadata, 'Image', 'XResolution'), '300 pixels/inch');
  assert.equal(entryValue(metadata, 'Image', 'YResolution'), '300 pixels/inch');
  assert.equal(entryValue(metadata, 'EXIF', 'ExposureTime'), '1/125 s');
  assert.equal(entryValue(metadata, 'EXIF', 'FNumber'), 'f/2.8');
  assert.equal(entryValue(metadata, 'EXIF', 'ISO'), 'ISO 100');
  assert.equal(entryValue(metadata, 'EXIF', 'ExposureMode'), 'Manual exposure');
  assert.equal(entryValue(metadata, 'EXIF', 'ColorSpace'), 'sRGB');
  assert.equal(entryValue(metadata, 'EXIF', 'LensSpecification'), '24-70 mm f/2.8');
  assert.equal(entryValue(metadata, 'EXIF', 'LensModel'), 'RF24-70mm F2.8 L IS USM');
  assert.equal(entryValue(metadata, 'GPS', 'GPSLatitude'), '35° 39\' 0" N (35.65)');
  assert.equal(entryValue(metadata, 'GPS', 'GPSLongitude'), '139° 44\' 0" E (139.733333)');
  assert.equal(entryValue(metadata, 'GPS', 'GPSAltitude'), '52 m');
  assert.equal(entryValue(metadata, 'GPS', 'GPSTimeStamp'), '01:23:45 UTC');
  assert.equal(entryInfo(metadata, 'Image', 'Model')?.title, 'Camera model');
  assert.equal(
    entryInfo(metadata, 'Image', 'Model')?.description,
    'Camera body model recorded when the image was captured.'
  );
  assert.equal(metadata.summary.camera.display, 'Canon EOS R5');
  assert.equal(metadata.summary.lens.display, 'Canon RF24-70mm F2.8 L IS USM · 24-70 mm f/2.8');
  assert.equal(metadata.summary.capture.display, '2026:04:24 10:00:00 +09:00');
  assert.equal(metadata.summary.exposure.display, '1/125 s · f/2.8 · ISO 100 · 24 mm · 35mm equiv 24 mm');
  assert.equal(metadata.summary.image.size, '8192 × 5464');
  assert.equal(metadata.summary.software.display, 'Adobe Lightroom Classic');
  assert.deepEqual(metadata.summary.gps, {
    latitude: 35.65,
    longitude: 139.73333333333332,
    altitude: 52,
    timestamp: '2026:04:24 01:23:45 UTC',
  });
});

test('parseExifMetadata detects PNG eXIf and WebP EXIF wrappers', () => {
  const tiff = buildTiff();
  const png = parseExifMetadata(wrapPng(tiff));
  const webp = parseExifMetadata(wrapWebp(tiff));

  assert.equal(png.container, 'png');
  assert.equal(png.hasExif, true);
  assert.equal(entryValue(png, 'Image', 'Make'), 'Canon');

  assert.equal(webp.container, 'webp');
  assert.equal(webp.hasExif, true);
  assert.equal(entryValue(webp, 'EXIF', 'DateTimeOriginal'), '2026:04:24 10:00:00');
});

test('parseExifMetadata extracts XMP packets and decoded properties from JPEG APP1 data', () => {
  const xmpXml = `<?xpacket begin="﻿"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:dc="http://purl.org/dc/elements/1.1/">\n  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n    <rdf:Description dc:creator="Tomoki Harada">\n      <dc:title>Hover EXIF Viewer</dc:title>\n    </rdf:Description>\n  </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>`;
  const xmpSegment = buildApp1Segment(
    Buffer.concat([
      Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'ascii'),
      Buffer.from(xmpXml, 'utf8'),
    ])
  );

  const metadata = parseExifMetadata(wrapJpeg(buildTiff(), [xmpSegment]));

  assert.equal(metadata.xmp.hasXmp, true);
  assert.equal(metadata.xmp.packetCount, 1);
  assert.equal(metadata.xmp.packets[0].properties.some((entry) => entry.path === 'dc:title' && entry.value === 'Hover EXIF Viewer'), true);
  assert.equal(metadata.xmp.packets[0].properties.some((entry) => entry.path === 'rdf:Description@dc:creator' && entry.value === 'Tomoki Harada'), true);
  assert.equal(metadata.xmp.packets[0].hexDump.includes('3C 3F 78 70 61 63 6B 65 74'), true);
});

test('parseExifMetadata returns an empty EXIF result when no EXIF block exists', () => {
  const plainJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const metadata = parseExifMetadata(plainJpeg);

  assert.equal(metadata.container, 'jpeg');
  assert.equal(metadata.hasExif, false);
  assert.deepEqual(metadata.sections, []);
});
