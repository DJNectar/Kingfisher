/**
 * The help tab.
 *
 * Written for a working audio producer, not a developer: plain language, no
 * jargon that is not immediately explained, and every instruction phrased as
 * something you do rather than something the app has.
 *
 * Built with DOM helpers rather than a big innerHTML blob so it obeys the same
 * escaping rules as everything else, and so the browser-specific paragraphs can
 * be switched on the actual capabilities of the browser it is running in.
 */

import { el } from '../dom.js';
import { capabilities } from '../../store/persistence.js';

export function renderHelp(host) {
  const caps = capabilities();
  const chrome = caps.savesInPlace;

  host.append(
    el('div', { class: 'help' }, [
      el('h2', { text: 'How to use Kingfisher' }),
      el('p', {
        text: 'Kingfisher opens an audio file, reads what is inside it, and tells you. It reports the facts — sample rate, bit depth, channels, duration, whatever metadata the file carries, and measured levels. It does not compare your file to any target or tell you what it should have been. That judgement is yours.',
      }),
      el('div', { class: 'callout' }, [
        el('strong', { text: 'Your files are never changed. ' }),
        'Kingfisher opens files read-only. It never plays, converts, renames, moves or writes to your audio. Nothing is uploaded — there is no server, no account, and it works with the Wi-Fi off.',
      ]),

      toc([
        ['what-it-tells-you', 'What it tells you'],
        ['provenance', 'Where a file came from'],
        ['checking', 'Checking a file or folder'],
        ['reading', 'Reading the results'],
        ['tempo', 'Tempo'],
        ['clients', 'Clients and projects'],
        ['todo', 'The to-do list'],
        ['saving', 'Saving your work'],
        ['exporting', 'Exporting a report'],
        ['browser', 'Chrome vs Safari'],
        ['trouble', 'When something looks wrong'],
      ]),

      // ------------------------------------------------------------------
      h3('what-it-tells-you', 'What it tells you'),
      el('p', { text: 'For every file Kingfisher can read, you get:' }),
      ul([
        'Sample rate, bit depth, channel count and duration.',
        'The format inside the file (regular PCM, floating point, and whether it is a plain WAV or the RF64/BW64 kind used for files over 4GB).',
        'The channel layout — which speaker each channel is meant for, when the file says so. When it does not say, Kingfisher tells you it is assuming the usual order rather than pretending to know.',
        'Embedded metadata: the Broadcast Wave (bext) description, originator, date and timecode; iXML from field recorders including scene, take and track names; and the older INFO tags like title and artist.',
        'Measured levels: peak and RMS for the file and for each channel, where the loudest moment is, and whether any channel is silent.',
        'A full list of every chunk in the file, including the ones Kingfisher does not decode — so you can see that nothing is being hidden from you.',
      ]),
      el('h4', { text: 'Which files it reads' }),
      ul([
        el('span', {}, [el('strong', { text: 'WAV' }), ' — including BWF, RF64 and BW64 for files over 4GB.']),
        el('span', {}, [el('strong', { text: 'AIFF and AIFF-C' }), ' — the Mac standard, including the little-endian "sowt" variant most Mac software writes.']),
        el('span', {}, [el('strong', { text: 'M4A and MP4' }), ' — AAC, and Apple Lossless (ALAC).']),
        el('span', {}, [el('strong', { text: 'MP3' }), ' — every MPEG version and layer, with tags.']),
        el('span', {}, [el('strong', { text: 'FLAC' }), ' — including the checksum that lets a file be verified.']),
        el('span', {}, [el('strong', { text: 'CAF' }), " — Apple's Core Audio Format, which Logic writes for long recordings."]),
        el('span', {}, [el('strong', { text: 'Ogg' }), ' — Vorbis, Opus and FLAC-in-Ogg.']),
      ]),
      el('p', { class: 'muted', text: 'Kingfisher identifies a file by looking inside it, not by its name. A file someone renamed to .wav that is really an MP3 is read correctly, and the report tells you what it actually is. Anything it does not recognise is reported as unreadable rather than guessed at.' }),

      el('h4', { text: 'Compressed files: what you get and what you do not' }),
      el('p', { text: 'For MP3, AAC, Opus and Vorbis, Kingfisher reports everything the file states about itself — sample rate, channels, duration, bitrate, the codec and its settings, and all the tags. What it does not report is measured levels, because finding the peak of a compressed file means decoding the audio, which this app deliberately does not do. The report says "not measured" rather than leaving a gap.' }),
      el('div', { class: 'callout' }, [
        el('strong', { text: 'Bit depth is blank for MP3, AAC, Opus and Vorbis, and that is correct. ' }),
        'Those formats do not store audio as samples of a fixed width, so they have no bit depth at all. Tools that show "16-bit" for an MP3 are repeating a number from the container that means nothing. FLAC and ALAC are compressed but lossless, so they do have a real bit depth and it is shown.',
      ]),
      el('p', {}, [
        el('strong', { text: 'MP3 length. ' }),
        'Most tools work out an MP3\'s duration by dividing its size by its bitrate, which is only right for a constant-bitrate file and can be badly wrong for a variable one. Kingfisher counts the actual frames, so the length is exact even for a VBR file with no Xing header — the case that usually goes wrong.',
      ]),
      el('p', {}, [
        el('strong', { text: 'AAC length. ' }),
        'An AAC encoder adds a little silence at the start and end for technical reasons. Where the file records how much (most iTunes-encoded files do), Kingfisher shows both the container length and the true audio length underneath it.',
      ]),

      // ------------------------------------------------------------------
      h3('checking', 'Checking a file or folder'),
      ol([
        'Go to the Inspect tab.',
        'If you want the results kept in a project, choose that project in the “Log results to” box first. If you leave it on “Don\'t log”, the results are shown and then forgotten when you close the app.',
        'Click “Check a file…” to pick one or more files, or “Check a folder…” to do everything in a folder at once.',
        'You can also drag files or a folder straight onto the window.',
      ]),
      el('p', {
        text: chrome
          ? 'Checking a folder looks inside subfolders too. Files that are not audio are skipped and counted at the end, so you know nothing went missing.'
          : 'Checking a folder in this browser uses the standard file-picker, which will ask you to confirm access to the folder. Files that are not audio are skipped and counted at the end.',
      }),
      el('div', { class: 'callout' }, [
        el('strong', { text: 'Large files are fine. ' }),
        'Kingfisher reads a file in small pieces rather than loading the whole thing, so a multi-gigabyte recording will not choke it. For very large files it measures levels from evenly spaced sections rather than every sample, and says so on the report, so you always know what the numbers cover.',
      ]),

      // ------------------------------------------------------------------
      h3('reading', 'Reading the results'),
      el('h4', { text: 'The first thing to look at' }),
      el('p', { text: 'Every report starts by telling you whether the file could be read at all. Three answers are possible:' }),
      ul([
        el('span', {}, [el('strong', { text: 'Read in full' }), ' — everything in the file was understood.']),
        el('span', {}, [el('strong', { text: 'Partly read' }), ' — some of the file did not make sense. You still get everything that was readable, and anything Kingfisher could not work out is shown as a dash rather than a number.']),
        el('span', {}, [el('strong', { text: 'Could not be read' }), ' — no details are shown at all. This is deliberate: a wrong number is worse than a visible blank.']),
      ]),

      el('h4', { text: 'Observations' }),
      el('p', { text: 'Below the headline numbers, Kingfisher lists anything about the file worth pointing out. These are statements about the file, not a verdict on it. They come in three strengths:' }),
      ul([
        el('span', {}, [el('strong', { text: 'Needs a look' }), ' — something about the file itself looks damaged, empty or distorted: it is entirely silent, a channel is silent, peaks are flat-topped in the way clipped audio looks, or the file is shorter than its own header says.']),
        el('span', {}, [el('strong', { text: 'Worth noting' }), ' — unusual but not necessarily a problem: an uncommon sample rate, a very short file, a peak sitting right at the top of the scale, a DC offset, or header fields that disagree with each other.']),
        el('span', {}, [el('strong', { text: 'For information' }), ' — normal things worth knowing, like a 20-bit recording stored inside a 24-bit file.']),
      ]),
      el('div', { class: 'callout' }, [
        'None of these means your file is wrong. A 44,056 Hz sample rate gets pointed out because it is unusual and often a sign of a conversion — but if that is what you wanted, it is right. Kingfisher describes; you decide.',
      ]),

      el('h4', { text: 'What “flat-topped peaks” means' }),
      el('p', { text: 'When audio is pushed past the maximum a file can hold, the tops of the waves get cut off flat. Kingfisher counts how many samples sit at the absolute maximum value and how many of them run back to back. A long run of maximum-value samples is what clipped audio looks like from the inside. A single sample touching maximum is usually nothing; a run of dozens is not.' }),

      // ------------------------------------------------------------------
      h3('provenance', 'Where a file came from'),
      el('p', { text: 'Every report has an "Origin and provenance" section. It answers one question: what does this file say about how it was made? That is a narrower question than it sounds, and the difference matters.' }),

      el('h4', { text: 'The flag at the top' }),
      el('p', { text: 'The section leads with a plain answer and the reasons behind it, so you can check the reasoning rather than take it on trust. There are four possible headlines:' }),
      ul([
        el('span', {}, [el('strong', { text: '"This file declares that it was AI-generated"' }), ' — its own signed Content Credentials say so. This is the strongest signal available, because it is the file\'s own record rather than an inference.']),
        el('span', {}, [el('strong', { text: '"Possibly AI-generated"' }), ' — a field that records what software wrote the file names a generation tool, or the metadata says something like "AI-generated".']),
        el('span', {}, [el('strong', { text: '"Faint signs of AI generation"' }), ' — something turned up, but only in free text, where it might just as easily be describing the audio as recording what made it.']),
        el('span', {}, [el('strong', { text: '"No signs of AI generation were found"' }), ' — nothing turned up. Read the next paragraph before making anything of that.']),
      ]),
      el('p', { text: 'Generation and processing are kept apart. A file made by Suno gets the flag; a file that has been through a stem separator or an automated mastering service gets a separate note, because something was done to that recording rather than the recording being made by a machine.' }),

      el('h4', { text: 'Content Credentials' }),
      el('p', { text: 'Some files carry a signed provenance record — the C2PA standard, also called Content Credentials — listing what created the file and what has edited it since. Adobe, OpenAI, Microsoft and Google all write these. When one is present, Kingfisher says so and shows where it is.' }),
      el('div', { class: 'callout' }, [
        el('strong', { text: 'Kingfisher finds the record but does not verify it. ' }),
        'Checking that the signature is genuine and unaltered needs cryptography and a list of trusted signers, which this app does not do. So it reports that the file makes a provenance claim, not that the claim is true. A dedicated Content Credentials tool can confirm the rest.',
      ]),

      el('h4', { text: 'Tools named in the metadata' }),
      el('p', { text: 'Files often record what made them, in an encoder or software field. Kingfisher shows every such field it finds, and points out when one names a tool worth knowing about — a music or speech generator, a stem separator, an automated mastering service.' }),

      el('h4', { text: 'What this can and cannot tell you' }),
      el('p', {}, [
        el('strong', { text: 'Finding nothing tells you nothing. ' }),
        'This is the important one. Metadata comes off in the course of ordinary work — a bounce through your DAW, a re-encode, an upload to a service that rewrites tags. Most files you receive will have little or nothing here, and that is completely normal. An empty provenance section is not a clean bill of health, and Kingfisher will never present it as one.',
      ]),
      el('p', {}, [
        el('strong', { text: 'Finding something is a claim, not proof. ' }),
        'A tag is plain text. It can be left by the tool, copied from another file, or typed in by hand. "The encoder field says Suno" is a fact about the file; "this was generated" is a conclusion the file cannot establish on its own.',
      ]),
      el('p', {}, [
        el('strong', { text: 'Inaudible watermarks are invisible here. ' }),
        'Several generators mark their output with a watermark buried in the sound itself rather than in the metadata. Kingfisher reads files; it cannot detect those, and doing so needs the software of whoever applied them.',
      ]),
      el('p', { class: 'muted', text: 'In short: this section is a useful place to look, and never a verdict. It is here so you can see what a file claims, and decide for yourself what that is worth.' }),

      // ------------------------------------------------------------------
      // ------------------------------------------------------------------
      h3('tempo', 'Tempo'),
      el('p', { text: 'Every report carries a tempo, and it comes in two halves that are deliberately never mixed together.' }),
      ul([
        el('span', {}, [el('strong', { text: 'Stated' }), ' is what the file claims about itself \u2014 a number somebody typed into a tag, or that a loop library wrote into the file.']),
        el('span', {}, [el('strong', { text: 'Measured' }), ' is what the audio turned out to be when Kingfisher worked it out by listening.']),
      ]),
      el('p', { text: 'Neither corrects the other. If a file says 100 BPM and plays at 128, you see both numbers and the difference between them, because which one is right is not something this app can decide.' }),
      el('h4', { text: 'Why it says "estimated"' }),
      el('p', { text: 'Everything else in a report is read out of the file: the sample rate is written in the header, the peak is in the samples. A tempo is not in the file. It is worked out by arithmetic, and unlike a header field it can be wrong. So it always carries how confident it is, how precise it can be at that tempo, and what it could not establish.' }),
      el('h4', { text: 'Average, and range' }),
      el('p', { text: 'Music moves. A live band speeds up into a chorus and settles again, and a single number hides that. So the tempo is also measured in short sections through the piece, and where the movement is real you get a range \u2014 "150.6 BPM, moves between 146.4 and 157.7" \u2014 plus a table showing where it went.' }),
      el('p', { class: 'muted', text: 'A range is only shown when the movement is bigger than the method\u2019s own margin of error. A track cut to a click says "steady", rather than turning measurement wobble into a performance detail that was never there.' }),
      el('h4', { text: 'Half-time and double-time' }),
      el('p', { text: 'Any tempo can be counted at half or double its speed \u2014 150 felt as 75, or a slow tune at 70 counted as 140. Kingfisher shows the alternative only where a listener might genuinely count it the other way: above 140 BPM or below 80. In the middle it says nothing, because nobody is confused about whether 120 is really 60.' }),
      el('h4', { text: 'When there is no answer' }),
      el('p', { text: 'Ambient music, a rubato piano piece, spoken word, a field recording \u2014 plenty of audio has no steady pulse, and for those Kingfisher says so rather than producing a number. A tempo you cannot rely on is worse than no tempo at all, because a number invites you to act on it.' }),

      h3('clients', 'Clients and projects'),
      el('p', { text: 'Kingfisher keeps a record of your work in two levels:' }),
      ul([
        el('span', {}, [el('strong', { text: 'A client' }), ' is who the work is for — a band, a company, a person.']),
        el('span', {}, [el('strong', { text: 'A project' }), ' is one piece of work for that client — a single, an album, a session, an episode. A client can have as many projects as you like, built up over years.']),
      ]),
      el('h4', { text: 'Starting out' }),
      ol([
        'Go to the Projects tab and click “Add client”.',
        'Open the client and click “Add project”.',
        'From inside a project, click “Check files into this project” — that takes you to Inspect with the project already chosen for you.',
      ]),
      el('h4', { text: 'Filing an import' }),
      el('p', { text: 'Every time you check files, Kingfisher asks where the results should go before it reads anything. Filing is optional and the window opens on “Just this once” — a file someone has sent you to look at needs no project. If you do want it recorded, pick an existing project or start a new one, under an existing client or a brand new client named right there in the same window. The question is asked at the moment of import because that is when you know the answer; a setting chosen earlier and forgotten is how checks end up filed nowhere.' }),
      el('h4', { text: 'The project log' }),
      el('p', { text: 'Every file you check into a project is added to that project\'s log with the date and time, the technical details, and any observations that came up. The log is a record, not a snapshot: checking the same file again adds a new entry rather than replacing the old one, so you can see how a delivery changed between versions. Click any row to open the full report exactly as it was at the time.' }),
      el('h4', { text: 'Renaming and deleting' }),
      el('p', { text: 'Clients and projects can be renamed or deleted from their cards in the Projects tab. Deleting tells you exactly how much history goes with it before you confirm. Deleting from Kingfisher never touches your audio files — it only removes the record.' }),

      // ------------------------------------------------------------------
      h3('todo', 'The to-do list'),
      el('p', { text: 'Each project has its own to-do list, separate from the automatic file log. That is for you: “chase the missing take 4”, “ask about the room tone”, “send rough mixes Friday”. Type into the box at the bottom of the list and press Enter or click Add. Tick items off as you go; each one records when you added it and when you finished it. Items can be edited or deleted at any time.' }),
      el('p', { class: 'muted', text: 'The file log is written by Kingfisher and is a record of what happened. The to-do list is written by you. Neither one touches the other.' }),

      // ------------------------------------------------------------------
      h3('saving', 'Saving your work'),
      el('p', { text: 'All your clients, projects, logs and to-dos live in a single library file that you choose the location of. Put it in a folder, on a backup drive, or in Dropbox or iCloud Drive if you want to reach it from more than one machine. Nothing is stored anywhere else and nothing leaves your computer.' }),
      el('div', { class: 'callout' }, [
        el('strong', { text: 'Kingfisher does not save automatically. ' }),
        'When you have unsaved changes, an orange “Unsaved changes” badge appears at the top — click Save. Automatic saving was left out on purpose: a file being rewritten constantly on a synced drive is exactly how Dropbox and iCloud end up making duplicate “conflicted copy” files.',
      ]),
      el('p', { text: 'If you try to close the window with unsaved changes, your browser will ask you to confirm first.' }),
      el('h4', { text: 'Using it on two machines' }),
      el('p', { text: 'Keep the library file in a synced folder and open it on either machine. Save on one and let it sync before opening it on the other. If you edit in both places at once, the sync service will keep both versions as separate files rather than merging them — so finish on one machine before moving to the other.' }),

      // ------------------------------------------------------------------
      h3('exporting', 'Exporting a report'),
      el('p', { text: 'Anything you can see, you can export. Four options appear at the bottom of every report and history view:' }),
      ul([
        el('span', {}, [el('strong', { text: 'Copy text' }), ' — puts the whole report on the clipboard, ready to paste into an email.']),
        el('span', {}, [el('strong', { text: '.txt' }), ' — the same thing as a plain text file.']),
        el('span', {}, [el('strong', { text: '.csv' }), ' — a spreadsheet, one row per file. This is the one for checking a whole delivery: open it in Numbers or Excel and sort by whatever matters to you.']),
        el('span', {}, [el('strong', { text: '.pdf' }), ' — a tidy fixed-layout document for sending on to a client.']),
      ]),
      el('p', { text: 'The same four options work for a single file, for a whole folder you have just checked, for one project\'s history, and for a client\'s entire history across every project.' }),

      // ------------------------------------------------------------------
      h3('browser', 'Chrome vs Safari'),
      el('p', { text: 'Kingfisher works in both, but they differ in one important way, and it is worth knowing which one you are in.' }),
      el('h4', { text: 'Chrome (recommended)' }),
      el('p', { text: 'Chrome lets a web page save directly back to a file you chose. Save means save: same file, same place, no copies. Kingfisher also remembers which library you had open, so it can offer to reopen it next time with one click.' }),
      el('h4', { text: 'Safari' }),
      el('p', { text: 'Safari does not allow that. In Safari, saving downloads a new copy of your library to your Downloads folder, and it does not update the file you opened. To keep one library, move the downloaded file back over the old one yourself. Safari also cannot remember your library between visits, so you open it each time.' }),
      el('p', {
        class: 'muted',
        text: chrome
          ? 'You are currently in a browser that can save in place, so the Save button updates your library file directly.'
          : 'You are currently in a browser that cannot save in place, so the Save button will download a copy. The bar at the top of the window says so too.',
      }),

      el('h4', { text: 'Opening the app' }),
      el('p', {}, [
        'Kingfisher needs to be opened through a local web address rather than by double-clicking the file. Browsers block the file-picking features it depends on when a page is opened straight from disk. In the Terminal, go to the Kingfisher folder and run ',
        el('code', { text: 'python3 -m http.server 8181' }),
        ', then open ',
        el('code', { text: 'http://localhost:8181' }),
        ' in your browser. That server runs only on your own machine and nothing is published to the internet. There is a ',
        el('code', { text: 'start.command' }),
        ' file in the folder that does both steps for you if you double-click it.',
      ]),

      // ------------------------------------------------------------------
      h3('trouble', 'When something looks wrong'),
      el('h4', { text: '“This file could not be read”' }),
      el('p', { text: 'The file is not a WAV, or its header is damaged. Kingfisher shows the first few bytes it found so you can tell which. A file that has been renamed to .wav from something else is the usual cause.' }),
      el('h4', { text: '“Partly read” with a missing duration' }),
      el('p', { text: 'Usually a file whose header claims more audio than the file actually contains — a transfer that was interrupted, or a recorder that stopped unexpectedly. The report tells you how many bytes are missing. The duration shown describes the audio that is really there.' }),
      el('h4', { text: 'A dash instead of a number' }),
      el('p', { text: 'That means Kingfisher could not establish the value and refuses to guess. The reason is always in the read result at the top of the report.' }),
      el('h4', { text: 'The levels say a percentage of the file was measured' }),
      el('p', { text: 'The file was big enough that measuring every sample would have taken too long, so levels were measured from evenly spaced sections. A peak that only happens outside those sections would not have been seen. Everything else in the report — sample rate, duration, metadata — is read from the header and is exact regardless.' }),
      el('h4', { text: 'My library will not open' }),
      el('p', { text: 'Kingfisher checks that a file really is one of its libraries before opening it, and refuses a library saved by a newer version rather than risking losing the parts it does not understand. The message will say which of those happened.' }),

      el('p', { class: 'muted', style: 'margin-top:32px', text: 'Kingfisher is read-only by design. It has no playback, no conversion and no editing, and it never modifies an audio file.' }),
    ]),
  );
}

function h3(id, text) {
  return el('h3', { id, text });
}

function toc(items) {
  return el('div', { class: 'toc' }, items.map(([id, label]) => el('a', { href: `#${id}`, text: label })));
}

function ul(items) {
  return el('ul', {}, items.map((i) => el('li', {}, [i])));
}

function ol(items) {
  return el('ol', {}, items.map((i) => el('li', {}, [i])));
}
