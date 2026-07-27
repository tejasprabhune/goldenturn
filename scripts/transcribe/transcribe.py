"""
Transcribes rounds with WhisperX: batched large-v3, forced alignment for word
timestamps, and pyannote diarization for speaker labels.

Word timestamps and speakers are what the speech fitter needs, so both are
required rather than nice-to-have.
"""
import json
import os
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
        if already_done(client, key):
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
                    result = whisperx.assign_word_speakers(diarize(audio), result)

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
