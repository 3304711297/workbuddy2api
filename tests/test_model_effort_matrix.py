"""回归测试：思考强度档位矩阵完整性（内置覆盖表兜底 + 默认档透传语义）。

背景（2026-09-11 实测）：
  上游 `/v2/enterprises/personal/models` 对 `deepseek-v4.1-flash`、`deepseek-v4-pro`
  等模型只下发扁平 `reasoning: {"effort": "high"}`，**不带** `supportedEfforts` /
  `canDisableThinking`；而官方客户端另有两路下发完整矩阵。
  反代若只认扁平值，控制台会把这些模型误显示为「仅 high、不可关闭思考」。

矩阵来源（两处官方实测，均落盘于本机 CodeBuddy 客户端）：
  - **CLOUD**：`cloud_product_config_cache`（`/v3/config` 最新云端配置，21 模型）
    → 位置：`%APPDATA%/CodeBuddy CN/User/globalStorage/state.vscdb`
       └ ItemTable key `Tencent-Cloud.coding-copilot` → `cloud_product_config_cache[0].data.models`
  - **BASELINE**：客户端基线 `product.json`（49 模型，含更早发布的模型）
    → 位置：`%USERPROFILE%/.codebuddy/local_storage/entry_9392273177290f1b2cee8c510fc95618.info`
       （值为 base64(gzip(JSON))）

本组测试锁死四件事：
  A. 内置覆盖表与上述**两处官方实测矩阵**逐项一致（防矩阵漂移）；
  B. Rust 侧「上游非子集 > 半截矩阵 merged 补全 > 覆盖表 > 扁平值」判定口径；
  C. 前端「默认」选项语义 = 不覆盖、原样透传客户端下发的 reasoning_effort
     （用户诉求：思考强度只由 Hermes 侧 agent.reasoning_effort=ultra 控制）；
  D. 反代不拦截任意档位值（ultra/max/xhigh 畅通）。
"""

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BILLING_RS = REPO_ROOT / "src-tauri" / "src" / "commands" / "billing.rs"
MODELS_JS = REPO_ROOT / "src" / "models.js"
CONVERTER_PY = REPO_ROOT / "converter.py"

# 官方实测矩阵 CLOUD 源（cloud_product_config_cache，21 模型；2026-09-11 提取）
CLOUD_MATRIX = {
    "deepseek-v4.1-flash": (["low", "high", "max"], "high", True),
    "deepseek-v4-pro": (["low", "high", "xhigh"], "high", True),
    "glm-5.3": (["low", "high", "max"], "high", True),
    "glm-5.3-flash": (["low", "high", "max"], "high", True),
    "glm-5.2": (["high", "xhigh"], "high", True),
    "hy3": (["low", "high"], "high", False),
    "hy3-x": (["low", "high"], "high", False),
    "hy4-preview": (["high"], "high", False),
    "gpt-6-astra": (["low", "medium", "high", "xhigh", "max"], "high", True),
}

# 官方实测矩阵 BASELINE 源（客户端基线 product.json，49 模型；2026-09-11 提取）
BASELINE_MATRIX = {
    "deepseek-v4-flash": (["high", "xhigh"], "high", True),
}

# 合并后的权威表 = 覆盖表必须逐项匹配的目标
OFFICIAL_MATRIX = {**CLOUD_MATRIX, **BASELINE_MATRIX}

