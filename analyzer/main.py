"""兼容旧入口。

历史版本通过 ``python analyzer/main.py`` 启动 PyQt GUI，但原来的
``gui_app`` 模块已经不存在。为了保持旧命令仍可用，这里统一转发到
当前的可视化入口 ``visualizer.py``，并继续保留 ``--cli`` 模式。
"""

from __future__ import annotations

import sys


def _run_cli() -> None:
    from cli import main as cli_main

    cli_main()


def _run_visualizer() -> None:
    from visualizer import main as visualizer_main

    visualizer_main()


def main() -> None:
    if "--cli" in sys.argv:
        sys.argv = [arg for arg in sys.argv if arg != "--cli"]
        _run_cli()
        return

    _run_visualizer()


if __name__ == "__main__":
    main()
