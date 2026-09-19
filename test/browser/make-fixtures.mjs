// Write real WAV files to disk so the browser test can pick them through a
// genuine file input, exactly as a user would.
//
// Run:  node test/browser/make-fixtures.mjs
import * as F from '../helpers/wav-fixtures.js';
import { clickTrack } from '../helpers/tempo-fixtures.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'audio');
mkdirSync(dir, { recursive: true });
const w = (name, bytes) => writeFileSync(`${dir}/${name}`, Buffer.from(bytes));
const sine = (amp = 0.5, freq = 440, rate = 48000) => (f) => Math.sin((2 * Math.PI * freq * f) / rate) * amp;

// A normal 24-bit stereo BWF with real metadata
w('01 riverbed.wav', F.riff([
  F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 24 }),
  F.bextChunk({
    description: 'SC 14 TK 3 — kitchen wide',
    originator: 'Sound Devices 833',
    originatorReference: 'USSD1833010120260915',
    originationDate: '2026-09-15', originationTime: '14:30:00',
    timeReference: 1728000000, version: 2, loudnessValue: -23,
    codingHistory: 'A=PCM,F=48000,W=24,M=stereo,T=Sound Devices 833\r\n',
  }),
  F.ixmlChunk('<?xml version="1.0"?><BWFXML><PROJECT>Blue Room Sessions</PROJECT><SCENE>14</SCENE><TAKE>3</TAKE><TRACK_LIST><TRACK><CHANNEL_INDEX>1</CHANNEL_INDEX><NAME>Boom</NAME></TRACK><TRACK><CHANNEL_INDEX>2</CHANNEL_INDEX><NAME>Lav 1</NAME></TRACK></TRACK_LIST></BWFXML>'),
  F.listInfoChunk({ INAM: 'Riverbed', IART: 'The Bandits', ISFT: 'Pro Tools 2026.3' }),
  F.chunk('data', F.pcmData({ frames: 48000 * 3, channels: 2, bitsPerSample: 24, gen: sine(0.5) })),
]));

// Clipped 16-bit
w('02 clipped.wav', F.riff([
  F.fmtChunk({ channels: 2, sampleRate: 44100, bitsPerSample: 16 }),
  F.chunk('data', F.pcmData({ frames: 44100, channels: 2, bitsPerSample: 16, gen: sine(2.0, 100, 44100) })),
]));

// Entirely silent
w('03 silent.wav', F.riff([
  F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 24 }),
  F.chunk('data', F.pcmData({ frames: 48000, channels: 2, bitsPerSample: 24, gen: () => 0 })),
]));

// 5.1 extensible with a silent LFE
w('04 surround.wav', F.riff([
  F.fmtChunk({ formatTag: 1, extensible: true, channels: 6, sampleRate: 48000, bitsPerSample: 24, channelMask: 0x3f }),
  F.chunk('data', F.pcmData({ frames: 48000, channels: 6, bitsPerSample: 24, gen: (f, c) => (c === 3 ? 0 : sine(0.4)(f)) })),
]));

// Odd sample rate (pull-down)
w('05 pulldown.wav', F.riff([
  F.fmtChunk({ channels: 2, sampleRate: 47952, bitsPerSample: 24 }),
  F.chunk('data', F.pcmData({ frames: 47952, channels: 2, bitsPerSample: 24, gen: sine(0.3) })),
]));

// Truncated
{
  const data = F.pcmData({ frames: 48000, channels: 2, bitsPerSample: 24, gen: sine(0.4) });
  w('06 truncated.wav', F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 24 }),
    F.dataChunkWithDeclaredSize(data.subarray(0, data.byteLength / 3), data.byteLength),
  ]));
}

// Not a WAV at all, despite the extension
w('07 not-audio.wav', new Uint8Array([0x4f, 0x67, 0x67, 0x53, ...new Array(1000).fill(0)]));

