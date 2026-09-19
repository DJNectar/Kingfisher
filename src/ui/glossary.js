/**
 * Plain-language definitions for the terms a report uses.
 *
 * WHY. A report full of LUFS, dBTP, valid bits and Mixolydian is perfectly
 * readable to a mastering engineer and close to opaque to the person who hired
 * one. Both of them open this app. The terms stay — renaming "true peak" to
 * something friendlier would make the report useless to the people who need it
 * most — so the explanation sits beside the term instead, one click away and
 * out of the way until asked for.
 *
 * THE SAME RULE APPLIES HERE. These definitions say what a thing IS. They do
 * not say what it should be. This is the most tempting place in the whole app
 * to slip: everyone knows what number a streaming service wants, and writing it
 * here would be giving the app an opinion by the back door — in the one place a
 * reader is most likely to take it as authoritative, because they came here
 * precisely because they did not know. A test holds this file to the same
 * banned-language standard as the observation rules.
 *
 * HOW ENTRIES ARE FOUND. By the label already on screen, normalised. Nothing at
 * a call site has to name a term, so a row gains an explanation the moment one
 * is written for its label, and a label with no entry simply shows no icon.
 * That keeps the icons scarce by construction rather than by discipline.
 */

/**
 * @typedef {{title: string, lead: string, body: string[]}} Term
 *   `lead` is the one-sentence answer. `body` is the rest, for anyone who wants
 *   it. Splitting them keeps the popover scannable.
 */