# 每个 catalog 条目的来源标注（供人工核对，不参与断言逻辑）
CATALOG_SOURCES = {
    **{k: "cloud" for k in CLOUD_MATRIX},
    **{k: "baseline" for k in BASELINE_MATRIX},
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
    """内置覆盖表必须与官方实测矩阵逐项一致，防止漂移。"""
    catalog = _parse_catalog(_read(BILLING_RS))
    for mid, (efforts, default_effort, can_disable) in OFFICIAL_MATRIX.items():
        assert mid in catalog, f"覆盖表缺少模型 {mid}"
        got_efforts, got_default, got_can_disable = catalog[mid]
        assert got_efforts == efforts, f"{mid} 档位不符：{got_efforts} != {efforts}"
        assert got_default == default_effort, f"{mid} 默认档不符：{got_default}"
        assert got_can_disable == can_disable, f"{mid} 可关闭思考标志不符：{got_can_disable}"


def test_baseline_only_model_is_locked():
    """deepseek-v4-flash 只出现在 BASELINE 源，必须被逐项锁定（P2-a 回归）。

    此前它被放进例外集合，导致「catalog 有记录但未与真源锁定」的测试真空。
    """
    catalog = _parse_catalog(_read(BILLING_RS))
    for mid, expected in BASELINE_MATRIX.items():
        assert mid in catalog, f"覆盖表缺少 BASELINE 源模型 {mid}"
        assert catalog[mid] == expected, f"{mid} 与 BASELINE 实测不符：{catalog[mid]} != {expected}"


def test_catalog_contains_no_unknown_models():
    """覆盖表不得收录官方矩阵之外的模型（防止凭空造档位）。"""
    catalog = _parse_catalog(_read(BILLING_RS))
    extra = set(catalog) - set(OFFICIAL_MATRIX)
    assert not extra, f"覆盖表出现未核实模型：{extra}"


def test_every_catalog_entry_has_declared_source():
    """每个覆盖表条目都要在 CATALOG_SOURCES 里声明来源，禁止无出处条目。"""
    catalog = _parse_catalog(_read(BILLING_RS))
    missing = set(catalog) - set(CATALOG_SOURCES)
    assert not missing, f"以下条目未声明官方来源：{missing}"


def test_only_reasoning_models_deny_disable():
    """onlyReasoning 的模型（hy3/hy3-x/hy4-preview）不得开放关闭思考。"""
    catalog = _parse_catalog(_read(BILLING_RS))
    for mid in ("hy3", "hy3-x", "hy4-preview"):
        assert catalog[mid][2] is False, f"{mid} 是 onlyReasoning 模型，不应允许关闭思考"


# ---------- B: Rust 侧判定口径 ----------


def test_billing_uses_resolver_function():
    """billing.rs 必须经由 resolve_reasoning_matrix 统一解析，不得内联判定。"""
    rs = _read(BILLING_RS)
    assert "fn resolve_reasoning_matrix(" in rs, "缺少 resolve_reasoning_matrix"
    assert "resolve_reasoning_matrix(upstream_efforts, flat_effort, catalog)" in rs, \
        "调用点未接入解析函数"


def test_resolver_prefers_upstream_superset():
    """上游非子集矩阵必须原样保留（含覆盖表未知档位）。"""
    rs = _read(BILLING_RS)
    fn = rs[rs.index("fn resolve_reasoning_matrix("):]
    fn = fn[:fn.index("\n}\n") + 3]
    # 子集判定必须要求「全部已知」且「上游更短」
    assert "all_known" in fn
    assert "c.efforts.len() > upstream_efforts.len()" in fn
    assert 'return (upstream_efforts, "upstream".to_string());' in fn


def test_resolver_merges_partial_matrix():
    """上游严格子集 → merged 补全（P2-b 回归）。"""
    rs = _read(BILLING_RS)
    assert '(full, "merged".to_string())' in rs, "缺少 merged 分支"


def test_resolver_source_labels_are_documented():
    """三种来源标记必须在 Rust 注释与前端都能对上。"""
    rs = _read(BILLING_RS)
    for label in ('"upstream"', '"merged"', '"catalog"'):
        assert label in rs, f"Rust 侧缺少来源标记 {label}"


def test_rust_has_unit_tests_for_resolver():
    """解析函数必须有配套 Rust 单元测试（防止逻辑退化无感知）。"""
    rs = _read(BILLING_RS)
    assert "mod reasoning_matrix_tests" in rs, "缺少 Rust 单元测试模块"
    for case in ("upstream_superset_wins", "upstream_subset_merges_to_catalog",
                 "upstream_subset_with_unknown_effort_wins",
                 "no_upstream_matrix_falls_back_to_catalog"):
        assert case in rs, f"缺少 Rust 用例 {case}"


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


def test_frontend_shows_matrix_source_hint():
    """使用本地矩阵兜底时，前端需提示来源，避免用户误以为上游完整下发。"""
    js = _read(MODELS_JS)
    assert "m.efforts_source === 'catalog'" in js or "m.efforts_source" in js
    assert "内置覆盖表" in js


def test_frontend_handles_merged_source():
    """前端需覆盖 merged 来源（半截矩阵补全）的提示分支。"""
    js = _read(MODELS_JS)
    assert "'merged'" in js, "前端未处理 merged 来源"


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
    assert py.count("custom_effort = custom_cfg.get(\"reasoning_effort\")") == 2
    assert py.count("custom_effort = custom_cfg.get(\"reasoning_effort\")\n    if custom_effort:") == 2


def test_converter_passes_through_arbitrary_effort_values():
    """reasoning_effort 必须在透传白名单里，超高档位（ultra/max/xhigh）不被过滤。"""
    py = _read(CONVERTER_PY)
    block = re.search(r"PASSTHROUGH_BODY_KEYS = \{(.*?)\}", py, re.S)
    assert block, "未找到 PASSTHROUGH_BODY_KEYS"
    assert "reasoning_effort" in block.group(1)
    assert "EFFORT_WHITELIST" not in py
    assert "SUPPORTED_EFFORTS" not in py
