// Blank out comments and string bodies, preserving every byte position.
//
// WHY IT IS SHARED
//   Two mechanical gates ask "does this code do X?" by looking for a name in
//   source text, and both are wrong if a comment or a log message counts:
//
//     · check-hook-order.mjs — a `{`, a `}` or the word `return` inside a
//       comment or a template literal moves its brace-depth counter and fakes
//       an early return.
//     · check-route-auth.mjs — `// TODO: this needs requireOwnerCode`, or the
//       string "requireOwnerCode" in a log line, satisfied the gate test and
//       the route read as gated. A gate that exists only in a comment is not a
//       gate. (Measured 2026-09-02 against the live tree: 0 of 176 routes were
//       gated only by a comment mention, so that bypass was latent, not live.)
//
//   The technique was already in check-hook-order.mjs and is already applied by
//   hand elsewhere for the same reason — routes/cma-entitlement-gate-test.ts
//   runs its ordering assertions "on COMMENT-STRIPPED text". One copy, two
//   callers.
//
// LENGTH IS PRESERVED PER LINE, and newlines survive, so line and column
// numbers taken from the stripped text still point at the real source.
//
// REGEX LITERALS ARE A THIRD STATE, and leaving them out was not cosmetic.
// `if (!/^https:\\/\\//i.test(target)) {` in routes/brief.ts contains the two
// characters `//` — the escaped slashes inside the pattern — so a stripper that
// only knows comments and strings blanks the rest of that line, including
// `.test(target))`. Two closing parens vanish, the paren-balanced handler body
// never closes, and the reader runs on into the NEXT route and inherits its
// gate. That is a route reading as gated because of its neighbour, which is the
// exact false green this file is meant to remove. Measured on that route: the
// body ran 1777→1881 correctly with a naive stripper's input and 1777→2177 with
// one that did not know regexes.
//
// Regex-vs-division is decided the way every hand-written JS lexer decides it:
// a `/` opens a pattern only where a VALUE may start — after `(`, `,`, `=`,
// `:`, an operator, or one of the keywords below — never after an identifier,
// a number, or a closing bracket, where it can only be division.
const VALUE_POSITION_KEYWORDS = /(^|[^A-Za-z0-9_$.])(return|typeof|instanceof|case|in|of|new|delete|void|yield|await|do|else)$/;

function regexMayStart(codeTail) {
  const t = codeTail.replace(/\s+$/, "");
  if (t === "") return true;
  const last = t[t.length - 1];
  if (/[)\]}]/.test(last)) return false;
  // `<` AND `>` ARE JSX, NOT COMPARISON, IN THIS TREE. Both are value positions
  // in plain JS, so the general rule said "a regex may start here" — and then
  // every `</div>` opened a regex state that ran to the end of the line.
  // Measured across artifacts/buyer-brief/src: 205 lines in 57 of 179 .tsx
  // files lost braces that way, so `</div>{x}` came back with both braces
  // gone and the depth counter in check-hook-order.mjs drifted. A regex
  // literal written directly after a comparison operator is not a shape this
  // repo has; a closing JSX tag is on nearly every component line.
  if (last === "<" || last === ">") return false;
  if (/[A-Za-z0-9_$]/.test(last)) return VALUE_POSITION_KEYWORDS.test(t);
  return true;
}

export function stripSource(src) {
  let out = "";
  let i = 0;
  let state = "code";
  // Trailing run of emitted CODE characters, used only by regexMayStart. Kept
  // short because the longest thing it has to recognise is `instanceof`.
  let codeTail = "";
  const emitCode = (ch) => {
    out += ch;
    codeTail = (codeTail + ch).slice(-16);
  };
  // Inside a regex, `/` between [ and ] is a literal slash, not the terminator.
  let inCharClass = false;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") { state = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && next === "*") { state = "block"; out += "  "; i += 2; continue; }
      if (c === "/" && regexMayStart(codeTail)) {
        state = "regex";
        inCharClass = false;
        out += " ";
        codeTail = `${codeTail}x`.slice(-16); // a pattern is a value, like an identifier
        i += 1;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { state = c; out += " "; codeTail = `${codeTail}x`.slice(-16); i += 1; continue; }
      emitCode(c);
      i += 1;
      continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += "\n"; codeTail = ""; } else out += " ";
      i += 1; continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") { state = "code"; out += "  "; i += 2; continue; }
      out += c === "\n" ? "\n" : " "; i += 1; continue;
    }
    if (state === "regex") {
      // An unterminated regex would be a syntax error, but a newline still ends
      // the run rather than eating the rest of the file: fail small.
      if (c === "\n") { state = "code"; out += "\n"; codeTail = ""; i += 1; continue; }
      if (c === "\\") { out += "  "; i += 2; continue; }
      if (c === "[") { inCharClass = true; out += " "; i += 1; continue; }
      if (c === "]") { inCharClass = false; out += " "; i += 1; continue; }
      if (c === "/" && !inCharClass) { state = "code"; out += " "; i += 1; continue; }
      out += " "; i += 1; continue;
    }
    // inside a string/template
    if (c === "\\") { out += "  "; i += 2; continue; }
    if (c === state) { state = "code"; out += " "; i += 1; continue; }
    out += c === "\n" ? "\n" : " ";
    i += 1;
  }
  return out;
}
