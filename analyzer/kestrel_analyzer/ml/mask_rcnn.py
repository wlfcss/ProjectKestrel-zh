import platform
import sys
import time
from collections import OrderedDict
from pathlib import Path

import cv2
import numpy as np
import torch
import torchvision.models.detection as detection_models
import torchvision.transforms as T

from ..config import MASK_RCNN_WEIGHTS_PATH, MODELS_DIR


def _is_apple_silicon():
    return sys.platform == "darwin" and platform.machine() == "arm64"


def _convert_backbone_to_coreml(backbone, cache_path):
    """Trace the FPN backbone and convert to CoreML for Neural Engine acceleration."""
    import coremltools as ct

    class _BackboneWrapper(torch.nn.Module):
        def __init__(self, b):
            super().__init__()
            self.backbone = b

        def forward(self, x):
            return tuple(self.backbone(x).values())

    wrapper = _BackboneWrapper(backbone)
    wrapper.eval()
    # Mask R-CNN's internal transform resizes to min=800 / max=1333.
    # For landscape 3:2 images this yields (800, 1216).
    trace_shape = (1, 3, 800, 1216)
    traced = torch.jit.trace(wrapper, torch.randn(trace_shape), strict=False)
    mlmodel = ct.convert(
        traced,
        inputs=[ct.TensorType(name="image", shape=trace_shape)],
        compute_units=ct.ComputeUnit.ALL,
        minimum_deployment_target=ct.target.macOS12,
    )
    mlmodel.save(str(cache_path))
    return mlmodel, trace_shape


