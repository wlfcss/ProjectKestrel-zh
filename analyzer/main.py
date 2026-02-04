import sys

# Sequential ML dependency loading with retry logic
# This helps identify which modules are failing and in what order

import torch as t
import onnxruntime as ort
import tensorflow as tf


from gui_app import main
from kestrel_analyzer.logging_utils import get_log_path, log_event, log_exception


if __name__ == "__main__":
    log_path = get_log_path(None)
    try:
        log_event(
            log_path,
            {
                "level": "info",
                "event": "gui_start",
            },
        )
        main()
    except Exception as e:
        log_exception(
            log_path,
            e,
            stage="startup",
            context={"analyzer": "gui"},
        )
        raise
