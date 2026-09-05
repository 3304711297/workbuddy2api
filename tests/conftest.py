"""让 tests/ 内的用例能直接 import 仓库根目录的 converter / desensitize 模块。"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
