/**
 * Known tool signatures, for the provenance report.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT.
 *
 * This is a lookup table of strings that audio files sometimes carry in their
 * encoder, software or comment fields. Finding one means the file SAYS it was
 * made with that tool. It does not mean the file was, and not finding one means
 * nothing at all:
 *
 *   - Metadata strips trivially. One pass through a DAW, one re-encode, one
 *     upload to a service that rewrites tags, and it is gone.
 *   - Metadata is plain text and forges just as trivially.
 *   - Some generators write nothing identifying in the first place.
 *
 * So the app reports what the field says, names the tool, and stops there. It
 * does not conclude anything about how the audio was made. Every string here is
 * a claim by the file about itself.
 *
 * `kind` describes what the tool is, so the report can be specific rather than
 * lumping everything under one label.
 */

export const TOOL_KINDS = {
  GENERATIVE_MUSIC: 'a generative music service',
  GENERATIVE_SPEECH: 'a synthetic speech service',
  GENERATIVE_MODEL: 'a generative audio model',
  SEPARATION: 'an AI stem-separation or processing tool',
  MASTERING: 'an automated mastering service',
};

/**
 * Matched case-insensitively against encoder/software/comment fields.
 *
 * `match` is the text to look for. Kept deliberately specific: a bare "suno"
 * would also fire on a filename or a band called Suno, so the patterns favour
 * the forms these tools actually write.
 */
export const TOOL_SIGNATURES = [
  // --- generative music
  { match: 'suno', name: 'Suno', kind: TOOL_KINDS.GENERATIVE_MUSIC },
  { match: 'udio', name: 'Udio', kind: TOOL_KINDS.GENERATIVE_MUSIC },
  { match: 'riffusion', name: 'Riffusion', kind: TOOL_KINDS.GENERATIVE_MUSIC },
  { match: 'boomy', name: 'Boomy', kind: TOOL_KINDS.GENERATIVE_MUSIC },
  { match: 'soundraw', name: 'Soundraw', kind: TOOL_KINDS.GENERATIVE_MUSIC },
  { match: 'mubert', name: 'Mubert', kind: TOOL_KINDS.GENERATIVE_MUSIC },
  { match: 'aiva', name: 'AIVA', kind: TOOL_KINDS.GENERATIVE_MUSIC },
  { match: 'beatoven', name: 'Beatoven', kind: TOOL_KINDS.GENERATIVE_MUSIC },
  { match: 'loudly', name: 'Loudly', kind: TOOL_KINDS.GENERATIVE_MUSIC },
  { match: 'stable audio', name: 'Stable Audio', kind: TOOL_KINDS.GENERATIVE_MUSIC },
  { match: 'stableaudio', name: 'Stable Audio', kind: TOOL_KINDS.GENERATIVE_MUSIC },

  // --- generative models and toolkits
  { match: 'musicgen', name: 'MusicGen', kind: TOOL_KINDS.GENERATIVE_MODEL },
  { match: 'audiocraft', name: 'AudioCraft', kind: TOOL_KINDS.GENERATIVE_MODEL },
  { match: 'audiogen', name: 'AudioGen', kind: TOOL_KINDS.GENERATIVE_MODEL },
  { match: 'audioldm', name: 'AudioLDM', kind: TOOL_KINDS.GENERATIVE_MODEL },
  { match: 'musiclm', name: 'MusicLM', kind: TOOL_KINDS.GENERATIVE_MODEL },
  { match: 'jukebox', name: 'Jukebox', kind: TOOL_KINDS.GENERATIVE_MODEL },
  { match: 'bark', name: 'Bark', kind: TOOL_KINDS.GENERATIVE_MODEL },

  // --- synthetic speech
  { match: 'elevenlabs', name: 'ElevenLabs', kind: TOOL_KINDS.GENERATIVE_SPEECH },
  { match: 'eleven_', name: 'ElevenLabs', kind: TOOL_KINDS.GENERATIVE_SPEECH },
  { match: 'play.ht', name: 'PlayHT', kind: TOOL_KINDS.GENERATIVE_SPEECH },
  { match: 'playht', name: 'PlayHT', kind: TOOL_KINDS.GENERATIVE_SPEECH },
  { match: 'resemble.ai', name: 'Resemble AI', kind: TOOL_KINDS.GENERATIVE_SPEECH },
  { match: 'murf.ai', name: 'Murf', kind: TOOL_KINDS.GENERATIVE_SPEECH },
  { match: 'wellsaid', name: 'WellSaid', kind: TOOL_KINDS.GENERATIVE_SPEECH },
  { match: 'descript overdub', name: 'Descript Overdub', kind: TOOL_KINDS.GENERATIVE_SPEECH },
  { match: 'tortoise-tts', name: 'Tortoise TTS', kind: TOOL_KINDS.GENERATIVE_SPEECH },
  { match: 'coqui', name: 'Coqui TTS', kind: TOOL_KINDS.GENERATIVE_SPEECH },
  { match: 'openai-tts', name: 'OpenAI text-to-speech', kind: TOOL_KINDS.GENERATIVE_SPEECH },

  // --- AI-assisted processing, which is a different claim from "generated"
  { match: 'lalal.ai', name: 'LALAL.AI', kind: TOOL_KINDS.SEPARATION },
  { match: 'izotope rx', name: 'iZotope RX', kind: TOOL_KINDS.SEPARATION },
  { match: 'spleeter', name: 'Spleeter', kind: TOOL_KINDS.SEPARATION },
  { match: 'demucs', name: 'Demucs', kind: TOOL_KINDS.SEPARATION },
  { match: 'landr', name: 'LANDR', kind: TOOL_KINDS.MASTERING },
  { match: 'cloudbounce', name: 'CloudBounce', kind: TOOL_KINDS.MASTERING },
  { match: 'emastered', name: 'eMastered', kind: TOOL_KINDS.MASTERING },
];

