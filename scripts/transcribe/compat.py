"""Bridges the huggingface_hub rename that pyannote has not caught up with.

hf_hub_download's `use_auth_token` became `token`, but pyannote still passes the
old name. Pinning around it means pinning huggingface_hub, transformers and
pyannote in lockstep, which breaks on the next release of any of them. Patching
the kwarg is version independent.

Import this BEFORE whisperx or pyannote: they do `from huggingface_hub import
hf_hub_download`, which binds the name at import time.
"""
import inspect

import huggingface_hub


def _install() -> str:
    original = huggingface_hub.hf_hub_download
    params = inspect.signature(original).parameters
    if "use_auth_token" in params:
        return "native"

    def shim(*args, **kwargs):
        if "use_auth_token" in kwargs:
            token = kwargs.pop("use_auth_token")
            kwargs.setdefault("token", token)
        return original(*args, **kwargs)

    shim.__signature__ = inspect.Signature(
        list(params.values())
        + [inspect.Parameter("use_auth_token", inspect.Parameter.KEYWORD_ONLY, default=None)]
    )
    huggingface_hub.hf_hub_download = shim
    return "shimmed"


STATUS = _install()
