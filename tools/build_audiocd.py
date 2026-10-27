"""Make an audio CD image from a folder of audio files, as a CD burner lays out a Red Book disc: each file a track of
44.1 kHz 16-bit stereo PCM in 2352-byte sectors (the last sector of a track padded with silence), the tracks one after
another from sector 0 (MSF 00:02:00, after the lead-in's 2-second pause). Writes OUT.bin (the sectors), OUT.cue (the
track sheet) and OUT.json (the table of contents the page and the CD drive read: album, performer, each track's title,
performer, first sector and length, and the lead-out). Files are taken in name order; titles and performers from their
tags. Usage: build_audiocd.py SRC_DIR OUT (OUT without extension, e.g. audiocd)"""
import json, os, subprocess, sys
src, out = sys.argv[1], sys.argv[2]
SECTOR = 2352
files = sorted(f for f in os.listdir(src) if f.lower().endswith(('.mp3', '.wav', '.flac', '.ogg', '.m4a')))
if not files: sys.exit(f'build_audiocd: no audio files in {src}')
tag = lambda f, k: subprocess.run(['ffprobe', '-v', 'error', '-show_entries', f'format_tags={k}', '-of', 'default=nw=1:nk=1', os.path.join(src, f)],
                                  capture_output=True, text=True).stdout.strip()
msf = lambda lba: (lba // 4500, lba // 75 % 60, lba % 75)   # (a cue sheet's times: from the file's start)
tracks, lba = [], 0
with open(out + '.bin', 'wb') as bin_:
    for i, f in enumerate(files, 1):
        pcm = subprocess.run(['ffmpeg', '-v', 'error', '-i', os.path.join(src, f), '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', '-'],
                             capture_output=True, check=True).stdout
        pcm += bytes(-len(pcm) % SECTOR)   # (a whole number of sectors: the last padded with silence)
        bin_.write(pcm)
        n = len(pcm) // SECTOR
        tracks.append({'number': i, 'title': tag(f, 'title') or os.path.splitext(f)[0], 'performer': tag(f, 'artist'), 'lba': lba, 'sectors': n})
        lba += n
album, performer = tag(files[0], 'album'), tag(files[0], 'artist')
with open(out + '.cue', 'w') as cue:
    cue.write(f'PERFORMER "{performer}"\nTITLE "{album}"\nFILE "{os.path.basename(out)}.bin" BINARY\n')
    for t in tracks:
        m, s, fr = msf(t['lba'])
        cue.write(f'  TRACK {t["number"]:02d} AUDIO\n    TITLE "{t["title"]}"\n    PERFORMER "{t["performer"]}"\n    INDEX 01 {m:02d}:{s:02d}:{fr:02d}\n')
json.dump({'album': album, 'performer': performer, 'tracks': tracks, 'leadout': lba, 'file': os.path.basename(out) + '.bin'}, open(out + '.json', 'w'), indent=1)
print(f'{len(tracks)} tracks, {lba} sectors ({lba // 4500}:{lba // 75 % 60:02d}), {lba * SECTOR} bytes')
