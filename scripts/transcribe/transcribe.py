"""
Transcribes rounds with WhisperX: batched large-v3, forced alignment for word
timestamps, and pyannote diarization for speaker labels.

Word timestamps and speakers are what the speech fitter needs, so both are
required rather than nice-to-have.
"""
import json
import os
import re
import sys
import tempfile
import time
import urllib.request

import compat  # noqa: F401  (patches huggingface_hub before pyannote binds it)
import boto3
import torch
import whisperx

BUCKET = "goldenturn-media"
MEDIA = "https://media.goldenturn.org"
MODEL = os.environ.get("MODEL", "large-v3")
BATCH = int(os.environ.get("BATCH_SIZE", "16"))
SHARD = int(os.environ.get("SHARD", "0"))
SHARD_COUNT = int(os.environ.get("SHARD_COUNT", "1"))
LIMIT = int(os.environ.get("LIMIT", "100000"))
HF_TOKEN = os.environ.get("HF_TOKEN")
# How many voices to expect.
#
# Left to itself pyannote decides, and on a recorded round it decides badly:
# on a policy round it gave one label twenty three minutes and spread the rest
# over nine more, which is four debaters merged into one and a lot of noise
# promoted to people. A round has four debaters and a judge, and saying so is
# the difference between speaker labels the fitter can use and labels it
# cannot.
MIN_SPEAKERS = int(os.environ.get("MIN_SPEAKERS", "3"))
MAX_SPEAKERS = int(os.environ.get("MAX_SPEAKERS", "6"))
# Cloudflare blocks urllib's default user agent with a 403, so every fetch
# against media.goldenturn.org must identify itself as something else.
USER_AGENT = "goldenturn-transcribe/1.0"


def s3():
    return boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['CLOUDFLARE_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["CLOUDFLARE_S3_KEY"],
        aws_secret_access_key=os.environ["CLOUDFLARE_S3_SECRET"],
        region_name="auto",
    )


def already_done(client, key):
    try:
        client.head_object(Bucket=BUCKET, Key=key)
        return True
    except Exception:
        return False


def load_shard():
    """Which rounds this replica should consider.

    SLUGS names them outright. Without it the list comes from the manifest
    baked into the image, which is fixed at build time and so cannot contain a
    round submitted since: those would never be transcribed however often the
    job ran. Anything named here that already has a transcript is skipped
    below, so passing a slug twice costs nothing.
    """
    explicit = [s for s in re.split(r"[\s,]+", os.environ.get("SLUGS", "")) if s]
    if explicit:
        print(f"SLUGS given: {len(explicit)} round(s), manifest ignored", flush=True)
        return explicit[:LIMIT]

    with open(os.environ.get("MANIFEST", "manifest.json")) as f:
        manifest = json.load(f)
    slugs = [m["slug"] for m in manifest]
    mine = [s for i, s in enumerate(slugs) if i % SHARD_COUNT == SHARD]
    return mine[:LIMIT]


def main():
    client = s3()
    todo = load_shard()
    print(f"shard {SHARD}/{SHARD_COUNT}: {len(todo)} candidate rounds", flush=True)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"
    print(f"device={device} gpu={torch.cuda.get_device_name(0) if device=='cuda' else 'n/a'}", flush=True)

    model = whisperx.load_model(MODEL, device, compute_type=compute_type, language="en")
    align_model, align_meta = whisperx.load_align_model(language_code="en", device=device)

    diarize = None
    if HF_TOKEN:
        try:
            from whisperx.diarize import DiarizationPipeline
        except ImportError:
            from whisperx import DiarizationPipeline
        diarize = DiarizationPipeline(use_auth_token=HF_TOKEN, device=device)
    else:
        print("WARNING: no HF_TOKEN, skipping diarization", flush=True)

    done = failed = skipped = 0
    for slug in todo:
        key = f"transcripts/{slug}.json"
        # FORCE is for changing how transcription is done: without it a round
        # keeps whatever it got the first time, and a fix to the settings could
        # never be applied to anything already processed.
        if not os.environ.get("FORCE") and already_done(client, key):
            skipped += 1
            continue

        started = time.time()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                path = os.path.join(tmp, "a.m4a")
                req = urllib.request.Request(
                    f"{MEDIA}/audio/{slug}.m4a",
                    headers={"User-Agent": USER_AGENT},
                )
                with urllib.request.urlopen(req, timeout=300) as r, open(path, "wb") as f:
                    while chunk := r.read(1 << 20):
                        f.write(chunk)
                audio = whisperx.load_audio(path)
                duration = len(audio) / 16000

                result = model.transcribe(audio, batch_size=BATCH, language="en")
                result = whisperx.align(
                    result["segments"], align_model, align_meta, audio, device,
                    return_char_alignments=False,
                )
                if diarize:
                    turns = diarize(
                        audio,
                        min_speakers=MIN_SPEAKERS,
                        max_speakers=MAX_SPEAKERS,
                    )
                    result = whisperx.assign_word_speakers(turns, result)

                payload = {
                    "slug": slug,
                    "model": MODEL,
                    "duration": duration,
                    "diarized": diarize is not None,
                    "segments": [
                        {
                            "start": s.get("start"),
                            "end": s.get("end"),
                            "text": (s.get("text") or "").strip(),
                            "speaker": s.get("speaker"),
                            "words": [
                                {"w": w.get("word"), "s": w.get("start"),
                                 "e": w.get("end"), "p": w.get("score"),
                                 "spk": w.get("speaker")}
                                for w in s.get("words", [])
                            ],
                        }
                        for s in result["segments"]
                    ],
                }
                client.put_object(
                    Bucket=BUCKET, Key=key,
                    Body=json.dumps(payload).encode(),
                    ContentType="application/json",
                )
            elapsed = time.time() - started
            done += 1
            print(f"ok {slug[:52]} {duration/60:.0f}min in {elapsed:.0f}s "
                  f"({duration/elapsed:.1f}x realtime)", flush=True)
        except Exception as e:
            failed += 1
            print(f"FAIL {slug[:52]} :: {type(e).__name__}: {str(e)[:200]}", flush=True)

    print(f"\ndone={done} skipped={skipped} failed={failed}", flush=True)
    sys.exit(1 if failed and not done else 0)


if __name__ == "__main__":
    main()
