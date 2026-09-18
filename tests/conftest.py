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


@pytest.fixture(autouse=True)
def _isolate_global_config():
    """每个用例结束后把 CONFIG 恢复成用例开始前的快照（兜底护栏）。

    为什么需要：`CONFIG` 是全局可变字典，直接 `converter.CONFIG["x"] = v` 而不还原
    会把开关泄漏给后续用例/**其他测试文件**，症状是「单独跑绿、全量跑红」或反之
    （顺序一变就变脸），且很难定位。历史上快照/日志相关用例都有这个毛病
    （snapshots / snapshots_keep / snapshots_log / usage_log / log_payloads / log_path）。

    与 monkeypatch 的关系：用例内仍应优先用 `monkeypatch.setitem(converter.CONFIG, ...)`
    （显式、局部、可读）。本夹具是**兜底**，不是替代——它保证「漏写的还原」不会污染别人。
    拆除顺序上 monkeypatch 先还原自己的键，本夹具随后整体恢复快照，故两者可安全共存。
    """
    snapshot = dict(converter.CONFIG)
    yield
    converter.CONFIG.clear()
    converter.CONFIG.update(snapshot)
