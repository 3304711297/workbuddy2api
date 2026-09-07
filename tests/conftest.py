"""让 tests/ 内的用例能直接 import 仓库根目录的 converter / desensitize 模块。"""

import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import converter  # noqa: E402  (需先插入 sys.path 再导入)


@pytest.fixture(autouse=True)
def _isolate_global_cred():
    """每个用例前后重置全局凭据，避免跨文件/跨用例的 CONFIG['cred'] 状态污染。

    背景：init_cred() 会写入 CONFIG['cred']，若不隔离，会把构造好的
    CredentialManager 泄漏给后续依赖 cred=None 的端点用例。
    """
    converter.CONFIG["cred"] = None
    yield
    converter.CONFIG["cred"] = None