class MaskRCNNWrapper:
    # Maximum long-edge size fed into the model.  Larger images are
    # downscaled before inference and results are mapped back to the
    # original resolution.  This dramatically reduces computation on
    # high-megapixel cameras (e.g. 45 MP Canon R5).
    _MAX_INFERENCE_SIZE = 1600

    # Reduce RPN proposals from the default 1000.  Bird photography
    # scenes rarely contain more than a handful of objects, so 256
    # proposals is more than sufficient and halves RPN+ROI time.
    _RPN_PROPOSALS = 256

    def __init__(self):
        self.COCO_INSTANCE_CATEGORY_NAMES = [
            "__background__", "person", "bicycle", "car", "motorcycle", "airplane", "bus",
            "train", "truck", "boat", "traffic light", "fire hydrant", "N/A", "stop sign",
            "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
            "elephant", "bear", "zebra", "giraffe", "N/A", "backpack", "umbrella", "N/A", "N/A",
            "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball",
            "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
            "bottle", "N/A", "wine glass", "cup", "fork", "knife", "spoon", "bowl",
            "banana", "apple", "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza",
            "donut", "cake", "chair", "couch", "potted plant", "bed", "N/A", "dining table",
            "N/A", "N/A", "toilet", "N/A", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone",
            "microwave", "oven", "toaster", "sink", "refrigerator", "N/A", "book",
            "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
        ]
        weights_path = Path(MASK_RCNN_WEIGHTS_PATH)
        if not weights_path.exists():
            raise FileNotFoundError(
                f"Mask R-CNN weights not found at: {weights_path}\n"
                "The weights file should be bundled with the application."
            )
        self._raise_if_lfs_pointer(weights_path)

        self.device = torch.device("cpu")
        self.model = detection_models.maskrcnn_resnet50_fpn_v2(weights=None)
        state_dict = self._load_state_dict(weights_path)
        self.model.load_state_dict(state_dict)
        self.model.eval()

        # Reduce proposals for faster RPN + ROI head
        self.model.rpn._pre_nms_top_n['testing'] = self._RPN_PROPOSALS
        self.model.rpn._post_nms_top_n['testing'] = self._RPN_PROPOSALS

        # Try to accelerate backbone with CoreML on Apple Silicon
        self._coreml_backbone = None
        self._coreml_shape = None
        self._backbone_feature_keys = None
        self._coreml_output_names = None
        if _is_apple_silicon():
            self._init_coreml_backbone()

        print(f"[mask_rcnn] Model loaded (coreml_backbone={'yes' if self._coreml_backbone else 'no'}, "
              f"proposals={self._RPN_PROPOSALS})")

    def _init_coreml_backbone(self):
        """Convert and cache the FPN backbone as a CoreML model."""
        cache_path = MODELS_DIR / "mask_rcnn_backbone.mlpackage"
        try:
            import coremltools as ct

            # Get feature keys and reference shapes from PyTorch backbone
            dummy = torch.randn(1, 3, 800, 1216)
            with torch.no_grad():
                ref_out = self.model.backbone(dummy)
            self._backbone_feature_keys = list(ref_out.keys())
            ref_shapes = {k: tuple(v.shape) for k, v in ref_out.items()}

            if cache_path.exists():
                mlmodel = ct.models.MLModel(str(cache_path), compute_units=ct.ComputeUnit.ALL)
                self._coreml_shape = (1, 3, 800, 1216)
            else:
                print("[mask_rcnn] Converting backbone to CoreML (one-time)...")
                mlmodel, self._coreml_shape = _convert_backbone_to_coreml(
                    self.model.backbone, cache_path
                )

            # Map CoreML output names to backbone feature keys by matching
            # tensor shapes, so we are robust to spec output reordering.
            warmup_input = np.zeros(self._coreml_shape, dtype=np.float32)
            cml_out = mlmodel.predict({"image": warmup_input})
            cml_shapes = {name: np.array(val).shape for name, val in cml_out.items()}

            key_to_cml_name = {}
            for fkey, fshape in ref_shapes.items():
                for cname, cshape in cml_shapes.items():
                    if cshape == fshape and cname not in key_to_cml_name.values():
                        key_to_cml_name[fkey] = cname
                        break
            if len(key_to_cml_name) != len(self._backbone_feature_keys):
                raise RuntimeError(
                    f"Could not match all backbone outputs: matched {key_to_cml_name}, "
                    f"expected keys {self._backbone_feature_keys}"
                )
            self._coreml_output_names = [key_to_cml_name[k] for k in self._backbone_feature_keys]
            self._coreml_backbone = mlmodel
        except Exception as exc:
            print(f"[mask_rcnn] CoreML backbone init failed, using PyTorch CPU: {exc}")
            self._coreml_backbone = None

    def _predict_with_coreml(self, img_tensor, image_data_shape):
        """Run inference using CoreML backbone + PyTorch RPN/ROI heads.

        Returns None if the transformed image doesn't fit the CoreML
        model's fixed input shape (e.g. portrait orientation), signalling
        the caller to fall back to pure PyTorch.
        """
        images, _ = self.model.transform([img_tensor], None)
        inp_np = images.tensors.numpy()

        # CoreML backbone was traced with a fixed shape.  If the
        # transformed tensor exceeds that shape on any spatial dimension
        # (e.g. portrait photos) we cannot use CoreML for this image.
        _, _, th, tw = inp_np.shape
        _, _, ch, cw = self._coreml_shape
        if th > ch or tw > cw:
            return None  # caller falls back to PyTorch

        # Pad smaller images to the fixed shape (common for slight
        # rounding differences).
        if th != ch or tw != cw:
            padded = np.zeros(self._coreml_shape, dtype=np.float32)
            padded[:, :, :th, :tw] = inp_np
            inp_np = padded

        cml_out = self._coreml_backbone.predict({"image": inp_np})
        features = OrderedDict()
        for key, cml_name in zip(self._backbone_feature_keys, self._coreml_output_names):
            features[key] = torch.from_numpy(np.array(cml_out[cml_name]))

        with torch.no_grad():
            proposals, _ = self.model.rpn(images, features)
            detections, _ = self.model.roi_heads(features, proposals, images.image_sizes)
            detections = self.model.transform.postprocess(
                detections, images.image_sizes, [image_data_shape]
            )

        return detections[0]

    @staticmethod
    def _load_state_dict(weights_path: Path):
        """Load bundled Mask R-CNN weights across PyTorch versions."""
        try:
            state = torch.load(weights_path, map_location="cpu", weights_only=True)
        except Exception as exc:
            message = str(exc)
            if "Weights only load failed" not in message and "weights_only" not in message:
                raise
            print(
                "[mask_rcnn] weights_only=True failed for bundled checkpoint; "
                "retrying with weights_only=False for backward compatibility."
            )
            state = torch.load(weights_path, map_location="cpu", weights_only=False)

        if isinstance(state, dict):
            if "state_dict" in state and isinstance(state["state_dict"], dict):
                state = state["state_dict"]
            elif "model_state_dict" in state and isinstance(state["model_state_dict"], dict):
                state = state["model_state_dict"]

        if not isinstance(state, dict):
            raise TypeError(
                f"Unsupported Mask R-CNN checkpoint format at {weights_path}: "
                f"expected dict, got {type(state).__name__}"
            )

        return state

    @staticmethod
    def _raise_if_lfs_pointer(weights_path: Path) -> None:
        """Fail fast when the bundled model file is still a Git LFS pointer."""
        try:
            with open(weights_path, "rb") as handle:
                prefix = handle.read(256)
        except OSError:
            return

        if prefix.startswith(b"version https://git-lfs.github.com/spec/v1"):
            raise RuntimeError(
                f"Mask R-CNN weights at {weights_path} are a Git LFS pointer, not the real model file.\n"
                "Please download the actual large model asset (about 186 MB) or run Git LFS pull so "
                "that analyzer/models/mask_rcnn_resnet50_fpn_v2.pth contains binary weights."
            )

    def get_prediction(self, image_data, threshold=0.75, mask_threshold=0.5):
        """Get predictions from the model.

        Args:
            image_data: Input image array (RGB).
            threshold: Detection confidence threshold (0.1-0.99).
            mask_threshold: Pixel confidence threshold for mask segmentation (0.5-0.95).
        """
        mask_threshold = max(0.5, min(0.95, float(mask_threshold)))
        orig_h, orig_w = image_data.shape[:2]

        # Downscale large images to _MAX_INFERENCE_SIZE for faster inference.
        scale = 1.0
        inp = image_data
        long_edge = max(orig_h, orig_w)
        if long_edge > self._MAX_INFERENCE_SIZE:
            scale = self._MAX_INFERENCE_SIZE / long_edge
            new_w = int(orig_w * scale)
            new_h = int(orig_h * scale)
            inp = cv2.resize(image_data, (new_w, new_h), interpolation=cv2.INTER_AREA)

        inp_h, inp_w = inp.shape[:2]

        for attempt in range(3):
            try:
                transform = T.Compose([T.ToTensor()])
                img = transform(inp)

                pred = None
                if self._coreml_backbone is not None:
                    pred = self._predict_with_coreml(img, (inp_h, inp_w))
                if pred is None:
                    with torch.no_grad():
                        pred = self.model([img.to(self.device)])[0]

                pred_score = list(pred["scores"].detach().cpu().numpy())
                if (np.array(pred_score) > threshold).sum() == 0:
                    return None, None, None, None
                pred_t = [pred_score.index(x) for x in pred_score if x > threshold][-1]
                masks = (pred["masks"] > mask_threshold).squeeze(1).detach().cpu().numpy()
                pred_class = [self.COCO_INSTANCE_CATEGORY_NAMES[i] for i in list(pred["labels"].cpu().numpy())]
                pred_boxes = [[(i[0], i[1]), (i[2], i[3])] for i in list(pred["boxes"].detach().cpu().numpy())]
                masks = masks[: pred_t + 1]
                pred_boxes = pred_boxes[: pred_t + 1]
                pred_class = pred_class[: pred_t + 1]
                pred_score = pred_score[: pred_t + 1]

                # Map results back to original resolution when downscaled.
                if scale < 1.0:
                    inv_scale = 1.0 / scale
                    pred_boxes = [
                        [(b[0][0] * inv_scale, b[0][1] * inv_scale),
                         (b[1][0] * inv_scale, b[1][1] * inv_scale)]
                        for b in pred_boxes
                    ]
                    upscaled = np.empty((len(masks), orig_h, orig_w), dtype=masks.dtype)
                    for mi in range(len(masks)):
                        upscaled[mi] = cv2.resize(
                            masks[mi].astype(np.uint8), (orig_w, orig_h),
                            interpolation=cv2.INTER_NEAREST,
                        ).astype(masks.dtype)
                    masks = upscaled

                return self.filter_overlapping_detections(masks, pred_boxes, pred_class, pred_score)
            except Exception as e:
                if attempt < 2:
                    # If CoreML fails, fall back to pure PyTorch
                    if self._coreml_backbone is not None:
                        print(f"[mask_rcnn] CoreML inference failed: {e}. Falling back to PyTorch CPU.")
                        self._coreml_backbone = None
                    else:
                        print(f"Prediction attempt {attempt + 1} failed: {e}. Retrying...")
                    time.sleep(0.1)
                else:
                    print("Error occurred while getting prediction after 3 attempts:", e)
        return [], [], [], []

    @staticmethod
    def _center_of_mass(mask):
        y, x = np.where(mask > 0)
        if len(y) == 0:
            h, w = mask.shape[:2]
            return (w // 2, h // 2)
        return (int(np.mean(x)), int(np.mean(y)))

    @staticmethod
    def _fsolve(func, xmin, xmax):
        x_min, x_max = xmin, xmax
        while x_max - x_min > 10:
            x_mid = (x_min + x_max) / 2
            if func(x_mid) < 0:
                x_min = x_mid
            else:
                x_max = x_mid
        return (x_min + x_max) / 2

    def _get_bounding_box(self, mask):
        center = self._center_of_mass(mask)

        def fraction_inside(center_of_mass, S):
            x_min = int(center_of_mass[0] - S / 2)
            x_max = int(center_of_mass[0] + S / 2)
            y_min = int(center_of_mass[1] - S / 2)
            y_max = int(center_of_mass[1] + S / 2)
            x_min2 = max(0, x_min)
            x_max2 = min(mask.shape[1], x_max)
            y_min2 = max(0, y_min)
            y_max2 = min(mask.shape[0], y_max)
            total = np.sum(mask)
            if total == 0:
                return 0.0
            return np.sum(mask[y_min2:y_max2, x_min2:x_max2]) / total

        S = self._fsolve(lambda S: fraction_inside(center, S) - 0.8, 10, 3000)
        S = int(S * 1 / 0.5)
        x_min = int(center[0] - S / 2)
        x_max = int(center[0] + S / 2)
        y_min = int(center[1] - S / 2)
        y_max = int(center[1] + S / 2)
        x_min = max(0, x_min)
        x_max = min(mask.shape[1], x_max)
        y_min = max(0, y_min)
        y_max = min(mask.shape[0], y_max)
        slx = x_max - x_min
        sly = y_max - y_min
        if slx > sly:
            center = (int((x_min + x_max) / 2), int((y_min + y_max) / 2))
            s_new = sly
        else:
            center = (int((x_min + x_max) / 2), int((y_min + y_max) / 2))
            s_new = slx
        x_min = int(center[0] - s_new / 2)
        x_max = int(center[0] + s_new / 2)
        y_min = int(center[1] - s_new / 2)
        y_max = int(center[1] + s_new / 2)
        return x_min, x_max, y_min, y_max

    @staticmethod
    def filter_overlapping_detections(masks, pred_boxes, pred_class, pred_score, iou_threshold=0.5):
        """Remove lower-confidence detections that overlap significantly with higher-confidence ones."""
        if masks is None or len(masks) == 0:
            return masks, pred_boxes, pred_class, pred_score

        n = len(pred_score)
        keep = [True] * n
        # Sort indices by score descending
        sorted_indices = sorted(range(n), key=lambda i: pred_score[i], reverse=True)

        for i_idx, i in enumerate(sorted_indices):
            if not keep[i]:
                continue
            for j in sorted_indices[i_idx + 1:]:
                if not keep[j]:
                    continue
                # Compute mask IoU
                intersection = np.logical_and(masks[i], masks[j]).sum()
                union = np.logical_or(masks[i], masks[j]).sum()
                if union > 0 and intersection / union > iou_threshold:
                    keep[j] = False

        indices = [i for i in range(n) if keep[i]]
        if not indices:
            return masks, pred_boxes, pred_class, pred_score

        return (
            masks[indices],
            [pred_boxes[i] for i in indices],
            [pred_class[i] for i in indices],
            [pred_score[i] for i in indices],
        )

    def get_square_crop(self, mask, img, resize=True):
        x_min, x_max, y_min, y_max = self._get_bounding_box(mask)
        crop = img[y_min:y_max, x_min:x_max]
        mask_crop = mask[y_min:y_max, x_min:x_max]
        if resize:
            crop = cv2.resize(crop, (1024, 1024))
            mask_crop = cv2.resize(mask_crop.astype(np.uint8), (1024, 1024))
        return crop, mask_crop

    @staticmethod
    def get_species_crop(box, img):
        xmin = int(box[0][0])
        ymin = int(box[0][1])
        xmax = int(box[1][0])
        ymax = int(box[1][1])
        return img[ymin:ymax, xmin:xmax]
