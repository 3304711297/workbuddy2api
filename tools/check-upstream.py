#!/usr/bin/env python3
"""WorkBuddy2API 社区反代生态借鉴项目看门巡检脚本。

读取 tools/upstream-sources.json，查询各借鉴仓库默认分支的最新提交，
与本地已记录的基线 SHA 对比，生成 upstream-report.md 并输出 GITHUB_OUTPUT。
纯标准库实现，支持在本地与 GitHub Actions 环境直接运行。
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCES_FILE = os.path.join(REPO_ROOT, "tools", "upstream-sources.json")
REPORT_PATH = os.path.join(REPO_ROOT, "upstream-report.md")


def get_token() -> str:
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        return token.strip()
    try:
        res = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=5)
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip()
    except Exception:
        pass
    return ""


def api_get(url: str, token: str) -> dict | list | None:
    headers = {
        "User-Agent": "WorkBuddy2API-Upstream-Watch",
        "Accept": "application/vnd.github+json",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(url, headers=headers)
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception:
            time.sleep(1.5 * (attempt + 1))
    return None


def lint_sources(data: dict) -> list[str]:
    errors = []
    if not isinstance(data, dict):
        return ["根节点必须为 JSON 对象"]
    sources = data.get("sources")
    if not isinstance(sources, dict) or not sources:
        return ["缺少非空的 'sources' 字典"]
    for sid, cfg in sources.items():
        if not isinstance(cfg, dict):
            errors.append(f"{sid}: 配置项必须为字典")
            continue
        if not cfg.get("repo"):
            errors.append(f"{sid}: 缺少必填字段 'repo'")
        if not cfg.get("last_synced_commit"):
            errors.append(f"{sid}: 缺少必填字段 'last_synced_commit'")
    return errors


def check_source(sid: str, cfg: dict, token: str) -> dict:
    repo = cfg["repo"]
    last_commit = cfg.get("last_synced_commit", "").strip()
    last_sha = cfg.get("last_synced_sha", "").strip()

    # 优先查路径为 . 的 commits（确保与代码树真实提交一致）
    commits = api_get(f"https://api.github.com/repos/{repo}/commits?path=.&per_page=5", token)
    if not commits or not isinstance(commits, list):
        # 回退全仓最新 commit
        commits = api_get(f"https://api.github.com/repos/{repo}/commits?per_page=5", token)

    if not commits or not isinstance(commits, list) or len(commits) == 0:
        return {
            "id": sid,
            "name": cfg.get("name", sid),
            "repo": repo,
            "status": "query_failed",
            "last_commit": last_commit[:8],
            "latest_commit": "N/A",
            "commit_msg": "查询上游失败",
            "commit_date": "",
            "has_update": False,
            "compare_url": "",
            "absorbed": cfg.get("absorbed", ""),
            "note": cfg.get("note", ""),
        }

    head_item = commits[0]
    latest_sha = head_item.get("sha", "")
    latest_short = latest_sha[:8]
    commit_msg = (head_item.get("commit", {}).get("message", "") or "").splitlines()[0][:65]
    commit_date = (head_item.get("commit", {}).get("committer", {}).get("date", "") or "")[:10]

    baseline = (last_sha or last_commit)[:8]
    has_update = bool(latest_short and baseline and latest_short != baseline)

    compare_url = f"https://github.com/{repo}/compare/{baseline}...{latest_short}" if has_update else ""

    return {
        "id": sid,
        "name": cfg.get("name", sid),
        "repo": repo,
        "status": "updated" if has_update else "current",
        "last_commit": baseline,
        "latest_commit": latest_short,
        "commit_msg": commit_msg,
        "commit_date": commit_date,
        "has_update": has_update,
        "compare_url": compare_url,
        "absorbed": cfg.get("absorbed", ""),
        "note": cfg.get("note", ""),
    }


def main():
    if "--lint" in sys.argv:
        with open(SOURCES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        errs = lint_sources(data)
        if errs:
            for e in errs:
                sys.stderr.write(f"❌ {e}\n")
            sys.exit(1)
        print(f"✅ upstream-sources.json 校验通过：共 {len(data.get('sources', {}))} 个借鉴源。")
        return

    with open(SOURCES_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    sources = data.get("sources", {})
    token = get_token()

    now = datetime.now(timezone(timedelta(hours=8)))
    print(f"=== 开始巡检 {len(sources)} 个反代生态借鉴仓库（北京时间：{now.strftime('%Y-%m-%d %H:%M')}）===")

    results = []
    updates = []
    for sid, cfg in sources.items():
        res = check_source(sid, cfg, token)
        results.append(res)
        if res["has_update"]:
            updates.append(res)
            icon = "🔴"
        elif res["status"] == "query_failed":
            icon = "⚠️"
        else:
            icon = "✅"
        print(f"{icon} [{res['name']}] {res['repo']}: {res['last_commit']} -> {res['latest_commit']} ({res['commit_msg']})")

    failures = [r for r in results if r["status"] == "query_failed"]
    print(f"\n巡检结束：共发现 {len(updates)} 项存在上游新提交待评估，{len(failures)} 项查询失败。")

    # 生成 Markdown 报告
    report_lines = [
        "# 🔔 WorkBuddy2API 借鉴项目上游更新报告",
        "",
        f"> 生成时间：{now.strftime('%Y-%m-%d %H:%M')}（北京时间） · 配置文件：`tools/upstream-sources.json`",
        ">",
        "> **跟进 SOP**：审查对应上游的新提交 Diff 是否有可借鉴机制；若吸收落地，更新 `tools/upstream-sources.json` 对应条目的 `last_synced_commit` 并推 main，CI 会在无待跟进项时自动关闭本 Issue。",
    ]
    if failures:
        report_lines.append(f">\n> ⚠️ **注意**：本次巡检有 {len(failures)} 项上游仓库查询失败（受网络波动或 GitHub API 限额影响），已标记为降级巡检并保留既有基线。")
    report_lines.append("")
    report_lines.append("## 概览")
    report_lines.append("")
    report_lines.append("| 项目 / 借鉴源 | 仓库 | 本地基线 | 上游最新 | 状态 |")
    report_lines.append("|---------------|------|----------|----------|------|")

    for r in results:
        if r["has_update"]:
            st = "🔴 有新提交"
        elif r["status"] == "query_failed":
            st = "⚠️ 查询失败"
        else:
            st = "✅ 最新"
        report_lines.append(f"| {r['name']} | `{r['repo']}` | `{r['last_commit']}` | `{r['latest_commit']}` | {st} |")

    report_lines.append("")
    report_lines.append("## 明细与对比链接")
    report_lines.append("")

    for r in results:
        report_lines.append(f"### {r['name']} (`{r['repo']}`)")
        report_lines.append("")
        if r["has_update"]:
            report_lines.append(f"- 上游最新：**`{r['latest_commit']}`**（{r['commit_date']}）{r['commit_msg']}")
            report_lines.append(f"- 本地基线：`{r['last_commit']}`")
            report_lines.append(f"- 变更对比：{r['compare_url']}")
            report_lines.append(f"- 本地已吸收：{r['absorbed'] or '无'}")
            report_lines.append(f"- 监控关注点：{r['note'] or '无'}")
            report_lines.append(f"- 跟进方式：审查 Diff；若有采纳落地，将 `tools/upstream-sources.json` 中该项的 `last_synced_commit` 推进为 `{r['latest_commit']}` 并提交推送。")
        elif r["status"] == "query_failed":
            report_lines.append("- ⚠️ 查询上游失败，可能受网络波动或 GitHub API 限额影响，保持当前基线。")
        else:
            report_lines.append(f"- 上游最新：**`{r['latest_commit']}`**（{r['commit_date']}）{r['commit_msg']}")
            report_lines.append(f"- 本地基线：`{r['last_commit']}` → ✅ 一致（无未评估新提交）")
        report_lines.append("")

    report_lines.append("---")
    report_lines.append(f"**待跟进项目数：{len(updates)}** · **查询失败数：{len(failures)}**")

    report_text = "\n".join(report_lines)
    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        f.write(report_text)

    gh_output = os.environ.get("GITHUB_OUTPUT")
    if gh_output:
        has_updates_str = "true" if len(updates) > 0 else "false"
        has_query_failures_str = "true" if len(failures) > 0 else "false"
        with open(gh_output, "a", encoding="utf-8") as f:
            f.write(f"has_updates={has_updates_str}\n")
            f.write(f"update_count={len(updates)}\n")
            f.write(f"has_query_failures={has_query_failures_str}\n")
            f.write(f"query_failure_count={len(failures)}\n")


if __name__ == "__main__":
    main()
