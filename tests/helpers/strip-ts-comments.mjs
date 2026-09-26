/**
 * 剥离 TS/TSX 源码注释，供「看源码做结构/负向断言」的契约测试复用。
 *
 * 为什么不用逐行正则（AGENTS.md §2 已记录的教训同样适用于 TS）：
 *  - 字符串字面量里的 `//`（如 'https://…'、正则中的 `\/`）会被误当注释开头；
 *  - CRLF 检出下 `.` 不匹配 `\r`，逐行剥离会空转，负向断言把注释算进代码。
 *
 * 本实现按字符扫描，上下文栈：'code' | 'template' | 'tpl-expr'。
 * 字符串与模板字面量原样保留（注释只在代码上下文中识别）；
 * 换行原样保留，LF/CRLF 结果一致。
 */
export function stripTsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // 栈元素：{ kind: 'code' | 'template' | 'tpl-expr', brace: number }
  const stack = [{ kind: 'code', brace: 0 }];
  const top = () => stack[stack.length - 1];

  while (i < n) {
    const ch = src[i];
    const frame = top();

    // ---- 模板文本上下文：原样拷贝，只认转义、${ 与反引号 ----
    if (frame.kind === 'template') {
      if (ch === '\\') {
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '$' && src[i + 1] === '{') {
        out += '${';
        i += 2;
        stack.push({ kind: 'tpl-expr', brace: 0 });
        continue;
      }
      if (ch === '`') {
        out += ch;
        i++;
        stack.pop();
        continue;
      }
      out += ch;
      i++;
      continue;
    }

    // ---- ${} 表达式上下文：跟踪花括号配平 ----
    if (frame.kind === 'tpl-expr') {
      if (ch === '{') frame.brace++;
      if (ch === '}') {
        if (frame.brace === 0) {
          out += ch;
          i++;
          stack.pop(); // 回到外层 template 上下文
          continue;
        }
        frame.brace--;
      }
      // 落到下方代码逻辑（字符串/注释识别）
    }

    // ---- 代码上下文 ----
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        const c = src[i];
        out += c;
        i++;
        if (c === '\\') {
          if (i < n) { out += src[i]; i++; }
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }
    if (ch === '`') {
      out += ch;
      i++;
      stack.push({ kind: 'template', brace: 0 });
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
