/**
 * 日志轮转契约（两项修复，2026-09）
 *
 * ① `converter.log` 此前**无任何大小上限**（请求级表格日志，每条请求一行摘要 + 耗时），
 *    只有 stdout 的 `proxy_stdout.log` 有 1MB 轮转。现让两个文件走同一实现：
 *    stdout 1MB/保留 1 份、converter.log 5MB/保留 3 份（`.1`/`.2`/`.3`）。
 * ② 轮转必须发生在**启动内核之前**（Windows 上对内核正在写的文件 rename 会失败/丢写；
 *    上游 momo0410/workbuddy-switch-gateway 的实测教训）。
 * ③ 副本数不得越轮越多（逐级后移 + 先删最旧，不是无限追加）。
 *
 * Rust 侧行为单测在 `proxy.rs::cleanup_log_rotation_tests`；本文件守「接线与口径」，
 * 防止有人把 converter.log 的轮转调用悄悄摘掉或把参数改成另一套数字。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripRustComments } from './helpers/strip-rust-comments.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROXY_RS = fs.readFileSync(
  path.join(REPO_ROOT, 'src-tauri', 'src', 'commands', 'proxy.rs'),
  'utf-8'
);
const PROXY_CODE = stripRustComments(PROXY_RS).replace(/\r\n/g, '\n');

test('结构化日志 converter.log 也参与启动前轮转（阈值 5MB / 保留 3 份）', () => {
  assert.ok(
    PROXY_RS.includes('STRUCTURED_LOG_THRESHOLD_BYTES: u64 = 5 * 1024 * 1024'),
    'converter.log 阈值必须是 5MB（它是请求级表格日志，增长远比 stdout 快）'
  );
  assert.ok(
    PROXY_RS.includes('STRUCTURED_LOG_KEEP: usize = 3'),
    'converter.log 必须保留 3 份副本（.1/.2/.3）'
  );
  assert.ok(
    PROXY_CODE.includes('rotate_structured_log_if_oversized()'),
    '缺少 converter.log 的轮转函数/调用'
  );
  assert.ok(
    /rotate_structured_log_if_oversized\(\)\s*\{[\s\S]{0,200}?structured_log_path\(\)/.test(PROXY_CODE),
    'converter.log 轮转必须指向 structured_log_path()，否则轮转的是别的文件'
  );
});

test('两个日志文件共用同一轮转实现（参数化路径/阈值/保留份数）', () => {
  assert.ok(
    PROXY_CODE.includes('fn rotate_log_if_oversized('),
    '缺少通用的参数化轮转实现——两个文件各写一份会各自漂移'
  );
  // 两个薄封装都必须走同一底层函数
  assert.ok(
    /fn rotate_proxy_log_if_oversized\(\)\s*\{[\s\S]{0,200}?rotate_log_if_oversized\(/.test(PROXY_CODE),
    'stdout 轮转未复用通用实现'
  );
  assert.ok(
    PROXY_CODE.includes('rotate_all_logs_if_oversized()'),
    '缺少启动前的统一轮转入口'
  );
  // 既有 stdout 口径不得被改动
  assert.ok(
    PROXY_RS.includes('STDOUT_LOG_THRESHOLD_BYTES: u64 = 1024 * 1024')
      && PROXY_RS.includes('STDOUT_LOG_KEEP: usize = 1'),
    'stdout 既有轮转口径（1MB / 1 份）被改动'
  );
});

test('轮转必须在 spawn 内核之前，且失败不得阻断启动', () => {
  // 剥离注释后断言（说明性注释里提到函数名不算接线）
  const code = PROXY_CODE;
  const start = code.indexOf('pub fn proxy_start(');
  assert.ok(start > -1, '未找到 proxy_start');
  const body = code.slice(start, code.indexOf('\n}\n', start));
  const rotateAt = body.indexOf('rotate_all_logs_if_oversized();');
  const spawnAt = body.indexOf('.spawn()');
  assert.ok(rotateAt > -1, 'proxy_start 未在启动前轮转日志');
  assert.ok(spawnAt > -1, '未找到 spawn 调用');
  assert.ok(
    rotateAt < spawnAt,
    '轮转必须在 spawn 之前：Windows 上对内核正在写的 converter.log 做 rename 会失败/丢写'
  );

  // 轮转实现内部：所有文件操作都必须丢弃错误（`let _ =`），绝不 `?` 传播
  const implStart = PROXY_CODE.indexOf('fn rotate_log_if_oversized(');
  const impl = PROXY_CODE.slice(implStart, PROXY_CODE.indexOf('\n}\n', implStart));
  assert.ok(impl, '未找到 rotate_log_if_oversized 实现');
  assert.ok(
    !impl.includes('?;') && !impl.includes('.unwrap()') && !impl.includes('.expect('),
    '轮转内部不得传播错误/panic：轮转失败绝不能阻断内核启动'
  );
  assert.ok(
    impl.includes('let Ok(meta) = std::fs::metadata(path) else'),
    '路径不存在时必须静默跳过（不得让 metadata 失败变成启动失败）'
  );
  assert.ok(
    impl.includes('remove_file'),
    '必须删除最旧的一份（否则副本数会随轮转越积越多）'
  );
});

test('尾部读取改为从文件末尾读取，不再整文件读入内存', () => {
  const start = PROXY_CODE.indexOf('fn read_file_tail_clipped(');
  assert.ok(start > -1, '未找到 read_file_tail_clipped');
  const impl = PROXY_CODE.slice(start, PROXY_CODE.indexOf('\n}\n', start));
  assert.ok(
    !impl.includes('std::fs::read('),
    'read_file_tail_clipped 仍在整文件读入内存（日志页每 5s 轮询一次，会反复制造 IO/内存峰值）'
  );
  assert.ok(
    impl.includes('SeekFrom::Start(start)') && impl.includes('saturating_sub'),
    '必须从末尾定位起点（len - max_bytes）后只读这一段'
  );
  assert.ok(
    impl.includes('read_to_end'),
    '缺少读取尾部内容的实现'
  );
});