/** @type {Record<string, Term>} */
export const GLOSSARY = {
  // ------------------------------------------------------------- format
  'sample rate': {
    title: 'Sample rate',
    lead: 'How many times per second the sound was measured.',
    body: [
      '44,100 Hz means the level of the audio was captured 44,100 times every second. A higher rate can describe higher frequencies, and needs more storage to do it.',
      'On its own it says nothing about how good a recording is. A careful 44.1 kHz recording and a careless 96 kHz one are still a careful recording and a careless one.',
    ],
  },
  'bit depth': {
    title: 'Bit depth',
    lead: 'How finely each of those measurements was recorded.',
    body: [
      '16-bit gives 65,536 possible values for each sample; 24-bit gives about 16.7 million. More depth means more distance between the quietest sound you want and the noise the format itself introduces, which is why recording and mixing usually happen at 24-bit even when the result is delivered at 16.',
      'Lossy formats such as MP3 and AAC have no bit depth at all — they do not store samples. Kingfisher leaves it blank for those rather than repeating the container’s stock number as though it meant something.',
    ],
  },
  bitrate: {
    title: 'Bitrate',
    lead: 'How many bits the file spends on each second of audio.',
    body: [
      'It applies to compressed formats, where it takes the place of bit depth as the measure of how much detail was kept.',
      '"CBR" means the rate stays the same all the way through. "VBR" means it varies, spending more on complicated passages and less on simple ones, which generally gets more quality out of the same file size.',
    ],
  },
  'channel layout': {
    title: 'Channel layout',
    lead: 'Which speaker each channel is meant to come out of.',
    body: [
      'Two channels are almost always left and right. Six could be 5.1 in more than one order, and getting the order wrong sends the centre channel — usually the dialogue — to a surround speaker.',
      'Where the file states its layout, Kingfisher reports what it states. Where it does not, Kingfisher says it is assuming the usual order rather than presenting a guess as a fact.',
    ],
  },
  'valid bits': {
    title: 'Valid bits',
    lead: 'How many of the stored bits actually carry audio.',
    body: [
      'A file can store 24-bit samples while only the top 20 bits hold anything, usually because that is what the converter produced. The stored depth and the meaningful depth are two different facts, and this is the second one.',
    ],
  },
  'block align': {
    title: 'Block align',
    lead: 'How many bytes one frame of audio occupies.',
    body: [
      'It is bit depth times channels, divided by eight. A structural field rather than a musical one — mainly useful when it disagrees with the rest of the header, which means whatever wrote the file was confused about its own format.',
    ],
  },
  'byte rate': {
    title: 'Byte rate',
    lead: 'How many bytes of audio the file claims to use per second.',
    body: [
      'It should follow from the sample rate, bit depth and channel count. When it does not, something wrote the header incorrectly, and Kingfisher says so rather than quietly trusting one number over the other.',
    ],
  },
  'sample format': {
    title: 'Sample format',
    lead: 'How the numbers in the file are physically stored.',
    body: [
      'How many bits each sample uses, whether the values are whole numbers or floating point, and which way round the bytes are written.',
      'Reading this wrongly does not fail loudly. It produces plausible-looking nonsense — a peak level that looks real and is not — so it is read out of the file rather than assumed from the extension.',
    ],
  },
  profile: {
    title: 'Profile',
    lead: 'Which variant of a codec the file uses.',
    body: [
      'AAC-LC and HE-AAC are both AAC and are decoded differently. The profile is what tells a player which of them it is holding.',
    ],
  },
  lossless: {
    title: 'Lossless',
    lead: 'Whether the compression throws any audio away.',
    body: [
      'FLAC and ALAC are lossless: decoding returns the original samples exactly, bit for bit. MP3, AAC and Opus are lossy — they discard detail in order to be small, and converting back to WAV later does not bring it back. It only makes a large file out of a small one.',
    ],
  },
  encoder: {
    title: 'Encoder',
    lead: 'The software that wrote the audio, where the file records it.',
    body: [
      'Many encoders leave their name and version behind. It is a useful trail when two files that should match do not, and like every tag it is a claim the file makes rather than something Kingfisher can confirm.',
    ],
  },
  'duration source': {
    title: 'Duration source',
    lead: 'Where the length of the file was worked out from.',
    body: [
      'A length counted from the audio data itself is worth more than one read out of a header field, because a header can survive a truncation that removed the audio it describes. Kingfisher says which it used.',
    ],
  },
  'duration exact': {
    title: 'Duration exact',
    lead: 'Whether the length divides evenly into whole samples.',
    body: [
      'An inexact duration means the file’s own numbers disagree slightly with each other. It is usually harmless and occasionally the first visible sign that something wrote the file badly.',
    ],
  },

  // ------------------------------------------------------------- levels
  levels: {
    title: 'Levels',
    lead: 'How loud the individual samples in this file are.',
    body: [
      'Peak, RMS and the rest are measured from the sample values themselves. They describe the numbers in the file.',
      'How loud the file SOUNDS is a different question, and the loudness section answers that one.',
    ],
  },
  peak: {
    title: 'Peak',
    lead: 'The single loudest sample in the file.',
    body: [
      'Measured in dBFS — decibels below full scale, where 0 dBFS is the largest value the format can store, and every normal reading is therefore negative.',
      'Peak tells you how close the file comes to that ceiling. It tells you very little about how loud the file sounds: two masters with identical peaks can be eight decibels apart to the ear.',
    ],
  },
  rms: {
    title: 'RMS',
    lead: 'The average level of the audio, weighted by energy.',
    body: [
      'Where peak reports one instant, RMS reports the sustained level across everything. Two files can share a peak and have very different RMS — one dense and constant, the other quiet with occasional hits.',
    ],
  },
  'dc offset': {
    title: 'DC offset',
    lead: 'A constant bias shifting the whole waveform off centre.',
    body: [
      'Usually introduced by a converter or a plugin. It is inaudible by itself but it consumes headroom in one direction, and it can produce clicks at edit points where two differently-offset regions meet.',
    ],
  },
  'samples at full scale': {
    title: 'Samples at full scale',
    lead: 'How many samples sit at the very top value the format can hold.',
    body: [
      'A handful is entirely ordinary. A great many, especially in long unbroken runs, is what clipped audio looks like from the inside.',
    ],
  },
  'longest full-scale run': {
    title: 'Longest full-scale run',
    lead: 'The longest unbroken string of samples stuck at the maximum.',
    body: [
      'One sample touching the top is nothing. Forty consecutive samples at the top means the crest of the waveform was cut flat, because there was nowhere higher for it to go.',
    ],
  },
  'measured from': {
    title: 'Measured from',
    lead: 'Whether the numbers came from the file’s own samples or from a decoder.',
    body: [
      'Uncompressed audio is read straight out of the file. Compressed audio has no samples until something decodes it, so the browser decodes it as part of checking the file.',
      'The distinction matters because two decoders can differ slightly, and because a lossy encoder can produce a file that overshoots full scale once decoded even though what went in did not. A reading always says which route it took.',
    ],
  },
  'frames measured': {
    title: 'Frames measured',
    lead: 'How much of the file was actually walked.',
    body: [
      'Very large files are sampled at intervals rather than read end to end, which keeps a twenty-gigabyte file from exhausting the browser. Where that happened, this says so, rather than presenting a partial reading as the whole truth.',
    ],
  },

  // ----------------------------------------------------------- loudness
  loudness: {
    title: 'Loudness',
    lead: 'How loud the file actually sounds, rather than how close it comes to the ceiling.',
    body: [
      'It is measured through a filter that approximates how human hearing weights different frequencies, which is why a bass-heavy master and a bright one can share a peak and still be several decibels apart to a listener.',
      'The unit is LUFS — Loudness Units relative to Full Scale. It is the measurement delivery specifications are written in, because it corresponds to what people hear in a way that peak does not.',
    ],
  },
  integrated: {
    title: 'Integrated loudness',
    lead: 'The loudness of the whole file, as one number, in LUFS.',
    body: [
      'Passages quiet enough to be silence or room tone are left out of the average before it is taken. That gating is what makes the number useful: without it, a track with a long fade-in measures partly as the quiet around the music rather than as the music.',
    ],
  },
  'loudness range': {
    title: 'Loudness range',
    lead: 'The distance between the loud parts and the quiet parts of the same piece.',
    body: [
      'Measured in LU. A heavily compressed master reads low because everything sits at a similar level; something dynamic reads high.',
      'It is taken at percentiles rather than from the extremes, so a single cymbal crash and a single fade-out do not define it. This is a description of the material, not a score for it.',
    ],
  },
  'true peak': {
    title: 'True peak',
    lead: 'Where the waveform actually goes between the samples.',
    body: [
      'Between any two samples the signal is a curve, not a straight line, and a converter reconstructs that curve when the file is played. The curve can rise above both of the samples it sits between.',
      'So a file whose every single sample is below full scale can still push playback above it. Nothing in the file’s stored values shows this — it has to be reconstructed to be seen, which is what Kingfisher does, at eight times the file’s own sample rate.',
      'Measured in dBTP: decibels relative to full scale, true peak.',
    ],
  },
  'sample peak': {
    title: 'Sample peak',
    lead: 'The loudest value actually stored in the file.',
    body: [
      'Shown next to true peak so the gap between the two is visible. That gap is the part of the signal that only exists once the file is played.',
    ],
  },
  'loudest 3 seconds': {
    title: 'Loudest 3 seconds',
    lead: 'The loudest any three-second stretch of the file measures.',
    body: [
      'Where integrated loudness averages everything, this finds the hottest sustained moment — usually a chorus or a climax.',
    ],
  },
  'loudest 400 ms': {
    title: 'Loudest 400 ms',
    lead: 'The same, over a much shorter window.',
    body: [
      'Short enough to follow the material closely and catch individual hits rather than whole passages.',
    ],
  },
  'blocks averaged': {
    title: 'Blocks averaged',
    lead: 'How much of the file counted towards the integrated figure.',
    body: [
      'Loudness is measured in short blocks, and blocks quiet enough to be silence are dropped before averaging. This says how many were used out of how many there were — a large gap means a lot of the file is quiet.',
    ],
  },

  // -------------------------------------------------------------- tempo
  tempo: {
    title: 'Tempo',
    lead: 'How fast the music is, in beats per minute.',
    body: [
      'Almost everything else in a report is read out of the file. A measured tempo is not: it is worked out by listening, using arithmetic on the audio, and unlike a header field it can be wrong.',
      'So it always arrives with how confident it is, how precisely it can be resolved, and what could not be established — and where nothing repeats regularly enough to mean anything, it says so instead of producing a number.',
    ],
  },
  'stated in the file': {
    title: 'Stated in the file',
    lead: 'A tempo somebody typed into a tag, or that a loop library wrote in.',
    body: [
      'It is a claim the file makes about itself, reported exactly as found. It is never checked against the audio and never corrected by it.',
    ],
  },
  'measured from the audio': {
    title: 'Measured from the audio',
    lead: 'What the audio turned out to be when Kingfisher worked it out.',
    body: [
      'Kept strictly apart from whatever the file states. Neither corrects the other, and where the two disagree both are shown — the tag may be wrong, or the performance may simply not be at the tempo it was written for. Which one is right is not something this app can settle.',
    ],
  },
  confidence: {
    title: 'Confidence',
    lead: 'How much to trust an estimate.',
    body: [
      'It comes from how clearly the evidence pointed one way. For tempo, that is how regularly the audio repeats and whether separate sections of it agree with each other. For key, it is how strongly the notes cluster onto a single scale.',
      'Low confidence is not a defect in the file. It usually means the music is doing something that resists being reduced to one number.',
    ],
  },
  precision: {
    title: 'Precision',
    lead: 'How finely this method can resolve a tempo at this speed.',
    body: [
      'A reading of 128 BPM with a precision of ±0.4 means the method genuinely cannot tell 128 from 128.3. Quoting more decimal places than that would be inventing detail.',
    ],
  },
  'through the piece': {
    title: 'Through the piece',
    lead: 'Whether the tempo moved as the music went on.',
    body: [
      'Music played by people drifts — a band leans into a chorus and settles again — and a single number hides that. So the tempo is measured in short sections as well as overall.',
      'A range is only reported where the movement is larger than the method’s own margin of error. A track cut to a click says "steady" instead of inventing a performance detail out of measurement noise.',
    ],
  },

  // ---------------------------------------------------------------- key
  key: {
    title: 'Key',
    lead: 'Which notes the music is built from, and which of them sounds like home.',
    body: [
      'Those are two separate questions, and Kingfisher answers them separately because the first is far more reliable than the second.',
      'Measured on a real recording, the note collection follows a transposition eight times out of ten; the tonal centre follows it once. The report is shaped around that, rather than presenting a single confident key name.',
    ],
  },
  'notes used': {
    title: 'Notes used',
    lead: 'The set of notes the music actually spends its time on.',
    body: [
      'This is the key signature, and it is the dependable half of the reading. It is also the half worth sorting a delivery by.',
    ],
  },
  'likely key': {
    title: 'Likely key',
    lead: 'Which note out of that set sounds like home.',
    body: [
      'Much weaker than the notes themselves. C major and A minor contain exactly the same seven notes, and so do G Mixolydian and D Dorian — telling them apart means judging which note the music rests on, which is a harder problem than finding the notes.',
      'It is offered as a best guess, and every key sharing the same notes is named beside it rather than quietly discarded.',
    ],
  },
  'or equally': {
    title: 'Or equally',
    lead: 'The other keys built from exactly these notes.',
    body: [
      'These are not alternatives that were considered and rejected. They are genuinely indistinguishable from the named key by note content alone, so they are listed rather than hidden.',
    ],
  },
  'how tonal': {
    title: 'How tonal',
    lead: 'How strongly the music sits on any scale at all.',
    body: [
      'Percussion, atonal writing and heavily processed sound barely cluster on a set of notes. Where that is true, a key name means very little, so how tonal the material is gets said out loud instead of being hidden behind a confident-looking answer.',
    ],
  },
  'pitched energy on those notes': {
    title: 'Pitched energy on those notes',
    lead: 'What share of the pitched sound in the file lands on the named notes.',
    body: [
      'Roughly 58% is what falls on any seven of the twelve notes purely by chance. A figure near that means the music is not really sitting on a scale, whatever name fits best. Much higher means it is.',
    ],
  },

  // -------------------------------------------------------- provenance
  'content credentials': {
    title: 'Content Credentials',
    lead: 'A signed record some software attaches describing how a file was made.',
    body: [
      'Also called C2PA. Kingfisher finds these and reports what they say.',
      'It does not verify the signature — that needs cryptography and a list of trusted issuers — so a manifest here is a claim the file carries, not proof of anything. Its absence proves even less: most files have never had one.',
    ],
  },

  // ---------------------------------------------------------- metadata
  'broadcast wave': {
    title: 'Broadcast Wave',
    lead: 'An extra block of production information inside a WAV file.',
    body: [
      'Carries the description, the originator, a timestamp and a timecode position, among other things. It is what makes a WAV usable on a film or television production, where a sound file has to line up with picture.',
    ],
  },
  timecode: {
    title: 'Timecode',
    lead: 'Where this recording sits on a production clock.',
    body: [
      'Stored so that a sound file can be lined up with picture, or with other sound recorded at the same moment on different machines.',
    ],
  },
  'audio md5': {
    title: 'Audio MD5',
    lead: 'A fingerprint of the decoded audio, stored inside FLAC files.',
    body: [
      'It lets a decoder confirm the audio came back out exactly as it went in. It covers the audio, not the file, so re-tagging a FLAC does not invalidate it.',
    ],
  },
};

/**
 * Normalise a label as it appears on screen into a glossary key.
 *
 * Parentheticals are dropped so that a heading which varies with the file
 * still finds its entry: "Levels (whole file measured)" and "Levels (8% of the
 * file sampled)" are both the same term.
 */
export function normaliseTerm(label) {
  return String(label ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[:?.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The entry for a label, or null when there is none.
 *
 * Returning null is the mechanism that keeps the icons scarce: a label with no
 * definition written for it simply does not get one, so the icons appear
 * exactly where somebody has taken the trouble to explain something.
 *
 * @param {string} label
 * @returns {Term|null}
 */
export function lookUpTerm(label) {
  return GLOSSARY[normaliseTerm(label)] ?? null;
}
