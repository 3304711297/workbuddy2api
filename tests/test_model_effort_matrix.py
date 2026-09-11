"""回归测试：思考强度档位矩阵完整性（内置覆盖表兜底 + 默认档透传语义）。

背景（2026-09-11 实测）：
  上游 `/v2/enterprises/personal/models` 对 `deepseek-v4.1-flash`、`deepseek-v4-pro`
  等模型只下发扁平 `reasoning: {"effort": "high"}`，**不带** `supportedEfforts` /
  `canDisableThinking`；而官方客户端另一路 `/v3/config` 下发完整矩阵。
  反代若只认扁平值，控制台会把这些模型误显示为「仅 high、不可关闭思考」。

本组测试锁死两件事：
  A. 内置覆盖表（catalog）不与官方实测矩阵漂移；
  B. Rust 侧「上游优先 > 覆盖表兜底 > 扁平值」的判定口径；
  C. 前端「默认」选项语义 = 不覆盖、原样透传客户端下发的 reasoning_effort
     （用户诉求：思考强度只由 Hermes 侧 agent.reasoning_effort=ultra 控制）。
"""

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BILLING_RS = REPO_ROOT / "src-tauri" / "src" / "commands" / "billing.rs"
MODELS_JS = REPO_ROOT / "src" / "models.js"
CONVERTER_PY = REPO_ROOT / "converter.py"

# 官方客户端 cloud_product_config_cache 实测矩阵（2026-09-11 提取，唯一真源）
OFFICIAL_MATRIX = {
    "deepseek-v4.1-flash": (["low", "high", "max"], "high", True),
    "deepseek-v4-pro": (["low", "high", "xhigh"], "high", True),
    "glm-5.3": (["low", "high", "max"], "high", True),
    "glm-5.3-flash": (["low", "high", "max"], "high", True),
    "glm-5.2": (["high", "xhigh"], "high", True),
    "hy3": (["low", "high"], "high", False),
    "hy3-x": (["low", "high"], "high", False),
    "hy4-preview": (["high"], "high", False),
}


def _read(path):
    return path.read_text(encoding="utf-8")


def _parse_catalog(rs_text):
    """从 billing.rs 的 EFFORT_CATALOG 静态表解析出 {id: (efforts, default, can_disable)}。"""
    block = re.search(r"const EFFORT_CATALOG: &\[EffortCatalog\] = &\[(.*?)\n\];", rs_text, re.S)
    assert block, "未找到 EFFORT_CATALOG 定义"
    catalog = {}
    row_re = re.compile(
        r'EffortCatalog\s*\{\s*id:\s*"([^"]+)",\s*'
        r'efforts:\s*&\[([^\]]*)\],\s*'
        r'default_effort:\s*"([^"]+)",\s*'
        r'can_disable_thinking:\s*(true|false)\s*\}'
    )
    for m in row_re.finditer(block.group(1)):
        mid, efforts_raw, default_effort, can_disable = m.groups()
        efforts = re.findall(r'"([^"]+)"', efforts_raw)
        catalog[mid] = (efforts, default_effort, can_disable == "true")
    return catalog


# ---------- A: 内置覆盖表 vs 官方实测矩阵 ----------


def test_catalog_matches_official_matrix():
    """内置覆盖表必须与官方客户端实测矩阵逐项一致，防止漂移。"""
    catalog = _parse_catalog(_read(BILLING_RS))
    for mid, (efforts, default_effort, can_disable) in OFFICIAL_MATRIX.items():
        assert mid in catalog, f"覆盖表缺少模型 {mid}"
        got_efforts, got_default, got_can_disable = catalog[mid]
        assert got_efforts == efforts, f"{mid} 档位不符：{got_efforts} != {efforts}"
        assert got_default == default_effort, f"{mid} 默认档不符：{got_default}"
        assert got_can_disable == can_disable, f"{mid} 可关闭思考标志不符：{got_can_disable}"


def test_catalog_contains_no_unknown_models():
    """覆盖表不得收录官方矩阵之外的模型（防止凭空造档位）。"""
    catalog = _parse_catalog(_read(BILLING_RS))
    extra = set(catalog) - set(OFFICIAL_MATRIX) - {"deepseek-v4-flash"}
    assert not extra, f"覆盖表出现未核实模型：{extra}"


