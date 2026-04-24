(function (root, factory) {
  const shared = factory();
  root.ExifViewerShared = shared;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = shared;
  }
})(
  typeof globalThis !== 'undefined' ? globalThis : this,
  function () {
    'use strict';

    const TYPE_SIZES = {
      1: 1,
      2: 1,
      3: 2,
      4: 4,
      5: 8,
      6: 1,
      7: 1,
      8: 2,
      9: 4,
      10: 8,
      11: 4,
      12: 8,
    };

    const GROUP_LABELS = {
      ifd0: 'Image',
      exif: 'EXIF',
      gps: 'GPS',
      interop: 'Interop',
      ifd1: 'Thumbnail',
    };

    const TAGS = {
      ifd0: {
        0x010e: 'ImageDescription',
        0x010f: 'Make',
        0x0110: 'Model',
        0x0112: 'Orientation',
        0x011a: 'XResolution',
        0x011b: 'YResolution',
        0x0128: 'ResolutionUnit',
        0x0131: 'Software',
        0x0132: 'ModifyDate',
        0x013b: 'Artist',
        0x8298: 'Copyright',
        0x8769: 'ExifIFDPointer',
        0x8825: 'GPSInfoIFDPointer',
      },
      exif: {
        0x829a: 'ExposureTime',
        0x829d: 'FNumber',
        0x8822: 'ExposureProgram',
        0x8827: 'ISO',
        0x9000: 'ExifVersion',
        0x9003: 'DateTimeOriginal',
        0x9004: 'CreateDate',
        0x9101: 'ComponentsConfiguration',
        0x9201: 'ShutterSpeedValue',
        0x9202: 'ApertureValue',
        0x9204: 'ExposureBiasValue',
        0x9207: 'MeteringMode',
        0x9209: 'Flash',
        0x920a: 'FocalLength',
        0x9286: 'UserComment',
        0xa002: 'PixelXDimension',
        0xa003: 'PixelYDimension',
        0xa403: 'WhiteBalance',
        0xa405: 'FocalLengthIn35mmFormat',
        0xa406: 'SceneCaptureType',
        0xa420: 'ImageUniqueID',
        0xa434: 'LensModel',
        0xa005: 'InteroperabilityIFDPointer',
      },
      gps: {
        0x0000: 'GPSVersionID',
        0x0001: 'GPSLatitudeRef',
        0x0002: 'GPSLatitude',
        0x0003: 'GPSLongitudeRef',
        0x0004: 'GPSLongitude',
        0x0005: 'GPSAltitudeRef',
        0x0006: 'GPSAltitude',
        0x0012: 'GPSMapDatum',
        0x001d: 'GPSDateStamp',
      },
      interop: {
        0x0001: 'InteropIndex',
      },
      ifd1: {
        0x0201: 'JPEGInterchangeFormat',
        0x0202: 'JPEGInterchangeFormatLength',
      },
    };

    const STRUCTURAL_TAGS = {
      ifd0: new Set([0x8769, 0x8825]),
      exif: new Set([0xa005]),
      gps: new Set([]),
      interop: new Set([]),
      ifd1: new Set([0x0201, 0x0202]),
    };

    function readAscii(bytes, offset, length) {
      if (offset < 0 || length < 0 || offset + length > bytes.byteLength) {
        throw new Error('binary payload is truncated');
      }
      let out = '';
      for (let i = 0; i < length; i += 1) {
        out += String.fromCharCode(bytes[offset + i]);
      }
      return out;
    }

    function requireRange(bytes, offset, length) {
      if (offset < 0 || length < 0 || offset + length > bytes.byteLength) {
        throw new Error('binary payload is truncated');
      }
    }

    function readUint16(view, bytes, offset, littleEndian) {
      requireRange(bytes, offset, 2);
      return view.getUint16(offset, littleEndian);
    }

    function readInt16(view, bytes, offset, littleEndian) {
      requireRange(bytes, offset, 2);
      return view.getInt16(offset, littleEndian);
    }

    function readUint32(view, bytes, offset, littleEndian) {
      requireRange(bytes, offset, 4);
      return view.getUint32(offset, littleEndian);
    }

    function readInt32(view, bytes, offset, littleEndian) {
      requireRange(bytes, offset, 4);
      return view.getInt32(offset, littleEndian);
    }

    function readFloat32(view, bytes, offset, littleEndian) {
      requireRange(bytes, offset, 4);
      return view.getFloat32(offset, littleEndian);
    }

    function readFloat64(view, bytes, offset, littleEndian) {
      requireRange(bytes, offset, 8);
      return view.getFloat64(offset, littleEndian);
    }

    function readBigEndianUint32(bytes, offset) {
      requireRange(bytes, offset, 4);
      return (
        (bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3]
      ) >>> 0;
    }

    function readBigEndianUint16(bytes, offset) {
      requireRange(bytes, offset, 2);
      return ((bytes[offset] << 8) | bytes[offset + 1]) >>> 0;
    }

    function trimAscii(value) {
      return String(value || '').replace(/\0+$/g, '').trim();
    }

    function tagName(groupId, tag) {
      return TAGS[groupId]?.[tag] || `Tag 0x${tag.toString(16).toUpperCase().padStart(4, '0')}`;
    }

    function isStructuralTag(groupId, tag) {
      return STRUCTURAL_TAGS[groupId]?.has(tag) === true;
    }

    function rationalValue(rational) {
      if (!rational || !Number.isFinite(rational.denominator) || rational.denominator === 0) {
        return Number.NaN;
      }
      return rational.numerator / rational.denominator;
    }

    function numberString(value, digits = 4) {
      if (!Number.isFinite(value)) return 'n/a';
      const fixed = value.toFixed(digits);
      return fixed.replace(/\.?0+$/g, '');
    }

    function formatGenericRational(rational, digits = 4) {
      const value = rationalValue(rational);
      return numberString(value, digits);
    }

    function decodeUserComment(rawValue) {
      if (!(rawValue instanceof Uint8Array) || rawValue.byteLength < 8) return null;
      const prefix = readAscii(rawValue, 0, 8);
      if (/^ASCII\0\0\0/.test(prefix)) {
        return trimAscii(readAscii(rawValue, 8, rawValue.byteLength - 8));
      }
      return null;
    }

    function formatByteArray(rawValue) {
      if (!(rawValue instanceof Uint8Array)) return '';
      const printable = trimAscii(readAscii(rawValue, 0, rawValue.byteLength));
      if (printable && /^[\x20-\x7E]+$/.test(printable)) return printable;
      return Array.from(rawValue.slice(0, 16))
        .map((byte) => byte.toString(16).toUpperCase().padStart(2, '0'))
        .join(' ');
    }

    function genericValueString(rawValue) {
      if (typeof rawValue === 'string') return trimAscii(rawValue);
      if (typeof rawValue === 'number') return String(rawValue);
      if (rawValue instanceof Uint8Array) return formatByteArray(rawValue);
      if (rawValue && typeof rawValue === 'object' && 'numerator' in rawValue) {
        return formatGenericRational(rawValue);
      }
      if (Array.isArray(rawValue)) {
        return rawValue.map((item) => genericValueString(item)).join(', ');
      }
      return String(rawValue ?? '');
    }

    function orientationString(value) {
      const map = {
        1: 'Top-left',
        2: 'Top-right (mirrored)',
        3: 'Rotate 180°',
        4: 'Bottom-left (mirrored)',
        5: 'Rotate 90° CW (mirrored)',
        6: 'Rotate 90° CW',
        7: 'Rotate 270° CW (mirrored)',
        8: 'Rotate 270° CW',
      };
      return map[value] || String(value);
    }

    function resolutionUnitString(value) {
      const map = {
        1: 'No unit',
        2: 'inch',
        3: 'cm',
      };
      return map[value] || String(value);
    }

    function exposureProgramString(value) {
      const map = {
        0: 'Not defined',
        1: 'Manual',
        2: 'Normal program',
        3: 'Aperture priority',
        4: 'Shutter priority',
        5: 'Creative program',
        6: 'Action program',
        7: 'Portrait mode',
        8: 'Landscape mode',
      };
      return map[value] || String(value);
    }

    function meteringModeString(value) {
      const map = {
        0: 'Unknown',
        1: 'Average',
        2: 'Center-weighted average',
        3: 'Spot',
        4: 'Multi-spot',
        5: 'Pattern',
        6: 'Partial',
      };
      return map[value] || String(value);
    }

    function whiteBalanceString(value) {
      return value === 1 ? 'Manual' : value === 0 ? 'Auto' : String(value);
    }

    function sceneCaptureTypeString(value) {
      const map = {
        0: 'Standard',
        1: 'Landscape',
        2: 'Portrait',
        3: 'Night scene',
      };
      return map[value] || String(value);
    }

    function flashString(value) {
      if (!Number.isFinite(value)) return 'Unknown';
      const fired = value & 0x1 ? 'Flash fired' : 'Flash did not fire';
      const auto = value & 0x18 ? ', auto mode' : '';
      const redEye = value & 0x40 ? ', red-eye reduction' : '';
      return `${fired}${auto}${redEye}`;
    }

    function exposureTimeString(rawValue) {
      const value = rationalValue(rawValue);
      if (!Number.isFinite(value) || value <= 0) return genericValueString(rawValue);
      if (value >= 1) return `${numberString(value, 2)} s`;
      return `1/${Math.round(1 / value)} s`;
    }

    function apertureString(rawValue) {
      const value = rationalValue(rawValue);
      if (!Number.isFinite(value)) return genericValueString(rawValue);
      return `f/${numberString(value, 1)}`;
    }

    function focalLengthString(rawValue) {
      const value = rationalValue(rawValue);
      if (!Number.isFinite(value)) return genericValueString(rawValue);
      return `${numberString(value, 1)} mm`;
    }

    function focalLength35mmString(rawValue) {
      return Number.isFinite(rawValue) ? `${rawValue} mm` : genericValueString(rawValue);
    }

    function exposureBiasString(rawValue) {
      const value = rationalValue(rawValue);
      if (!Number.isFinite(value)) return genericValueString(rawValue);
      const sign = value > 0 ? '+' : '';
      return `${sign}${numberString(value, 2)} EV`;
    }

    function gpsVersionString(rawValue) {
      if (!Array.isArray(rawValue)) return genericValueString(rawValue);
      return rawValue.join('.');
    }

    function gpsCoordinateDecimal(rawValue, ref) {
      if (!Array.isArray(rawValue) || rawValue.length !== 3) return null;
      const degrees = rationalValue(rawValue[0]);
      const minutes = rationalValue(rawValue[1]);
      const seconds = rationalValue(rawValue[2]);
      if (![degrees, minutes, seconds].every(Number.isFinite)) return null;
      let value = degrees + minutes / 60 + seconds / 3600;
      if (ref === 'S' || ref === 'W') value *= -1;
      return value;
    }

    function gpsCoordinateString(rawValue, ref) {
      if (!Array.isArray(rawValue) || rawValue.length !== 3) return genericValueString(rawValue);
      const degrees = rationalValue(rawValue[0]);
      const minutes = rationalValue(rawValue[1]);
      const seconds = rationalValue(rawValue[2]);
      if (![degrees, minutes, seconds].every(Number.isFinite)) {
        return genericValueString(rawValue);
      }
      const parts = [
        `${numberString(degrees, 0)}°`,
        `${numberString(minutes, 0)}'`,
        `${numberString(seconds, 2)}"`,
      ];
      const decimal = gpsCoordinateDecimal(rawValue, ref);
      const suffix = ref ? ` ${ref}` : '';
      const decimalText = Number.isFinite(decimal) ? ` (${numberString(decimal, 6)})` : '';
      return `${parts.join(' ')}${suffix}${decimalText}`;
    }

    function gpsAltitudeString(rawValue, ref) {
      const value = rationalValue(rawValue);
      if (!Number.isFinite(value)) return genericValueString(rawValue);
      const signed = ref === 1 ? -value : value;
      return `${numberString(signed, 2)} m`;
    }

    function exifVersionString(rawValue) {
      if (rawValue instanceof Uint8Array) return trimAscii(readAscii(rawValue, 0, rawValue.byteLength));
      return genericValueString(rawValue);
    }

    function formatValue(groupId, tag, rawValue) {
      if (groupId === 'ifd0' && tag === 0x0112) return orientationString(rawValue);
      if (groupId === 'ifd0' && tag === 0x0128) return resolutionUnitString(rawValue);
      if (groupId === 'exif' && tag === 0x829a) return exposureTimeString(rawValue);
      if (groupId === 'exif' && tag === 0x829d) return apertureString(rawValue);
      if (groupId === 'exif' && tag === 0x8822) return exposureProgramString(rawValue);
      if (groupId === 'exif' && tag === 0x8827) return Number.isFinite(rawValue) ? `ISO ${rawValue}` : genericValueString(rawValue);
      if (groupId === 'exif' && tag === 0x9000) return exifVersionString(rawValue);
      if (groupId === 'exif' && tag === 0x9204) return exposureBiasString(rawValue);
      if (groupId === 'exif' && tag === 0x9207) return meteringModeString(rawValue);
      if (groupId === 'exif' && tag === 0x9209) return flashString(rawValue);
      if (groupId === 'exif' && tag === 0x920a) return focalLengthString(rawValue);
      if (groupId === 'exif' && tag === 0x9286) return decodeUserComment(rawValue) || formatByteArray(rawValue);
      if (groupId === 'exif' && tag === 0xa403) return whiteBalanceString(rawValue);
      if (groupId === 'exif' && tag === 0xa405) return focalLength35mmString(rawValue);
      if (groupId === 'exif' && tag === 0xa406) return sceneCaptureTypeString(rawValue);
      if (groupId === 'gps' && tag === 0x0000) return gpsVersionString(rawValue);
      return genericValueString(rawValue);
    }

    function decodeValue(view, bytes, tiffOffset, valueFieldOffset, type, count, littleEndian) {
      const typeSize = TYPE_SIZES[type];
      if (!typeSize) {
        throw new Error(`unsupported EXIF field type: ${type}`);
      }

      const totalSize = typeSize * count;
      const actualOffset =
        totalSize <= 4
          ? valueFieldOffset
          : tiffOffset + readUint32(view, bytes, valueFieldOffset, littleEndian);

      requireRange(bytes, actualOffset, totalSize);

      if (type === 2) {
        return trimAscii(readAscii(bytes, actualOffset, count));
      }
      if (type === 7) {
        return bytes.slice(actualOffset, actualOffset + totalSize);
      }

      const values = [];
      for (let index = 0; index < count; index += 1) {
        const valueOffset = actualOffset + typeSize * index;
        if (type === 1 || type === 6) values.push(bytes[valueOffset]);
        else if (type === 3) values.push(readUint16(view, bytes, valueOffset, littleEndian));
        else if (type === 4) values.push(readUint32(view, bytes, valueOffset, littleEndian));
        else if (type === 5) {
          values.push({
            numerator: readUint32(view, bytes, valueOffset, littleEndian),
            denominator: readUint32(view, bytes, valueOffset + 4, littleEndian),
          });
        } else if (type === 8) values.push(readInt16(view, bytes, valueOffset, littleEndian));
        else if (type === 9) values.push(readInt32(view, bytes, valueOffset, littleEndian));
        else if (type === 10) {
          values.push({
            numerator: readInt32(view, bytes, valueOffset, littleEndian),
            denominator: readInt32(view, bytes, valueOffset + 4, littleEndian),
          });
        } else if (type === 11) values.push(readFloat32(view, bytes, valueOffset, littleEndian));
        else if (type === 12) values.push(readFloat64(view, bytes, valueOffset, littleEndian));
      }
      return count === 1 ? values[0] : values;
    }

    function updateGpsDisplay(section, rawByTag) {
      const latitudeRef = trimAscii(rawByTag.get(0x0001));
      const longitudeRef = trimAscii(rawByTag.get(0x0003));
      const altitudeRef = rawByTag.get(0x0005);
      for (const entry of section.entries) {
        if (entry.tag === 0x0002) {
          entry.displayValue = gpsCoordinateString(entry.rawValue, latitudeRef);
        } else if (entry.tag === 0x0004) {
          entry.displayValue = gpsCoordinateString(entry.rawValue, longitudeRef);
        } else if (entry.tag === 0x0006) {
          entry.displayValue = gpsAltitudeString(entry.rawValue, altitudeRef);
        }
      }
    }

    function findSectionEntry(section, tag) {
      return section?.entries.find((entry) => entry.tag === tag) || null;
    }

    function buildSummary(sections) {
      const summary = {};
      const gpsSection = sections.find((section) => section.id === 'gps');
      if (gpsSection) {
        const latitudeRef = trimAscii(findSectionEntry(gpsSection, 0x0001)?.rawValue);
        const longitudeRef = trimAscii(findSectionEntry(gpsSection, 0x0003)?.rawValue);
        const latitude = gpsCoordinateDecimal(findSectionEntry(gpsSection, 0x0002)?.rawValue, latitudeRef);
        const longitude = gpsCoordinateDecimal(findSectionEntry(gpsSection, 0x0004)?.rawValue, longitudeRef);
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          const altitudeRef = findSectionEntry(gpsSection, 0x0005)?.rawValue;
          const altitudeValue = rationalValue(findSectionEntry(gpsSection, 0x0006)?.rawValue);
          summary.gps = {
            latitude,
            longitude,
          };
          if (Number.isFinite(altitudeValue)) {
            summary.gps.altitude = altitudeRef === 1 ? -altitudeValue : altitudeValue;
          }
        }
      }
      return summary;
    }

    function parseTiff(bytes, tiffOffset, container) {
      requireRange(bytes, tiffOffset, 8);
      const byteOrder = readAscii(bytes, tiffOffset, 2);
      const littleEndian = byteOrder === 'II';
      if (!littleEndian && byteOrder !== 'MM') {
        throw new Error('unsupported TIFF byte order');
      }

      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const magic = readUint16(view, bytes, tiffOffset + 2, littleEndian);
      if (magic !== 42) {
        throw new Error('unsupported TIFF header');
      }

      const sections = [];
      const visited = new Set();

      function parseIfd(groupId, ifdOffset) {
        if (!ifdOffset) return { nextIfdOffset: 0, pointers: {} };
        if (visited.has(`${groupId}:${ifdOffset}`)) return { nextIfdOffset: 0, pointers: {} };
        visited.add(`${groupId}:${ifdOffset}`);

        const absoluteOffset = tiffOffset + ifdOffset;
        const entryCount = readUint16(view, bytes, absoluteOffset, littleEndian);
        requireRange(bytes, absoluteOffset + 2, entryCount * 12 + 4);

        const rawByTag = new Map();
        const section = {
          id: groupId,
          label: GROUP_LABELS[groupId] || groupId,
          entries: [],
        };
        const pointers = {};

        for (let index = 0; index < entryCount; index += 1) {
          const entryOffset = absoluteOffset + 2 + index * 12;
          const tag = readUint16(view, bytes, entryOffset, littleEndian);
          const type = readUint16(view, bytes, entryOffset + 2, littleEndian);
          const count = readUint32(view, bytes, entryOffset + 4, littleEndian);
          const rawValue = decodeValue(
            view,
            bytes,
            tiffOffset,
            entryOffset + 8,
            type,
            count,
            littleEndian
          );
          rawByTag.set(tag, rawValue);

          if (groupId === 'ifd0' && tag === 0x8769) {
            pointers.exif = rawValue;
            continue;
          }
          if (groupId === 'ifd0' && tag === 0x8825) {
            pointers.gps = rawValue;
            continue;
          }
          if (groupId === 'exif' && tag === 0xa005) {
            pointers.interop = rawValue;
            continue;
          }
          if (isStructuralTag(groupId, tag)) continue;

          section.entries.push({
            group: groupId,
            tag,
            name: tagName(groupId, tag),
            rawValue,
            displayValue: formatValue(groupId, tag, rawValue),
          });
        }

        if (groupId === 'gps') {
          updateGpsDisplay(section, rawByTag);
        }

        if (section.entries.length > 0) {
          sections.push(section);
        }

        return {
          nextIfdOffset: readUint32(view, bytes, absoluteOffset + 2 + entryCount * 12, littleEndian),
          pointers,
        };
      }

      const ifd0Offset = readUint32(view, bytes, tiffOffset + 4, littleEndian);
      const ifd0 = parseIfd('ifd0', ifd0Offset);
      if (Number.isFinite(ifd0.pointers?.exif)) parseIfd('exif', ifd0.pointers.exif);
      if (Number.isFinite(ifd0.pointers?.gps)) parseIfd('gps', ifd0.pointers.gps);
      if (Number.isFinite(ifd0.nextIfdOffset) && ifd0.nextIfdOffset > 0) {
        parseIfd('ifd1', ifd0.nextIfdOffset);
      }

      return {
        container,
        hasExif: sections.length > 0,
        sections,
        summary: buildSummary(sections),
      };
    }

    function findJpegExif(bytes) {
      let offset = 2;
      while (offset + 4 <= bytes.byteLength) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        let markerOffset = offset + 1;
        while (markerOffset < bytes.byteLength && bytes[markerOffset] === 0xff) {
          markerOffset += 1;
        }
        if (markerOffset >= bytes.byteLength) break;
        const marker = bytes[markerOffset];
        offset = markerOffset + 1;
        if (marker === 0xd9 || marker === 0xda) break;
        if (marker >= 0xd0 && marker <= 0xd7) continue;
        if (offset + 2 > bytes.byteLength) break;
        const segmentLength = readBigEndianUint16(bytes, offset);
        const segmentDataOffset = offset + 2;
        if (
          marker === 0xe1 &&
          segmentLength >= 8 &&
          segmentDataOffset + segmentLength - 2 <= bytes.byteLength &&
          readAscii(bytes, segmentDataOffset, 6) === 'Exif\0\0'
        ) {
          return segmentDataOffset + 6;
        }
        offset += segmentLength;
      }
      return null;
    }

    function findPngExif(bytes) {
      let offset = 8;
      while (offset + 12 <= bytes.byteLength) {
        const length = readBigEndianUint32(bytes, offset);
        const type = readAscii(bytes, offset + 4, 4);
        const dataOffset = offset + 8;
        if (type === 'eXIf') {
          requireRange(bytes, dataOffset, length);
          return dataOffset;
        }
        offset += 12 + length;
      }
      return null;
    }

    function findWebpExif(bytes) {
      let offset = 12;
      while (offset + 8 <= bytes.byteLength) {
        const chunkType = readAscii(bytes, offset, 4);
        const chunkLength =
          bytes[offset + 4] |
          (bytes[offset + 5] << 8) |
          (bytes[offset + 6] << 16) |
          (bytes[offset + 7] << 24);
        const dataOffset = offset + 8;
        requireRange(bytes, dataOffset, chunkLength);
        if (chunkType === 'EXIF') {
          if (chunkLength >= 6 && readAscii(bytes, dataOffset, 6) === 'Exif\0\0') {
            return dataOffset + 6;
          }
          return dataOffset;
        }
        offset += 8 + chunkLength + (chunkLength % 2);
      }
      return null;
    }

    function detectContainer(bytes) {
      if (
        bytes.byteLength >= 2 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8
      ) {
        return 'jpeg';
      }
      if (
        bytes.byteLength >= 8 &&
        readAscii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n'
      ) {
        return 'png';
      }
      if (
        bytes.byteLength >= 12 &&
        readAscii(bytes, 0, 4) === 'RIFF' &&
        readAscii(bytes, 8, 4) === 'WEBP'
      ) {
        return 'webp';
      }
      if (
        bytes.byteLength >= 4 &&
        (readAscii(bytes, 0, 4) === 'II*\0' || readAscii(bytes, 0, 4) === 'MM\0*')
      ) {
        return 'tiff';
      }
      return null;
    }

    function parseExifMetadata(input) {
      const bytes =
        input instanceof Uint8Array ? input : new Uint8Array(input instanceof ArrayBuffer ? input : []);
      if (bytes.byteLength === 0) {
        throw new Error('empty image payload');
      }

      const container = detectContainer(bytes);
      if (!container) {
        throw new Error('unsupported image format');
      }

      if (container === 'tiff') {
        return parseTiff(bytes, 0, container);
      }

      const tiffOffset =
        container === 'jpeg'
          ? findJpegExif(bytes)
          : container === 'png'
            ? findPngExif(bytes)
            : findWebpExif(bytes);

      if (tiffOffset == null) {
        return {
          container,
          hasExif: false,
          sections: [],
          summary: {},
        };
      }

      return parseTiff(bytes, tiffOffset, container);
    }

    return {
      parseExifMetadata,
    };
  }
);
