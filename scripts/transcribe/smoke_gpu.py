"""Verifies the diarization pipeline can actually be built.

pyannote's Pipeline.from_pretrained returns None instead of raising, so a
successful import proves nothing. It also fails this way when a gated model's
terms are unaccepted, which the HF metadata API does NOT reveal: /api/models
returns 200 for gated repos regardless. Only fetching a file shows the truth.
"""
import os
import sys
import urllib.error
import urllib.request

import compat  # noqa: F401

# Every gated repo the 3.1 diarization pipeline pulls in.
REQUIRED = [
    "pyannote/speaker-diarization-3.1",
    "pyannote/segmentation-3.0",
    "pyannote/wespeaker-voxceleb-resnet34-LM",
]

token = os.environ.get("HF_TOKEN", "").strip()
if not token:
    print("SKIP diarization check: no HF_TOKEN build arg")
    sys.exit(0)

blocked = []
for repo in REQUIRED:
    for name in ("config.yaml", "config.json"):
        req = urllib.request.Request(
            f"https://huggingface.co/{repo}/resolve/main/{name}",
            headers={"Authorization": f"Bearer {token}"},
        )
        try:
            urllib.request.urlopen(req, timeout=30)
            break
        except urllib.error.HTTPError as e:
            if e.code == 404:
                continue
            blocked.append((repo, e.code))
            break
        except Exception:
            break

if blocked:
    print("DIARIZATION BLOCKED. Accept the model terms while signed in as the "
          "token owner, then rebuild:", file=sys.stderr)
    for repo, code in blocked:
        print(f"  HTTP {code}  https://huggingface.co/{repo}", file=sys.stderr)
    sys.exit(1)

from whisperx.diarize import DiarizationPipeline

pipe = DiarizationPipeline(use_auth_token=token, device="cpu")
assert pipe is not None and getattr(pipe, "model", None) is not None, (
    "pyannote returned None despite all gated repos being readable; a "
    "dependency is likely too new"
)
print(f"SMOKE GPU OK diarization pipeline built ({type(pipe.model).__name__})")
