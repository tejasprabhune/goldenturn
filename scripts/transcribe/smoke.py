"""Import-graph check run at build time so a broken image never reaches a GPU."""
import numpy
import torch
import whisperx
from whisperx.diarize import DiarizationPipeline

assert numpy.__version__.startswith("1."), f"numpy {numpy.__version__} breaks torch 2.2"
for fn in ("load_model", "load_align_model", "align", "assign_word_speakers", "load_audio"):
    assert hasattr(whisperx, fn), f"whisperx.{fn} missing"
assert DiarizationPipeline is not None
assert torch.from_numpy(numpy.zeros(4, dtype=numpy.float32)).sum().item() == 0.0
print(f"SMOKE OK numpy={numpy.__version__} torch={torch.__version__}")
