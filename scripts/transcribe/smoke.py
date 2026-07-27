"""Build-time check that the import graph AND the call signatures line up.

Imports alone are not enough: pyannote calls hf_hub_download with a keyword
that newer huggingface_hub removed, which only surfaced on a GPU at runtime.
"""
import inspect

import compat  # must precede whisperx so the patch is in place

import numpy
import torch
import whisperx
from huggingface_hub import hf_hub_download
from whisperx.diarize import DiarizationPipeline

assert numpy.__version__.startswith("1."), f"numpy {numpy.__version__} breaks torch 2.2"
for fn in ("load_model", "load_align_model", "align", "assign_word_speakers", "load_audio"):
    assert hasattr(whisperx, fn), f"whisperx.{fn} missing"

# After the shim, the name pyannote passes must be accepted.
params = inspect.signature(hf_hub_download).parameters
assert "use_auth_token" in params or any(
    p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()
), "use_auth_token still unsupported; pyannote would fail at runtime"

assert "use_auth_token" in inspect.signature(DiarizationPipeline.__init__).parameters
assert torch.from_numpy(numpy.zeros(4, dtype=numpy.float32)).sum().item() == 0.0

import huggingface_hub
print(f"SMOKE OK compat={compat.STATUS} numpy={numpy.__version__} "
      f"torch={torch.__version__} hub={huggingface_hub.__version__}")
