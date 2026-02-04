import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from kestrel_analyzer.pipeline import AnalysisPipeline
from kestrel_analyzer.logging_utils import get_log_path, log_event, log_exception


def parse_args():
    parser = argparse.ArgumentParser(description="Kestrel Analyzer CLI")
    parser.add_argument("folder", help="Folder with RAW/JPEG images")
    parser.add_argument("--gpu", dest="use_gpu", action="store_true", help="Use GPU (DirectML) for ONNX")
    parser.add_argument("--no-gpu", dest="use_gpu", action="store_false", help="Force CPU for ONNX")
    parser.set_defaults(use_gpu=True)
    return parser.parse_args()


def main():
    log_path = get_log_path(None)
    try:
        args = parse_args()
        log_path = get_log_path(args.folder)
        pipeline = AnalysisPipeline(use_gpu=args.use_gpu)

        def on_status(msg):
            print(msg)

        def on_progress(processed, total):
            print(f"\rProcessed {processed}/{total}", end="", flush=True)

        log_event(
            log_path,
            {
                "level": "info",
                "event": "cli_start",
                "folder": args.folder,
                "use_gpu": args.use_gpu,
            },
        )

        pipeline.process_folder(
            args.folder,
            callbacks={
                "on_status": on_status,
                "on_progress": on_progress,
            },
            analyzer_name="cli",
        )
        print()
    except Exception as e:
        log_exception(
            log_path,
            e,
            stage="startup",
            context={"analyzer": "cli"},
        )
        raise


if __name__ == "__main__":
    main()