// RF64
{
  const data = F.pcmData({ frames: 24000, channels: 2, bitsPerSample: 24, gen: sine(0.6) });
  w('08 large-rf64.wav', F.riff([
    F.ds64Chunk({ riffSize: 0, dataSize: data.byteLength, sampleCount: 24000 }),
    F.fmtChunk({ channels: 2, sampleRate: 96000, bitsPerSample: 24 }),
    F.dataChunkWithDeclaredSize(data, 0xffffffff),
  ], { magic: 'RF64', sizeOverride: 0xffffffff }));
}

// --- provenance fixtures ---------------------------------------------------

// A C2PA manifest that DECLARES generative origin, in an MP4 uuid box. This is
// the strongest provenance signal the app can find, so it needs coverage.
{
  const declaration = new TextEncoder().encode(
    'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia'
    + '"claim_generator":"Suno/4.0"',
  );
  w('09 declared-ai.m4a', F.minimalM4a({
    extraTopLevel: [F.c2paUuidBox(F.concat(F.c2paManifestBytes({ extra: 0 }), declaration))],
  }));
}

// A generator named in an encoder field, plus a generative phrase in a real
// comment frame — the "possibly" tier rather than the "declares" one.
w('10 tool-tagged.mp3', F.mp3File({
  id3v2: F.id3v2TagWithRaw(
    [['TIT2', 'Midnight Drive'], ['TSSE', 'Suno v4']],
    [F.id3CommFrame('ai-generated, prompt: 80s synthwave night drive')],
  ),
  frames: Array.from({ length: 200 }, () => F.mp3Frame({})),
}));

// A real MP3 with nothing of the sort, for the "measure levels" path: MP3 is an
// open codec, so every browser can decode it.
w('11 plain.mp3', F.mp3File({
  id3v2: F.id3v2Tag([['TIT2', 'Ordinary Take'], ['TSSE', 'LAME3.100']]),
  frames: Array.from({ length: 400 }, () => F.mp3Frame({})),
}));

// A click track at exactly 128 BPM, for the tempo path. Uncompressed on
// purpose: an uncompressed file must get its tempo out of the sample scan that
// already happens, without ever being decoded.
{
  const rate = 44100;
  const click = clickTrack(128, 40, rate);
  w('12 click-128.wav', F.riff([
    F.fmtChunk({ sampleRate: rate, channels: 2, bitsPerSample: 24 }),
    F.listInfoChunk({ INAM: 'Click 128' }),
    F.chunk('data', F.pcmData({
      frames: click.length,
      channels: 2,
      bitsPerSample: 24,
      gen: (i) => click[i] * 0.5,
    })),
  ]));
}

// A file whose every sample sits below full scale while the waveform between
// them goes above it.
//
// purpose: this is the one level finding that cannot be reached by looking at
// sample values, so it is the one that proves the true-peak path is real and
// not just arithmetic on the peak already known. A sine at exactly a quarter
// of the sample rate, offset 45 degrees, puts every sample at 0.7071 of the
// amplitude and never once on the crest.
{
  const rate = 44100;
  const frames = rate * 4;
  // Samples land at -0.5 dBFS; the crest they straddle is about +2.5 dBTP.
  const amp = 10 ** (-0.5 / 20) / Math.SQRT1_2;
  w('13 intersample-over.wav', F.riff([
    F.fmtChunk({ sampleRate: rate, channels: 2, bitsPerSample: 24 }),
    F.listInfoChunk({ INAM: 'Inter-sample over' }),
    F.chunk('data', F.pcmData({
      frames,
      channels: 2,
      bitsPerSample: 24,
      gen: (i) => amp * Math.cos((Math.PI * i) / 2 + Math.PI / 4),
    })),
  ]));
}

// A non-audio file, to prove folder scans skip them
writeFileSync(`${dir}/notes.txt`, 'not audio');
console.log('fixtures written to', dir);
