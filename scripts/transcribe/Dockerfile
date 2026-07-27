FROM pytorch/pytorch:2.2.2-cuda12.1-cudnn8-runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg git \
 && rm -rf /var/lib/apt/lists/*

# torch 2.2 is built against numpy 1.x; whisperx pulls matplotlib in through
# pyannote. Both are pinned here rather than discovered at runtime.
# Verified compatible set, all applied in one resolve so pip cannot drift:
#   numpy<2            - torch 2.2 is built against numpy 1.x
#   huggingface_hub    - 1.x is a major rewrite pyannote 3.1 predates
#   transformers       - 4.47+ imports is_offline_mode, which no hub 0.x exports
# The use_auth_token rename inside this range is handled by compat.py.
RUN pip install --no-cache-dir \
      whisperx==3.3.1 \
      matplotlib \
      boto3 \
 && pip install --no-cache-dir --force-reinstall \
      "numpy<2" \
      "huggingface_hub==0.33.4" \
      "transformers==4.46.3"

# Fail the build, not a GPU job ten minutes later, if the import graph is broken.
COPY compat.py smoke.py smoke_gpu.py ./
RUN python smoke.py

# Building the diarization pipeline for real is the only way to catch pyannote
# returning None, which it does silently when a dependency is too new.
ARG HF_TOKEN=""
ENV HF_HOME=/tmp/hf
RUN python smoke_gpu.py

RUN pip check || echo "WARNING: pip check reported conflicts (see above)"

WORKDIR /app
COPY compat.py transcribe.py manifest.json ./

ENV MANIFEST=/app/manifest.json
ENV HF_HOME=/tmp/hf
CMD ["python", "transcribe.py"]
