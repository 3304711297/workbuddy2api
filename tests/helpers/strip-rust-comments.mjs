/**
 * 剥离 Rust 源码注释，供「看源码做结构/负向断言」的契约测试复用。
 *
 * 为什么不逐行用正则替换：
 *   ① **字符串字面量里的 `//` 会被误当注释开头**。典型是 URL 与路径校验：
 *      `format!("https://api.github.com/repos/{slug}/commits/{branch}")`、
 *      `ep.contains("//")`。逐行替换会把整行尾部一起吃掉，于是
 *      · 正向断言（「必须存在某端点」）永远取不到 → 恒失败；
 *      · 负向断言（「不得出现某写法」）则变成空过 —— 真正的回归被藏起来，最危险。
 *   ② **换行符敏感**。CRLF 检出下 `.` 不匹配 `\r`、而 `$`（无 m 标志）锚定在 `\r` 之后，
 *      `line.replace(/\/\/.*$/, '')` 恒不匹配 → 剥离完全空转，注释原样留在结果里，
 *      负向断言会把说明性注释也算进去（写一句「不再使用 X」就误报）。
 *      Windows 检出（本项目主平台 + CI）正是这种情形，于是同一用例在 Linux 上失败、在
 *      Windows 上假绿。
 *
 * 本实现按字符扫描：跳过字符串/字符字面量（含 `r"…"` / `r#"…"#` 原始串）后才识别注释，
 * 行尾原样保留（不吞 `\r`），因此 LF 与 CRLF 结果一致。
 *
 * @param {string} src Rust 源码全文
 * @returns {string} 去掉行注释与块注释（含嵌套块注释）后的文本，保留换行与字符串内容
 */
export function stripRustComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const prev = i > 0 ? src[i - 1] : '';
    // 原始字符串：r"…" / r#"…"# / br#"…"#（前一个字符不是标识符字符才算起始，
    // 避免把 `for`、`parse_compare` 这类标识符里的 r 当成原始串前缀）
    const rawMatch = /[A-Za-z0-9_]/.test(prev)
      ? null
      : /^(?:b|c)?r(#*)"/.exec(src.slice(i, i + 8));
    if (rawMatch) {
      const terminator = '"' + rawMatch[1];
      const start = i;
      i += rawMatch[0].length;
      const end = src.indexOf(terminator, i);
      i = end === -1 ? n : end + terminator.length;
      out += src.slice(start, i);
      continue;
    }
    // 普通字符串字面量（含 \" 转义）
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '"') { i += 1; break; }
        i += 1;
      }
      out += src.slice(start, i);
      continue;
    }
    // 字符字面量 'a' / '\n'；生命周期标注（如 &'static str）不匹配，按普通字符输出
    if (ch === "'") {
      const m = /^'(?:\\.|[^\\'])'/.exec(src.slice(i, i + 6));
      if (m) { out += m[0]; i += m[0].length; continue; }
      out += ch;
      i += 1;
      continue;
    }
    // 行注释：吞到行尾，保留换行符本身
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i += 1;
      continue;
    }
    // 块注释：Rust 支持嵌套 /* /* */ */
    if (ch === '/' && src[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') { depth += 1; i += 2; }
        else if (src[i] === '*' && src[i + 1] === '/') { depth -= 1; i += 2; }
        else i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
