FROM pytorch/pytorch:2.2.2-cuda12.1-cudnn8-runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg git \
 && rm -rf /var/lib/apt/lists/*

# torch 2.2 is built against numpy 1.x; whisperx pulls matplotlib in through
# pyannote. Both are pinned here rather than discovered at runtime.
RUN pip install --no-cache-dir \
      "numpy<2" \
      whisperx==3.3.1 \
      matplotlib \
      boto3 \
 && pip install --no-cache-dir --force-reinstall "numpy<2"

# Fail the build, not a GPU job ten minutes later, if the import graph is broken.
COPY smoke.py ./
RUN python smoke.py

RUN pip check || echo "WARNING: pip check reported conflicts (see above)"

WORKDIR /app
COPY transcribe.py manifest.json ./

ENV MANIFEST=/app/manifest.json
ENV HF_HOME=/tmp/hf
CMD ["python", "transcribe.py"]
