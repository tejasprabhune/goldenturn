"""
Transcription on Modal.

Every fifteen minutes a small container asks the bucket which rounds have
audio and no transcript, and hands them to a GPU container that runs
transcribe.py as it is. Nothing outside Modal has to start it: the ingest
puts the audio in the bucket, and a later ingest run finds the transcript
there and fits the speeches.

Deployed by .github/workflows/transcribe-deploy.yml, which also copies the
storage key and the Hugging Face token into the Modal secret named below.
"""
import os
import subprocess
import sys
import time
from pathlib import Path

import modal

HERE = Path(__file__).parent
BUCKET = "goldenturn-media"

# One container takes this many rounds, and this many containers may run at
# once. Together they bound what a single sweep can spend.
PER_CONTAINER = 6
MAX_CONTAINERS = 4
# A container may run this long. Until it has passed, a round handed out is
# taken to be with a container still, and is not handed out again.
GPU_TIMEOUT_S = 3 * 3600
# A round whose transcription has failed this often is left alone until
# someone runs `retry`. Without a limit, one unreadable file would be put on a
# GPU every fifteen minutes for good.
MAX_ATTEMPTS = 3

app = modal.App("goldenturn-transcribe")
secret = modal.Secret.from_name("goldenturn-transcribe")
state = modal.Dict.from_name("goldenturn-transcribe-state", create_if_missing=True)
# The models are several gigabytes. Kept here, they are fetched once and not
# on every cold start.
cache = modal.Volume.from_name("goldenturn-transcribe-cache", create_if_missing=True)

# The same versions as the Dockerfile beside this file, for the same reasons.
gpu_image = (
    modal.Image.from_registry("pytorch/pytorch:2.2.2-cuda12.1-cudnn8-runtime")
    .apt_install("ffmpeg", "git")
    .run_commands(
        "pip install --no-cache-dir whisperx==3.3.1 matplotlib boto3",
        'pip install --no-cache-dir --force-reinstall "numpy<2" '
        '"huggingface_hub==0.33.4" "transformers==4.46.3"',
    )
    .add_local_file(HERE / "compat.py", "/app/compat.py")
    .add_local_file(HERE / "transcribe.py", "/app/transcribe.py")
    .add_local_file(HERE / "manifest.json", "/app/manifest.json")
)
sweep_image = modal.Image.debian_slim().pip_install("boto3")


def bucket():
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['CLOUDFLARE_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["CLOUDFLARE_S3_KEY"],
        aws_secret_access_key=os.environ["CLOUDFLARE_S3_SECRET"],
        region_name="auto",
    )


def slugs_under(client, prefix, suffix):
    found = set()
    pages = client.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=prefix)
    for page in pages:
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if key.endswith(suffix):
                found.add(key[len(prefix):-len(suffix)])
    return found


def seen(slug):
    try:
        return state[slug]
    except KeyError:
        return {"handed": 0, "attempts": 0}


@app.function(image=sweep_image, secrets=[secret], schedule=modal.Period(minutes=15), timeout=300)
def sweep():
    client = bucket()
    audio = slugs_under(client, "audio/", ".m4a")
    peaks = slugs_under(client, "peaks/", ".json")
    transcripts = slugs_under(client, "transcripts/", ".json")
    owed = sorted(s for s in audio & peaks if s not in transcripts)

    now = time.time()
    ready, busy, given_up = [], [], []
    for slug in owed:
        record = seen(slug)
        if now - record["handed"] < GPU_TIMEOUT_S + 600:
            busy.append(slug)
        elif record["attempts"] >= MAX_ATTEMPTS:
            given_up.append(slug)
        else:
            ready.append(slug)

    ready = ready[: PER_CONTAINER * MAX_CONTAINERS]
    for i in range(0, len(ready), PER_CONTAINER):
        batch = ready[i : i + PER_CONTAINER]
        for slug in batch:
            state[slug] = {"handed": now, "attempts": seen(slug)["attempts"] + 1}
        transcribe.spawn(batch)

    print(f"owed {len(owed)}: handed out {len(ready)}, with a container {len(busy)}, "
          f"given up on {len(given_up)}", flush=True)
    if given_up:
        print("given up on: " + " ".join(given_up), flush=True)


@app.function(
    image=gpu_image,
    gpu="T4",
    # Modal counts physical cores, so this is the eight vCPUs the Azure jobs had.
    cpu=4,
    memory=16384,
    timeout=GPU_TIMEOUT_S,
    secrets=[secret],
    volumes={"/cache": cache},
    max_containers=MAX_CONTAINERS,
)
def transcribe(slugs: list[str]):
    env = dict(
        os.environ,
        SLUGS=" ".join(slugs),
        MANIFEST="/app/manifest.json",
        HF_HOME="/cache/hf",
        TORCH_HOME="/cache/torch",
    )
    run = subprocess.run([sys.executable, "transcribe.py"], cwd="/app", env=env)

    # Asked of the bucket, since the script can finish some rounds and fail
    # others. A round that got its transcript is forgotten; one that did not
    # may be handed out again, with the attempt it has used still counted.
    have = slugs_under(bucket(), "transcripts/", ".json")
    missed = [s for s in slugs if s not in have]
    for slug in slugs:
        if slug in have:
            state.pop(slug, None)
        else:
            state[slug] = {"handed": 0, "attempts": seen(slug)["attempts"]}
    print(f"transcribed {len(slugs) - len(missed)} of {len(slugs)}", flush=True)
    if missed:
        raise RuntimeError(f"no transcript for: {' '.join(missed)} (exit {run.returncode})")


@app.function(image=sweep_image)
def retry(slug: str):
    """Lets a round that was given up on be tried again: modal run modal_app.py::retry --slug SLUG"""
    state.pop(slug, None)
    print(f"{slug} will be handed out by the next sweep", flush=True)
