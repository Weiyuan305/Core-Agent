function invalid(): never { throw new Error("JSON body is invalid"); }

export function parseJsonWithoutDuplicateKeys(text: string): unknown {
  let index = 0;
  const whitespace = (): void => { while (/\s/u.test(text[index] ?? "")) index += 1; };
  const string = (): string => {
    if (text[index] !== '"') invalid();
    const start = index++;
    while (index < text.length) {
      const char = text[index++]!;
      if (char === '"') {
        try { return JSON.parse(text.slice(start, index)) as string; } catch { invalid(); }
      }
      if (char === "\\") {
        if (index >= text.length) invalid();
        if (text[index] === "u") index += 5; else index += 1;
      } else if (char.charCodeAt(0) < 0x20) invalid();
    }
    invalid();
  };
  const value = (): void => {
    whitespace();
    if (text[index] === "{") { object(); return; }
    if (text[index] === "[") { array(); return; }
    if (text[index] === '"') { string(); return; }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(index));
    if (match === null) invalid();
    index += match[0].length;
  };
  const object = (): void => {
    index += 1; whitespace();
    const keys = new Set<string>();
    if (text[index] === "}") { index += 1; return; }
    while (true) {
      whitespace(); const key = string();
      if (keys.has(key)) invalid();
      keys.add(key); whitespace();
      if (text[index++] !== ":") invalid();
      value(); whitespace();
      const delimiter = text[index++];
      if (delimiter === "}") return;
      if (delimiter !== ",") invalid();
    }
  };
  const array = (): void => {
    index += 1; whitespace();
    if (text[index] === "]") { index += 1; return; }
    while (true) {
      value(); whitespace();
      const delimiter = text[index++];
      if (delimiter === "]") return;
      if (delimiter !== ",") invalid();
    }
  };
  value(); whitespace();
  if (index !== text.length) invalid();
  return JSON.parse(text) as unknown;
}
