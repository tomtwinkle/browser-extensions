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
        0x02bc: 'XMPPacket',
        0x8298: 'Copyright',
        0x8769: 'ExifIFDPointer',
        0x8825: 'GPSInfoIFDPointer',
        0xc614: 'UniqueCameraModel',
        0xc615: 'LocalizedCameraModel',
      },
      exif: {
        0x829a: 'ExposureTime',
        0x829d: 'FNumber',
        0x8822: 'ExposureProgram',
        0x8827: 'ISO',
        0x8830: 'SensitivityType',
        0x8831: 'StandardOutputSensitivity',
        0x8832: 'RecommendedExposureIndex',
        0x8833: 'ISOSpeed',
        0x9000: 'ExifVersion',
        0x9003: 'DateTimeOriginal',
        0x9004: 'CreateDate',
        0x9010: 'OffsetTime',
        0x9011: 'OffsetTimeOriginal',
        0x9012: 'OffsetTimeDigitized',
        0x9101: 'ComponentsConfiguration',
        0x9201: 'ShutterSpeedValue',
        0x9202: 'ApertureValue',
        0x9203: 'BrightnessValue',
        0x9204: 'ExposureBiasValue',
        0x9205: 'MaxApertureValue',
        0x9206: 'SubjectDistance',
        0x9207: 'MeteringMode',
        0x9208: 'LightSource',
        0x9209: 'Flash',
        0x920a: 'FocalLength',
        0x9214: 'SubjectArea',
        0x9286: 'UserComment',
        0xa000: 'FlashpixVersion',
        0xa001: 'ColorSpace',
        0xa002: 'PixelXDimension',
        0xa003: 'PixelYDimension',
        0xa20e: 'FocalPlaneXResolution',
        0xa20f: 'FocalPlaneYResolution',
        0xa210: 'FocalPlaneResolutionUnit',
        0xa217: 'SensingMethod',
        0xa300: 'FileSource',
        0xa301: 'SceneType',
        0xa401: 'CustomRendered',
        0xa402: 'ExposureMode',
        0xa403: 'WhiteBalance',
        0xa404: 'DigitalZoomRatio',
        0xa405: 'FocalLengthIn35mmFormat',
        0xa406: 'SceneCaptureType',
        0xa407: 'GainControl',
        0xa408: 'Contrast',
        0xa409: 'Saturation',
        0xa40a: 'Sharpness',
        0xa40c: 'SubjectDistanceRange',
        0xa420: 'ImageUniqueID',
        0xa432: 'LensSpecification',
        0xa433: 'LensMake',
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
        0x0007: 'GPSTimeStamp',
        0x0008: 'GPSSatellites',
        0x0009: 'GPSStatus',
        0x000a: 'GPSMeasureMode',
        0x000b: 'GPSDOP',
        0x000c: 'GPSSpeedRef',
        0x000d: 'GPSSpeed',
        0x000e: 'GPSTrackRef',
        0x000f: 'GPSTrack',
        0x0010: 'GPSImgDirectionRef',
        0x0011: 'GPSImgDirection',
        0x0012: 'GPSMapDatum',
        0x001d: 'GPSDateStamp',
        0x001f: 'GPSHPositioningError',
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
      if (value == null) return null;
      const map = {
        1: 'No unit',
        2: 'inch',
        3: 'cm',
      };
      return map[value] || String(value);
    }

    function colorSpaceString(value) {
      const map = {
        1: 'sRGB',
        0xffff: 'Uncalibrated',
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

    function exposureModeString(value) {
      const map = {
        0: 'Auto exposure',
        1: 'Manual exposure',
        2: 'Auto bracket',
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

    function lightSourceString(value) {
      const map = {
        0: 'Unknown',
        1: 'Daylight',
        2: 'Fluorescent',
        3: 'Tungsten',
        4: 'Flash',
        9: 'Fine weather',
        10: 'Cloudy',
        11: 'Shade',
        12: 'Daylight fluorescent',
        13: 'Day white fluorescent',
        14: 'Cool white fluorescent',
        15: 'White fluorescent',
        17: 'Standard light A',
        18: 'Standard light B',
        19: 'Standard light C',
        20: 'D55',
        21: 'D65',
        22: 'D75',
        23: 'D50',
        24: 'ISO studio tungsten',
        255: 'Other',
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

    function customRenderedString(value) {
      const map = {
        0: 'Normal process',
        1: 'Custom process',
      };
      return map[value] || String(value);
    }

    function gainControlString(value) {
      const map = {
        0: 'None',
        1: 'Low gain up',
        2: 'High gain up',
        3: 'Low gain down',
        4: 'High gain down',
      };
      return map[value] || String(value);
    }

    function contrastString(value) {
      const map = {
        0: 'Normal',
        1: 'Low',
        2: 'High',
      };
      return map[value] || String(value);
    }

    function saturationString(value) {
      const map = {
        0: 'Normal',
        1: 'Low',
        2: 'High',
      };
      return map[value] || String(value);
    }

    function sharpnessString(value) {
      const map = {
        0: 'Normal',
        1: 'Soft',
        2: 'Hard',
      };
      return map[value] || String(value);
    }

    function subjectDistanceRangeString(value) {
      const map = {
        0: 'Unknown',
        1: 'Macro',
        2: 'Close',
        3: 'Distant',
      };
      return map[value] || String(value);
    }

    function sensingMethodString(value) {
      const map = {
        1: 'Not defined',
        2: 'One-chip color area sensor',
        3: 'Two-chip color area sensor',
        4: 'Three-chip color area sensor',
        5: 'Color sequential area sensor',
        7: 'Trilinear sensor',
        8: 'Color sequential linear sensor',
      };
      return map[value] || String(value);
    }

    function sensitivityTypeString(value) {
      const map = {
        0: 'Unknown',
        1: 'Standard output sensitivity',
        2: 'Recommended exposure index',
        3: 'ISO speed',
        4: 'SOS + REI',
        5: 'SOS + ISO speed',
        6: 'REI + ISO speed',
        7: 'SOS + REI + ISO speed',
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

    function resolutionString(rawValue, unit) {
      const value = rationalValue(rawValue);
      if (!Number.isFinite(value)) return genericValueString(rawValue);
      return `${numberString(value, 2)} ${unit && unit !== 'No unit' ? `pixels/${unit}` : 'pixels'}`;
    }

    function subjectDistanceString(rawValue) {
      const value = rationalValue(rawValue);
      if (!Number.isFinite(value)) return genericValueString(rawValue);
      return `${numberString(value, 2)} m`;
    }

    function digitalZoomRatioString(rawValue) {
      const value = rationalValue(rawValue);
      if (!Number.isFinite(value)) return genericValueString(rawValue);
      if (value === 0) return 'None';
      return `${numberString(value, 2)}×`;
    }

    function subjectAreaString(rawValue) {
      if (!Array.isArray(rawValue)) return genericValueString(rawValue);
      return rawValue.join(', ');
    }

    function apexExposureTimeString(rawValue) {
      const apex = rationalValue(rawValue);
      if (!Number.isFinite(apex)) return genericValueString(rawValue);
      const exposureTime = Math.pow(2, -apex);
      if (!Number.isFinite(exposureTime) || exposureTime <= 0) return genericValueString(rawValue);
      if (exposureTime >= 1) return `${numberString(exposureTime, 2)} s`;
      return `1/${Math.max(1, Math.round(1 / exposureTime))} s`;
    }

    function apexApertureString(rawValue) {
      const apex = rationalValue(rawValue);
      if (!Number.isFinite(apex)) return genericValueString(rawValue);
      return `f/${numberString(Math.pow(2, apex / 2), 1)}`;
    }

    function exposureValueString(rawValue) {
      const value = rationalValue(rawValue);
      if (!Number.isFinite(value)) return genericValueString(rawValue);
      const sign = value > 0 ? '+' : '';
      return `${sign}${numberString(value, 2)} EV`;
    }

    function componentsConfigurationString(rawValue) {
      if (!(rawValue instanceof Uint8Array)) return genericValueString(rawValue);
      const map = {
        1: 'Y',
        2: 'Cb',
        3: 'Cr',
        4: 'R',
        5: 'G',
        6: 'B',
      };
      return Array.from(rawValue)
        .filter((value) => value !== 0)
        .map((value) => map[value] || value)
        .join(' ');
    }

    function flashpixVersionString(rawValue) {
      if (rawValue instanceof Uint8Array) return trimAscii(readAscii(rawValue, 0, rawValue.byteLength));
      return genericValueString(rawValue);
    }

    function fileSourceString(rawValue) {
      const value = rawValue instanceof Uint8Array ? rawValue[0] : rawValue;
      const map = {
        3: 'DSC',
      };
      return map[value] || genericValueString(rawValue);
    }

    function sceneTypeString(rawValue) {
      const value = rawValue instanceof Uint8Array ? rawValue[0] : rawValue;
      const map = {
        1: 'Directly photographed',
      };
      return map[value] || genericValueString(rawValue);
    }

    function lensSpecificationString(rawValue) {
      if (!Array.isArray(rawValue) || rawValue.length !== 4) return genericValueString(rawValue);
      const [minFocal, maxFocal, minAperture, maxAperture] = rawValue.map((value) => rationalValue(value));
      const focalText =
        Number.isFinite(minFocal) && Number.isFinite(maxFocal)
          ? minFocal === maxFocal
            ? `${numberString(minFocal, 1)} mm`
            : `${numberString(minFocal, 1)}-${numberString(maxFocal, 1)} mm`
          : null;
      const apertureText =
        Number.isFinite(minAperture) && Number.isFinite(maxAperture)
          ? minAperture === maxAperture
            ? `f/${numberString(minAperture, 1)}`
            : `f/${numberString(minAperture, 1)}-${numberString(maxAperture, 1)}`
          : null;
      return [focalText, apertureText].filter(Boolean).join(' ');
    }

    function gpsStatusString(rawValue) {
      const value = trimAscii(rawValue);
      const map = {
        A: 'Measurement active',
        V: 'Measurement void',
      };
      return map[value] || value || genericValueString(rawValue);
    }

    function gpsMeasureModeString(rawValue) {
      const value = trimAscii(rawValue);
      const map = {
        2: '2D',
        3: '3D',
      };
      return map[value] || value || genericValueString(rawValue);
    }

    function gpsTimeStampString(rawValue) {
      if (!Array.isArray(rawValue) || rawValue.length !== 3) return genericValueString(rawValue);
      const [hours, minutes, seconds] = rawValue.map((value) => rationalValue(value));
      if (![hours, minutes, seconds].every(Number.isFinite)) return genericValueString(rawValue);
      const secondText =
        Number.isInteger(seconds)
          ? String(seconds).padStart(2, '0')
          : numberString(seconds, 2).padStart(5, '0');
      return `${String(Math.floor(hours)).padStart(2, '0')}:${String(Math.floor(minutes)).padStart(2, '0')}:${secondText} UTC`;
    }

    function gpsSpeedString(rawValue, ref) {
      const value = rationalValue(rawValue);
      if (!Number.isFinite(value)) return genericValueString(rawValue);
      const unit = ref === 'M' ? 'mph' : ref === 'N' ? 'knots' : 'km/h';
      return `${numberString(value, 2)} ${unit}`;
    }

    function gpsDirectionString(rawValue, ref) {
      const value = rationalValue(rawValue);
      if (!Number.isFinite(value)) return genericValueString(rawValue);
      return `${numberString(value, 2)}°${ref ? ` ${ref}` : ''}`;
    }

    function combineLabel(primary, secondary) {
      const left = trimAscii(primary);
      const right = trimAscii(secondary);
      if (left && right) {
        if (right.toLowerCase().startsWith(left.toLowerCase())) return right;
        return `${left} ${right}`;
      }
      return left || right || null;
    }

    function joinParts(parts) {
      const filtered = parts.filter(Boolean);
      return filtered.length > 0 ? filtered.join(' · ') : null;
    }

    function dateTimeWithOffset(dateText, offsetText) {
      if (!dateText) return null;
      return offsetText ? `${dateText} ${offsetText}` : dateText;
    }

    function decodeUtf8(bytes) {
      if (typeof TextDecoder !== 'undefined') {
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      }
      if (typeof Buffer !== 'undefined') {
        return Buffer.from(bytes).toString('utf8');
      }
      return readAscii(bytes, 0, bytes.byteLength);
    }

    function encodeUtf8(text) {
      if (typeof TextEncoder !== 'undefined') {
        return new TextEncoder().encode(text);
      }
      if (typeof Buffer !== 'undefined') {
        return Uint8Array.from(Buffer.from(text, 'utf8'));
      }
      return Uint8Array.from(text, (char) => char.charCodeAt(0));
    }

    function humanizeTagName(name) {
      return name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/^GPS/, 'GPS ')
        .replace(/^EXIF/, 'EXIF ')
        .trim();
    }

    const TAG_DETAILS = {
      ifd0: {
        0x010e: {
          title: 'Image description',
          description: 'Free-form caption or description embedded in the image.',
        },
        0x010f: {
          title: 'Camera make',
          description: 'Manufacturer or camera brand recorded by the device.',
        },
        0x0110: {
          title: 'Camera model',
          description: 'Camera body model recorded when the image was captured.',
        },
        0x0112: {
          title: 'Orientation',
          description: 'How the image should be rotated or mirrored for correct display.',
        },
        0x011a: {
          title: 'Horizontal resolution',
          description: 'Stored horizontal print/display resolution recorded in the file.',
        },
        0x011b: {
          title: 'Vertical resolution',
          description: 'Stored vertical print/display resolution recorded in the file.',
        },
        0x0131: {
          title: 'Software',
          description: 'Application or firmware that last wrote the image metadata.',
        },
        0x0132: {
          title: 'Modified time',
          description: 'Timestamp of the last metadata or file modification recorded in EXIF.',
        },
        0xc614: {
          title: 'Unique camera model',
          description: 'DNG/XMP-style unique identifier for the camera model.',
        },
        0xc615: {
          title: 'Localized camera model',
          description: 'Localized display name for the camera model, when available.',
        },
      },
      exif: {
        0x829a: {
          title: 'Exposure time',
          description: 'Shutter duration used when the photo was captured.',
        },
        0x829d: {
          title: 'Aperture',
          description: 'Lens opening recorded as the f-number.',
        },
        0x8827: {
          title: 'ISO',
          description: 'Sensor sensitivity used for the capture.',
        },
        0x9003: {
          title: 'Capture time',
          description: 'Original capture date and time recorded by the camera.',
        },
        0x920a: {
          title: 'Focal length',
          description: 'Lens focal length at the moment the photo was taken.',
        },
        0xa001: {
          title: 'Color space',
          description: 'Color profile or color space recorded in the file.',
        },
        0xa002: {
          title: 'Image width',
          description: 'Pixel width reported by EXIF metadata.',
        },
        0xa003: {
          title: 'Image height',
          description: 'Pixel height reported by EXIF metadata.',
        },
        0xa402: {
          title: 'Exposure mode',
          description: 'Whether exposure was automatic, manual, or bracketed.',
        },
        0xa403: {
          title: 'White balance',
          description: 'White balance mode used for the capture.',
        },
        0xa404: {
          title: 'Digital zoom',
          description: 'Digital zoom ratio recorded by the camera.',
        },
        0xa405: {
          title: '35mm equivalent',
          description: 'Approximate focal length translated into 35mm film terms.',
        },
        0xa432: {
          title: 'Lens specification',
          description: 'Lens focal-length and aperture range recorded by EXIF.',
        },
        0xa433: {
          title: 'Lens make',
          description: 'Lens manufacturer recorded in EXIF.',
        },
        0xa434: {
          title: 'Lens model',
          description: 'Lens model recorded in EXIF.',
        },
      },
      gps: {
        0x0002: {
          title: 'Latitude',
          description: 'Latitude coordinate recorded by the capturing device.',
        },
        0x0004: {
          title: 'Longitude',
          description: 'Longitude coordinate recorded by the capturing device.',
        },
        0x0006: {
          title: 'Altitude',
          description: 'Approximate altitude recorded for the image location.',
        },
        0x0007: {
          title: 'GPS time',
          description: 'UTC time recorded by the GPS receiver.',
        },
        0x001d: {
          title: 'GPS date',
          description: 'UTC date recorded by the GPS receiver.',
        },
      },
    };

    function tagTitle(groupId, tag, name) {
      return TAG_DETAILS[groupId]?.[tag]?.title || humanizeTagName(name);
    }

    function tagDescription(groupId, tag, title) {
      return (
        TAG_DETAILS[groupId]?.[tag]?.description ||
        `${title} recorded in the image metadata.`
      );
    }

    function exifVersionString(rawValue) {
      if (rawValue instanceof Uint8Array) return trimAscii(readAscii(rawValue, 0, rawValue.byteLength));
      return genericValueString(rawValue);
    }

    function formatValue(groupId, tag, rawValue) {
      if (groupId === 'ifd0' && tag === 0x0112) return orientationString(rawValue);
      if (groupId === 'ifd0' && tag === 0x0128) return resolutionUnitString(rawValue);
      if (groupId === 'exif' && (tag === 0x8827 || tag === 0x8831 || tag === 0x8832 || tag === 0x8833)) {
        return Number.isFinite(rawValue) ? `ISO ${rawValue}` : genericValueString(rawValue);
      }
      if (groupId === 'exif' && tag === 0x8830) return sensitivityTypeString(rawValue);
      if (groupId === 'exif' && tag === 0x829a) return exposureTimeString(rawValue);
      if (groupId === 'exif' && tag === 0x829d) return apertureString(rawValue);
      if (groupId === 'exif' && tag === 0x9201) return apexExposureTimeString(rawValue);
      if (groupId === 'exif' && (tag === 0x9202 || tag === 0x9205)) return apexApertureString(rawValue);
      if (groupId === 'exif' && tag === 0x9203) return exposureValueString(rawValue);
      if (groupId === 'exif' && tag === 0x8822) return exposureProgramString(rawValue);
      if (groupId === 'exif' && tag === 0x9000) return exifVersionString(rawValue);
      if (groupId === 'exif' && tag === 0xa000) return flashpixVersionString(rawValue);
      if (groupId === 'exif' && tag === 0x9101) return componentsConfigurationString(rawValue);
      if (groupId === 'exif' && tag === 0x9204) return exposureBiasString(rawValue);
      if (groupId === 'exif' && tag === 0x9206) return subjectDistanceString(rawValue);
      if (groupId === 'exif' && tag === 0x9207) return meteringModeString(rawValue);
      if (groupId === 'exif' && tag === 0x9208) return lightSourceString(rawValue);
      if (groupId === 'exif' && tag === 0x9209) return flashString(rawValue);
      if (groupId === 'exif' && tag === 0x920a) return focalLengthString(rawValue);
      if (groupId === 'exif' && tag === 0x9214) return subjectAreaString(rawValue);
      if (groupId === 'exif' && tag === 0x9286) return decodeUserComment(rawValue) || formatByteArray(rawValue);
      if (groupId === 'exif' && tag === 0xa001) return colorSpaceString(rawValue);
      if (groupId === 'exif' && tag === 0xa217) return sensingMethodString(rawValue);
      if (groupId === 'exif' && tag === 0xa300) return fileSourceString(rawValue);
      if (groupId === 'exif' && tag === 0xa301) return sceneTypeString(rawValue);
      if (groupId === 'exif' && tag === 0xa401) return customRenderedString(rawValue);
      if (groupId === 'exif' && tag === 0xa402) return exposureModeString(rawValue);
      if (groupId === 'exif' && tag === 0xa403) return whiteBalanceString(rawValue);
      if (groupId === 'exif' && tag === 0xa404) return digitalZoomRatioString(rawValue);
      if (groupId === 'exif' && tag === 0xa405) return focalLength35mmString(rawValue);
      if (groupId === 'exif' && tag === 0xa406) return sceneCaptureTypeString(rawValue);
      if (groupId === 'exif' && tag === 0xa407) return gainControlString(rawValue);
      if (groupId === 'exif' && tag === 0xa408) return contrastString(rawValue);
      if (groupId === 'exif' && tag === 0xa409) return saturationString(rawValue);
      if (groupId === 'exif' && tag === 0xa40a) return sharpnessString(rawValue);
      if (groupId === 'exif' && tag === 0xa40c) return subjectDistanceRangeString(rawValue);
      if (groupId === 'exif' && tag === 0xa432) return lensSpecificationString(rawValue);
      if (groupId === 'gps' && tag === 0x0000) return gpsVersionString(rawValue);
      if (groupId === 'gps' && tag === 0x0009) return gpsStatusString(rawValue);
      if (groupId === 'gps' && tag === 0x000a) return gpsMeasureModeString(rawValue);
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
      const speedRef = trimAscii(rawByTag.get(0x000c));
      const trackRef = trimAscii(rawByTag.get(0x000e));
      const imageDirectionRef = trimAscii(rawByTag.get(0x0010));
      for (const entry of section.entries) {
        if (entry.tag === 0x0002) {
          entry.displayValue = gpsCoordinateString(entry.rawValue, latitudeRef);
        } else if (entry.tag === 0x0004) {
          entry.displayValue = gpsCoordinateString(entry.rawValue, longitudeRef);
        } else if (entry.tag === 0x0006) {
          entry.displayValue = gpsAltitudeString(entry.rawValue, altitudeRef);
        } else if (entry.tag === 0x0007) {
          entry.displayValue = gpsTimeStampString(entry.rawValue);
        } else if (entry.tag === 0x000d) {
          entry.displayValue = gpsSpeedString(entry.rawValue, speedRef);
        } else if (entry.tag === 0x000f) {
          entry.displayValue = gpsDirectionString(entry.rawValue, trackRef);
        } else if (entry.tag === 0x0011) {
          entry.displayValue = gpsDirectionString(entry.rawValue, imageDirectionRef);
        } else if (entry.tag === 0x001f) {
          entry.displayValue = subjectDistanceString(entry.rawValue);
        }
      }
    }

    function updateImageDisplay(section, rawByTag) {
      const resolutionUnit = resolutionUnitString(rawByTag.get(0x0128));
      for (const entry of section.entries) {
        if (entry.tag === 0x011a || entry.tag === 0x011b) {
          entry.displayValue = resolutionString(entry.rawValue, resolutionUnit);
        }
      }
    }

    function updateExifDisplay(section, rawByTag) {
      const resolutionUnit = resolutionUnitString(rawByTag.get(0xa210));
      for (const entry of section.entries) {
        if (entry.tag === 0xa20e || entry.tag === 0xa20f) {
          entry.displayValue = resolutionString(entry.rawValue, resolutionUnit);
        }
      }
    }

    function findSectionEntry(section, tag) {
      return section?.entries.find((entry) => entry.tag === tag) || null;
    }

    function findSection(sections, id) {
      return sections.find((section) => section.id === id) || null;
    }

    function sectionDisplayValue(section, tag) {
      return findSectionEntry(section, tag)?.displayValue || null;
    }

    function buildSummary(sections) {
      const summary = {};
      const imageSection = findSection(sections, 'ifd0');
      const exifSection = findSection(sections, 'exif');
      const gpsSection = findSection(sections, 'gps');

      const cameraMake = sectionDisplayValue(imageSection, 0x010f);
      const cameraModel =
        sectionDisplayValue(imageSection, 0x0110) ||
        sectionDisplayValue(imageSection, 0xc614) ||
        sectionDisplayValue(imageSection, 0xc615);
      const cameraDisplay = combineLabel(cameraMake, cameraModel) || cameraModel || cameraMake;
      if (cameraDisplay) {
        summary.camera = {
          make: cameraMake || null,
          model: cameraModel || null,
          display: cameraDisplay,
        };
      }

      const lensMake = sectionDisplayValue(exifSection, 0xa433);
      const lensModel = sectionDisplayValue(exifSection, 0xa434);
      const lensSpecification = sectionDisplayValue(exifSection, 0xa432);
      const lensName = combineLabel(lensMake, lensModel) || lensModel || lensMake;
      const lensDisplay =
        lensSpecification && lensSpecification !== lensName
          ? joinParts([lensName, lensSpecification])
          : lensName || lensSpecification;
      if (lensDisplay) {
        summary.lens = {
          display: lensDisplay,
        };
      }

      const capturedAt =
        dateTimeWithOffset(sectionDisplayValue(exifSection, 0x9003), sectionDisplayValue(exifSection, 0x9011)) ||
        dateTimeWithOffset(sectionDisplayValue(exifSection, 0x9004), sectionDisplayValue(exifSection, 0x9012)) ||
        dateTimeWithOffset(sectionDisplayValue(imageSection, 0x0132), sectionDisplayValue(exifSection, 0x9010));
      if (capturedAt) {
        summary.capture = {
          display: capturedAt,
        };
      }

      const exposureDisplay = joinParts([
        sectionDisplayValue(exifSection, 0x829a) || sectionDisplayValue(exifSection, 0x9201),
        sectionDisplayValue(exifSection, 0x829d) || sectionDisplayValue(exifSection, 0x9202),
        sectionDisplayValue(exifSection, 0x8827) ||
          sectionDisplayValue(exifSection, 0x8831) ||
          sectionDisplayValue(exifSection, 0x8832) ||
          sectionDisplayValue(exifSection, 0x8833),
        sectionDisplayValue(exifSection, 0x920a),
        sectionDisplayValue(exifSection, 0xa405)
          ? `35mm equiv ${sectionDisplayValue(exifSection, 0xa405)}`
          : null,
      ]);
      if (exposureDisplay) {
        summary.exposure = {
          display: exposureDisplay,
        };
      }

      const imageSize =
        sectionDisplayValue(exifSection, 0xa002) && sectionDisplayValue(exifSection, 0xa003)
          ? `${sectionDisplayValue(exifSection, 0xa002)} × ${sectionDisplayValue(exifSection, 0xa003)}`
          : null;
      const orientation = sectionDisplayValue(imageSection, 0x0112);
      if (imageSize || orientation) {
        summary.image = {
          size: imageSize,
          orientation,
        };
      }

      const software = sectionDisplayValue(imageSection, 0x0131);
      if (software) {
        summary.software = {
          display: software,
        };
      }

      if (gpsSection) {
        const latitudeRef = trimAscii(findSectionEntry(gpsSection, 0x0001)?.rawValue);
        const longitudeRef = trimAscii(findSectionEntry(gpsSection, 0x0003)?.rawValue);
        const latitude = gpsCoordinateDecimal(findSectionEntry(gpsSection, 0x0002)?.rawValue, latitudeRef);
        const longitude = gpsCoordinateDecimal(findSectionEntry(gpsSection, 0x0004)?.rawValue, longitudeRef);
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          const altitudeRef = findSectionEntry(gpsSection, 0x0005)?.rawValue;
          const altitudeValue = rationalValue(findSectionEntry(gpsSection, 0x0006)?.rawValue);
          const gpsDate = sectionDisplayValue(gpsSection, 0x001d);
          const gpsTime = sectionDisplayValue(gpsSection, 0x0007);
          summary.gps = {
            latitude,
            longitude,
            timestamp: gpsDate && gpsTime ? `${gpsDate} ${gpsTime}` : gpsDate || gpsTime || null,
          };
          if (Number.isFinite(altitudeValue)) {
            summary.gps.altitude = altitudeRef === 1 ? -altitudeValue : altitudeValue;
          }
        }
      }
      return summary;
    }

    function flattenXmlNode(node, path, properties) {
      if (!node || node.nodeType !== 1) return;
      const currentPath = path ? `${path}/${node.nodeName}` : node.nodeName;
      if (node.attributes) {
        for (const attribute of Array.from(node.attributes)) {
          if (!/^xmlns(?::|$)/.test(attribute.name)) {
            properties.push({
              path: `${currentPath}@${attribute.name}`,
              value: attribute.value,
            });
          }
        }
      }
      const children = Array.from(node.childNodes || []);
      const elementChildren = children.filter((child) => child.nodeType === 1);
      const textValue = children
        .filter((child) => child.nodeType === 3 || child.nodeType === 4)
        .map((child) => String(child.nodeValue || '').trim())
        .filter(Boolean)
        .join(' ');
      if (textValue) {
        properties.push({
          path: currentPath,
          value: textValue,
        });
      }
      for (const child of elementChildren) {
        flattenXmlNode(child, currentPath, properties);
      }
    }

    function extractFlatXmlProperties(xml) {
      if (typeof DOMParser !== 'undefined') {
        try {
          const doc = new DOMParser().parseFromString(xml, 'application/xml');
          if (!doc.querySelector('parsererror') && doc.documentElement) {
            const properties = [];
            flattenXmlNode(doc.documentElement, '', properties);
            return properties;
          }
        } catch (_) {}
      }

      const properties = [];
      const attributeRegex = /<([A-Za-z_][\w:.-]*)([^>]*)>/g;
      let attributeMatch = attributeRegex.exec(xml);
      while (attributeMatch) {
        const [, tagName, attrText] = attributeMatch;
        const itemPath = tagName;
        const pairRegex = /([A-Za-z_][\w:.-]*)="([^"]*)"/g;
        let pairMatch = pairRegex.exec(attrText);
        while (pairMatch) {
          if (!/^xmlns(?::|$)/.test(pairMatch[1])) {
            properties.push({
              path: `${itemPath}@${pairMatch[1]}`,
              value: pairMatch[2],
            });
          }
          pairMatch = pairRegex.exec(attrText);
        }
        attributeMatch = attributeRegex.exec(xml);
      }

      const leafRegex = /<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>([^<]+)<\/\1>/g;
      let leafMatch = leafRegex.exec(xml);
      while (leafMatch) {
        const value = leafMatch[2].trim();
        if (value) {
          properties.push({
            path: leafMatch[1],
            value,
          });
        }
        leafMatch = leafRegex.exec(xml);
      }
      return properties;
    }

    function normalizeXmpXml(xml) {
      return String(xml || '')
        .replace(/^\uFEFF/, '')
        .replace(/<\?xpacket[\s\S]*?\?>/g, '')
        .trim();
    }

    function formatHexDump(bytes) {
      const lines = [];
      for (let offset = 0; offset < bytes.byteLength; offset += 16) {
        const slice = bytes.subarray(offset, offset + 16);
        const hex = Array.from(slice)
          .map((byte) => byte.toString(16).toUpperCase().padStart(2, '0'))
          .join(' ');
        const ascii = Array.from(slice)
          .map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.'))
          .join('');
        lines.push(`${offset.toString(16).toUpperCase().padStart(8, '0')}  ${hex.padEnd(47, ' ')}  |${ascii}|`);
      }
      return lines.join('\n');
    }

    function buildXmpData(packetBytesList) {
      if (!Array.isArray(packetBytesList) || packetBytesList.length === 0) {
        return {
          hasXmp: false,
          packetCount: 0,
          packets: [],
        };
      }
      return {
        hasXmp: true,
        packetCount: packetBytesList.length,
        packets: packetBytesList.map((packetBytes, index) => {
          const xml = normalizeXmpXml(decodeUtf8(packetBytes));
          return {
            label: `XMP packet ${index + 1}`,
            byteLength: packetBytes.byteLength,
            xml,
            hexDump: formatHexDump(packetBytes),
            properties: extractFlatXmlProperties(xml),
          };
        }),
      };
    }

    function findJpegXmpPackets(bytes) {
      const packets = [];
      let offset = 2;
      const prefix = 'http://ns.adobe.com/xap/1.0/\0';
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
          segmentLength > prefix.length + 2 &&
          segmentDataOffset + segmentLength - 2 <= bytes.byteLength &&
          readAscii(bytes, segmentDataOffset, prefix.length) === prefix
        ) {
          packets.push(bytes.slice(segmentDataOffset + prefix.length, segmentDataOffset + segmentLength - 2));
        }
        offset += segmentLength;
      }
      return packets;
    }

    function findPngXmpPackets(bytes) {
      const packets = [];
      let offset = 8;
      while (offset + 12 <= bytes.byteLength) {
        const length = readBigEndianUint32(bytes, offset);
        const type = readAscii(bytes, offset + 4, 4);
        const dataOffset = offset + 8;
        requireRange(bytes, dataOffset, length);
        if (type === 'iTXt') {
          const chunk = bytes.subarray(dataOffset, dataOffset + length);
          const keywordEnd = chunk.indexOf(0);
          if (keywordEnd > 0 && decodeUtf8(chunk.subarray(0, keywordEnd)) === 'XML:com.adobe.xmp') {
            let index = keywordEnd + 1;
            const compressionFlag = chunk[index];
            index += 2;
            if (compressionFlag === 0) {
              const languageEnd = chunk.indexOf(0, index);
              if (languageEnd >= 0) {
                index = languageEnd + 1;
                const translatedEnd = chunk.indexOf(0, index);
                if (translatedEnd >= 0) {
                  packets.push(chunk.slice(translatedEnd + 1));
                }
              }
            }
          }
        }
        offset += 12 + length;
      }
      return packets;
    }

    function findWebpXmpPackets(bytes) {
      const packets = [];
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
        if (chunkType === 'XMP ') {
          packets.push(bytes.slice(dataOffset, dataOffset + chunkLength));
        }
        offset += 8 + chunkLength + (chunkLength % 2);
      }
      return packets;
    }

    function parseTiff(bytes, tiffOffset, container, inheritedXmpPackets = []) {
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
      const xmpPackets = [...inheritedXmpPackets];

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
          if (groupId === 'ifd0' && tag === 0x02bc) {
            if (typeof rawValue === 'string') {
              xmpPackets.push(encodeUtf8(rawValue));
            } else if (rawValue instanceof Uint8Array) {
              xmpPackets.push(rawValue);
            } else if (Array.isArray(rawValue)) {
              xmpPackets.push(Uint8Array.from(rawValue));
            }
            continue;
          }
          if (groupId === 'exif' && tag === 0xa005) {
            pointers.interop = rawValue;
            continue;
          }
          if (isStructuralTag(groupId, tag)) continue;

          const name = tagName(groupId, tag);
          const title = tagTitle(groupId, tag, name);
          section.entries.push({
            group: groupId,
            tag,
            name,
            title,
            description: tagDescription(groupId, tag, title),
            rawValue,
            displayValue: formatValue(groupId, tag, rawValue),
          });
        }

        if (groupId === 'ifd0') {
          updateImageDisplay(section, rawByTag);
        } else if (groupId === 'exif') {
          updateExifDisplay(section, rawByTag);
        } else if (groupId === 'gps') {
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
        xmp: buildXmpData(xmpPackets),
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

      const xmpPackets =
        container === 'jpeg'
          ? findJpegXmpPackets(bytes)
          : container === 'png'
            ? findPngXmpPackets(bytes)
            : findWebpXmpPackets(bytes);

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
          xmp: buildXmpData(xmpPackets),
        };
      }

      return parseTiff(bytes, tiffOffset, container, xmpPackets);
    }

    return {
      parseExifMetadata,
    };
  }
);