def test_only_reasoning_models_deny_disable():
    """onlyReasoning 的模型（hy3/hy3-x/hy4-preview）不得开放关闭思考。"""
    catalog = _parse_catalog(_read(BILLING_RS))
    for mid in ("hy3", "hy3-x", "hy4-preview"):
        assert catalog[mid][2] is False, f"{mid} 是 onlyReasoning 模型，不应允许关闭思考"


# ---------- B: Rust 侧判定口径 ----------


def test_billing_prefers_upstream_matrix_then_catalog():
    """判定顺序必须是：上游完整矩阵 > 内置覆盖表 > 扁平 effort 兜底。"""
    rs = _read(BILLING_RS)
    assert 'let catalog = lookup_effort_catalog(&id);' in rs
    assert 'efforts_source = "upstream".to_string();' in rs
    assert 'efforts_source = "catalog".to_string();' in rs
    # 上游有完整矩阵时不得覆盖
    upstream_branch = rs.index("if !supported_efforts.is_empty() {")
    catalog_branch = rs.index('} else if let Some(c) = catalog {')
    assert upstream_branch < catalog_branch, "上游优先分支必须排在覆盖表分支之前"


def test_billing_exposes_efforts_source_field():
    """ModelMetaItem 必须暴露 efforts_source，供前端标注矩阵来源。"""
    rs = _read(BILLING_RS)
    assert "pub efforts_source: String," in rs
    assert "efforts_source," in rs  # 结构体构造处已填充


def test_billing_can_disable_falls_back_to_catalog():
    """上游缺 canDisableThinking 时，先查覆盖表，再退回 onlyReasoning 推断。"""
    rs = _read(BILLING_RS)
    assert "let upstream_can_disable = reasoning_obj" in rs
    assert "catalog\n                .map(|c| c.can_disable_thinking)" in rs


# ---------- C: 前端「默认」语义 = 透传 ----------


def test_frontend_default_option_means_follow_client():
    """前端默认项文案必须明示「跟随客户端」，不得误导为固定 high。"""
    js = _read(MODELS_JS)
    assert "默认（跟随客户端下发值）" in js, "弹窗默认项文案未明确透传语义"
    assert "默认 (跟随客户端)" in js, "列表行默认文案未明确透传语义"


def test_frontend_does_not_hardcode_default_effort_as_label():
    """默认项不得再渲染成「默认 (high)」这种把上游默认值当成本地档位的写法。"""
    js = _read(MODELS_JS)
    assert ">默认 (${esc(m.default_effort)})<" not in js


def test_frontend_shows_catalog_source_hint():
    """使用内置覆盖表兜底时，前端需提示矩阵来源，避免用户以为上游完整下发。"""
    js = _read(MODELS_JS)
    assert "m.efforts_source === 'catalog'" in js
    assert "内置覆盖表" in js


def test_frontend_renders_all_catalog_efforts_and_disable():
    """前端必须能渲染覆盖表全部档位与关闭思考项。"""
    js = _read(MODELS_JS)
    assert "for (const ef of m.supported_efforts)" in js
    assert "m.can_disable_thinking" in js
    assert "🚫 关闭思考" in js


# ---------- D: 反代不拦截客户端的 reasoning_effort（ultra 透传） ----------


def test_converter_only_overrides_when_user_sets_custom_effort():
    """converter 仅在用户显式配置 custom_effort 时改写，否则原样透传客户端值。

    用户诉求：思考强度只由 Hermes 侧 agent.reasoning_effort=ultra 控制，
    控制台保持「默认」时反代不得拦截/改写。
    """
    py = _read(CONVERTER_PY)
    # 两处注入点（chat/completions 与 /v1/messages）逻辑一致
    assert py.count("custom_effort = custom_cfg.get(\"reasoning_effort\")") == 2
    # 全部改写都在 `if custom_effort:` 分支内
    assert py.count("custom_effort = custom_cfg.get(\"reasoning_effort\")\n    if custom_effort:") == 2


def test_converter_passes_through_arbitrary_effort_values():
    """reasoning_effort 必须在透传白名单里，超高档位（ultra/max/xhigh）不被过滤。"""
    py = _read(CONVERTER_PY)
    assert '"reasoning_effort"' in py
    block = re.search(r"PASSTHROUGH_BODY_KEYS = \{(.*?)\}", py, re.S)
    assert block, "未找到 PASSTHROUGH_BODY_KEYS"
    assert "reasoning_effort" in block.group(1)
    # 不得出现对档位值的白名单校验（否则 ultra 会被拦）
    assert "EFFORT_WHITELIST" not in py
    assert "SUPPORTED_EFFORTS" not in py
