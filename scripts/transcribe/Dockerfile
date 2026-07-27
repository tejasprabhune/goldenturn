FROM pytorch/pytorch:2.2.2-cuda12.1-cudnn8-runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg git \
 && rm -rf /var/lib/apt/lists/*

# torch 2.2 is built against numpy 1.x; whisperx pulls matplotlib in through
# pyannote. Both are pinned here rather than discovered at runtime.
# Three-way pin. pyannote calls hf_hub_download(use_auth_token=...) which
# huggingface_hub dropped in 0.26; transformers >=4.47 imports is_offline_mode
# which 0.25 does not export; numpy 2 breaks torch 2.2. Changing any one of
# these without the others breaks the build.
RUN pip install --no-cache-dir \
      "numpy<2" \
      whisperx==3.3.1 \
      matplotlib \
      boto3 \
 && pip install --no-cache-dir --force-reinstall \
      "numpy<2" \
      "huggingface_hub==0.25.2" \
      "transformers==4.46.3"

# Fail the build, not a GPU job ten minutes later, if the import graph is broken.
COPY smoke.py ./
RUN python smoke.py

RUN pip check || echo "WARNING: pip check reported conflicts (see above)"

WORKDIR /app
COPY transcribe.py manifest.json ./

ENV MANIFEST=/app/manifest.json
ENV HF_HOME=/tmp/hf
CMD ["python", "transcribe.py"]
