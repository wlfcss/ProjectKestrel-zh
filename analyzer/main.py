import sys

# Sequential ML dependency loading with retry logic
# This helps identify which modules are failing and in what order

import torch as t
import onnxruntime as ort
import tensorflow as tf


from gui_app import main


if __name__ == "__main__":
    main()
