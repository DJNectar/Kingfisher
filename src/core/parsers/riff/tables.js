/** Lookup tables for WAV/RIFF. Data only — no parsing logic lives here. */

/** wFormatTag values from mmreg.h. Only the ones worth naming in a report. */
export const FORMAT_TAGS = {
  0x0000: 'Unknown',
  0x0001: 'PCM (integer)',
  0x0002: 'Microsoft ADPCM',
  0x0003: 'IEEE float',
  0x0006: 'A-law',
  0x0007: 'mu-law',
  0x0011: 'IMA ADPCM',
  0x0031: 'GSM 6.10',
  0x0050: 'MPEG Layer 1/2',
  0x0055: 'MPEG Layer 3',
  0x0092: 'Dolby AC-3 (SPDIF)',
  0x2000: 'Dolby AC-3',
  0x2001: 'DTS',
  0xfffe: 'Extensible',
};

/**
 * WAVE_FORMAT_EXTENSIBLE carries the real format in a 16-byte GUID of the form
 * {0000XXXX-0000-0010-8000-00AA00389B71}, where XXXX is the classic format tag.
 * The tag occupies the first two bytes; the remaining fourteen are fixed. All
 * fourteen must be checked — a shorter comparison passes vendor GUIDs that
 * merely start the same way, and mis-names the codec.
 */
export const KSDATAFORMAT_SUFFIX = [
  0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];

/** dwChannelMask bit order, as defined for WAVE_FORMAT_EXTENSIBLE. */
export const CHANNEL_MASK_BITS = [
  ['FL', 'Front Left'],
  ['FR', 'Front Right'],
  ['FC', 'Front Centre'],
  ['LFE', 'Low Frequency'],
  ['BL', 'Back Left'],
  ['BR', 'Back Right'],
  ['FLC', 'Front Left of Centre'],
  ['FRC', 'Front Right of Centre'],
  ['BC', 'Back Centre'],
  ['SL', 'Side Left'],
  ['SR', 'Side Right'],
  ['TC', 'Top Centre'],
  ['TFL', 'Top Front Left'],
  ['TFC', 'Top Front Centre'],
  ['TFR', 'Top Front Right'],
  ['TBL', 'Top Back Left'],
  ['TBC', 'Top Back Centre'],
  ['TBR', 'Top Back Right'],
];

/**
 * Named layouts, keyed by channel mask. Used only to give a mask a friendly
 * name; an unrecognised mask is still reported bit by bit.
 */
export const NAMED_LAYOUTS = {
  0x0004: 'Mono',
  0x0003: 'Stereo',
  0x0033: 'Quad',
  0x0007: 'LCR',
  0x0603: '4.0 (front + sides)',
  0x003f: '5.1',
  0x060f: '5.1 (side)',
  0x013f: '6.1',
  0x063f: '7.1',
  0x00ff: '7.1 (wide, front centres)',
};

/**
 * When there is no channel mask, WAV convention assigns channels in this order
 * by count. Reported as "assumed", never as fact.
 */
export const IMPLIED_LAYOUTS = {
  1: ['FL'],
  2: ['FL', 'FR'],
  3: ['FL', 'FR', 'FC'],
  4: ['FL', 'FR', 'BL', 'BR'],
  6: ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'],
  8: ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'],
};

/** Sample rates in routine professional use. */
export const STANDARD_SAMPLE_RATES = [
  8000, 11025, 16000, 22050, 32000, 44100, 48000, 64000, 88200, 96000, 176400,
  192000, 352800, 384000,
];

/**
 * Rates that are not "standard" but are well understood, with the reason they
 * exist. Reported factually so the user can decide whether it was intended.
 */
export const EXPLAINED_SAMPLE_RATES = {
  47952: '0.1% pull-down of 48000 Hz (24 → 23.976 fps film transfer)',
  48048: '0.1% pull-up of 48000 Hz (23.976 → 24 fps film transfer)',
  44056: '0.1% pull-down of 44100 Hz (NTSC-rate transfer)',
  44144: '0.1% pull-up of 44100 Hz (NTSC-rate transfer)',
  47250: 'early Sony PCM-1610/1630 rate',
  37800: 'CD-ROM XA level B rate',
  4000: 'telephony/speech rate',
};

/** Bit depths a WAV can legitimately carry. */
export const STANDARD_BIT_DEPTHS = [8, 16, 20, 24, 32, 64];

/**
 * What each chunk is, for the "chunks found" table in the report. A chunk we
 * do not decode is still listed with its size so nothing is invisible.
 */
export const CHUNK_DESCRIPTIONS = {
  'fmt ': 'Format description (sample rate, bit depth, channels)',
  data: 'Audio sample data',
  fact: 'Sample count for non-PCM formats',
  bext: 'Broadcast Wave extension (BWF) — description, originator, timecode',
  iXML: 'iXML metadata — production/recorder metadata as XML',
  axml: 'ADM audio definition model metadata (XML)',
  chna: 'ADM channel assignment table',
  LIST: 'List container (INFO tags or associated data)',
  ds64: 'RF64/BW64 64-bit size table',
  cue: 'Cue point markers',
  'cue ': 'Cue point markers',
  plst: 'Playlist of cue points',
  smpl: 'Sampler loop points and root note',
  inst: 'Instrument tuning/velocity information',
  acid: 'ACID tempo/key metadata',
  'ID3 ': 'Embedded ID3 tag',
  id3: 'Embedded ID3 tag',
  _PMX: 'Adobe XMP metadata',
  JUNK: 'Padding/reserved space (often a placeholder for ds64)',
  PAD: 'Padding for data alignment',
  'PAD ': 'Padding for data alignment',
  FLLR: 'Filler for data alignment',
  minf: 'Sound Forge/Vegas peak or media information',
  regn: 'Region definitions',
  umid: 'Unique Material Identifier',
  levl: 'Peak envelope (waveform overview) data',
  'afsp': 'AFsp processing history',
  'CDif': 'Steinberg CD information',
  'DISP': 'Display/clipboard title',
  'SMED': 'Soundminer metadata',
};

/** LIST/INFO four-character tags and their human names. */
export const INFO_TAGS = {
  IARL: 'Archival Location',
  IART: 'Artist',
  ICMS: 'Commissioned',
  ICMT: 'Comment',
  ICOP: 'Copyright',
  ICRD: 'Creation Date',
  ICRP: 'Cropped',
  IDIM: 'Dimensions',
  IDPI: 'Dots Per Inch',
  IENG: 'Engineer',
  IGNR: 'Genre',
  IKEY: 'Keywords',
  ILGT: 'Lightness',
  IMED: 'Medium',
  INAM: 'Title',
  IPLT: 'Palette Setting',
  IPRD: 'Product/Album',
  ISBJ: 'Subject',
  ISFT: 'Software',
  ISHP: 'Sharpness',
  ISRC: 'Source',
  ISRF: 'Source Form',
  ITCH: 'Technician',
  ITRK: 'Track Number',
  IPRT: 'Part',
  TORG: 'Organisation',
  IBPM: 'Beats Per Minute',
  ICNT: 'Country',
  ILNG: 'Language',
  IMUS: 'Composer',
  IWRI: 'Written By',
};
