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
 * `match` is the text to look for.
 *
 * NAMING ONE OF THESE IS TREATED AS SETTLING THE QUESTION. If a file's metadata
 * says Suno, it was made with Suno — hedging about whether someone might have
 * been describing the audio buries the clearest evidence a file can carry, and
 * it did exactly that on a real Suno export whose comment read
 * "made with suno; created=...; id=...".
 *
 * `commonWord: true` marks the handful of names that are also ordinary words —
 * "boomy" is what an engineer calls too much low end, "loudly" is an adverb,
 * "bark" is a dog, "jukebox" is a venue. Those four cannot carry that certainty
 * without inventing confident false positives, so they keep the graded
 * treatment: they need a dedicated software field, or an authorship phrase, or
 * a machine-written mark beside them. Every other name in this list speaks for
 * itself.
 */
export const TOOL_SIGNATURES = [
  // --- generative music
  { match: 'suno', name: 'Suno', kind: TOOL_KINDS.GENERATIVE_MUSIC },
  { match: 'udio', name: 'Udio', kind: TOOL_KINDS.GENERATIVE_MUSIC },
  { match: 'riffusion', name: 'Riffusion', kind: TOOL_KINDS.GENERATIVE_MUSIC },
  // "boomy" is what an engineer calls a mix with too much low end, so this one
  // name cannot carry the certainty the others do. See commonWord below.
  { match: 'boomy', name: 'Boomy', kind: TOOL_KINDS.GENERATIVE_MUSIC, commonWord: true },
  { match: 'soundraw', name: 'Soundraw', kind: TOOL_KINDS.GENERATIVE_MUSIC },
  { match: 'mubert', name: 'Mubert', kind: TOOL_KINDS.GENERATIVE_MUSIC },
  { match: 'aiva', name: 'AIVA', kind: TOOL_KINDS.GENERATIVE_MUSIC },
  { match: 'beatoven', name: 'Beatoven', kind: TOOL_KINDS.GENERATIVE_MUSIC },
  { match: 'loudly', name: 'Loudly', kind: TOOL_KINDS.GENERATIVE_MUSIC, commonWord: true },
  { match: 'stable audio', name: 'Stable Audio', kind: TOOL_KINDS.GENERATIVE_MUSIC },
  { match: 'stableaudio', name: 'Stable Audio', kind: TOOL_KINDS.GENERATIVE_MUSIC },

  // --- generative models and toolkits
  { match: 'musicgen', name: 'MusicGen', kind: TOOL_KINDS.GENERATIVE_MODEL },
  { match: 'audiocraft', name: 'AudioCraft', kind: TOOL_KINDS.GENERATIVE_MODEL },
  { match: 'audiogen', name: 'AudioGen', kind: TOOL_KINDS.GENERATIVE_MODEL },
  { match: 'audioldm', name: 'AudioLDM', kind: TOOL_KINDS.GENERATIVE_MODEL },
  { match: 'musiclm', name: 'MusicLM', kind: TOOL_KINDS.GENERATIVE_MODEL },
  { match: 'jukebox', name: 'Jukebox', kind: TOOL_KINDS.GENERATIVE_MODEL, commonWord: true },
  { match: 'bark', name: 'Bark', kind: TOOL_KINDS.GENERATIVE_MODEL, commonWord: true },

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

/**
 * Plain-language phrases that show up in comment and description fields when
 * something was generated. Weaker evidence than a tool name in an encoder
 * field — a comment can just as easily be *discussing* AI — so these are
 * weighted accordingly.
 */
/**
 * Phrases that turn naming a tool into CLAIMING it made the file.
 *
 * "Suno" in a comment might be someone describing what a track sounds like.
 * "made with suno" is not a description, it is an attribution — and the
 * difference is the whole distance between a coincidence and a record.
 */
export const AUTHORSHIP_PHRASES = [
  'made with', 'made using', 'made by', 'created with', 'created using',
  'created by', 'generated with', 'generated by', 'produced with',
  'produced by', 'written with', 'composed with', 'rendered with',
  'powered by',
];

/**
 * Marks of a record written by software rather than typed by a person.
 *
 * A human describing a track does not append an ISO timestamp and a UUID.
 * Finding either one beside a tool's name says the field was filled in
 * programmatically, which is what makes it evidence rather than chatter.
 */
export const MACHINE_WRITTEN_MARKS = [
  {
    // created=2026-04-20T22:19:02Z, date: 2026-04-20T22:19:02Z
    pattern: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    label: 'a machine-written timestamp',
  },
  {
    // id=808f7fb4-5aaa-490e-9c2c-fd2d4b446a57
    pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    label: 'a generation id',
  },
];

export const GENERATIVE_PHRASES = [
  { match: 'ai-generated', label: 'the text "AI-generated"', weight: 'moderate' },
  { match: 'ai generated', label: 'the text "AI generated"', weight: 'moderate' },
  { match: 'generated by ai', label: 'the text "generated by AI"', weight: 'moderate' },
  { match: 'generated with ai', label: 'the text "generated with AI"', weight: 'moderate' },
  { match: 'text-to-music', label: 'the text "text-to-music"', weight: 'moderate' },
  { match: 'text-to-speech', label: 'the text "text-to-speech"', weight: 'weak' },
  { match: 'text to speech', label: 'the text "text to speech"', weight: 'weak' },
  { match: 'synthetic voice', label: 'the text "synthetic voice"', weight: 'moderate' },
  { match: 'voice clone', label: 'the text "voice clone"', weight: 'moderate' },
  { match: 'prompt:', label: 'a "prompt:" field, which generators often record', weight: 'weak' },
  { match: 'generated audio', label: 'the text "generated audio"', weight: 'weak' },
];

/** Fields that describe a tool, as opposed to free-form comment text. */
export const DEDICATED_TOOL_FIELDS = new Set([
  'Encoder settings (ID3 TSSE)',
  'Encoded by (ID3 TENC)',
  'Encoder (MP4 ©too)',
  'Encoded by (MP4 ©enc)',
  'Encoder (Vorbis ENCODER)',
  'Encoder vendor',
  'Software (Vorbis)',
  'Software (INFO ISFT)',
  'CAF encoder',
  'LAME encoder',
  'Encoder',
]);

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}