/**
 * Metadata fields that describe what made the file, with a readable label.
 * Each entry says how to pull the value out of a finished report.
 */
export const ORIGIN_FIELDS = [
  // ID3 (MP3, and AIFF/WAV files that carry an ID3 chunk)
  { label: 'Encoder settings (ID3 TSSE)', get: (m) => m.id3v2?.frames?.TSSE?.value },
  { label: 'Encoded by (ID3 TENC)', get: (m) => m.id3v2?.frames?.TENC?.value },
  { label: 'Comment (ID3)', get: (m) => m.id3v2?.frames?.COMM?.value },
  { label: 'User text (ID3 TXXX)', get: (m) => m.id3v2?.frames?.TXXX?.value },
  { label: 'ID3v1 comment', get: (m) => m.id3v1?.comment },

  // MP4 / iTunes
  { label: 'Encoder (MP4 ©too)', get: (m) => m.itunes?.['©too']?.value },
  { label: 'Encoded by (MP4 ©enc)', get: (m) => m.itunes?.['©enc']?.value },
  { label: 'Comment (MP4)', get: (m) => m.itunes?.['©cmt']?.value },
  { label: 'Description (MP4)', get: (m) => m.itunes?.desc?.value },

  // Vorbis comments (FLAC, Ogg)
  { label: 'Encoder (Vorbis ENCODER)', get: (m) => first(m.vorbisComment?.tags?.ENCODER) },
  { label: 'Encoder vendor', get: (m) => m.vorbisComment?.vendor },
  { label: 'Software (Vorbis)', get: (m) => first(m.vorbisComment?.tags?.SOFTWARE) },
  { label: 'Comment (Vorbis)', get: (m) => first(m.vorbisComment?.tags?.COMMENT) },
  { label: 'Description (Vorbis)', get: (m) => first(m.vorbisComment?.tags?.DESCRIPTION) },

  // RIFF / WAV
  { label: 'Software (INFO ISFT)', get: (m) => m.info?.ISFT?.value },
  { label: 'Comment (INFO ICMT)', get: (m) => m.info?.ICMT?.value },
  { label: 'Technician (INFO ITCH)', get: (m) => m.info?.ITCH?.value },

  // Broadcast Wave
  { label: 'BWF originator', get: (m) => m.bext?.originator },
  { label: 'BWF coding history', get: (m) => m.bext?.codingHistory },
  { label: 'BWF description', get: (m) => m.bext?.description },

  // iXML
  { label: 'iXML note', get: (m) => m.ixml?.fields?.NOTE },

  // AIFF text chunks
  { label: 'AIFF annotation', get: (m) => m.iff?.annotation },

  // CAF
  { label: 'CAF encoder', get: (m) => m.cafInfo?.encoder ?? m.cafInfo?.['encoding application'] },

  // MP3 encoder tag
  { label: 'LAME encoder', get: (m) => m.lame?.encoder },

  // Whatever the format's own encoder field resolved to
  { label: 'Encoder', get: (m, report) => report.format.encoder },
];

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}
