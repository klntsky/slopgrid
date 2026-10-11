import { safePath } from "./files.js";

type Frame = {
  object: boolean;
  files: boolean;
  state: "key" | "value" | "colon" | "comma";
  key?: string;
};
type StringToken = {
  frame: Frame;
  key: boolean;
  file?: string;
  value: string;
  escape: boolean;
  unicode?: string;
};

/** Decode the files object as its JSON strings arrive, including unfinished values. */
export class PartialWebsite {
  readonly files: Record<string, string> = Object.create(null);
  readonly changed = new Set<string>();
  private offset = 0;
  private frames: Frame[] = [];
  private string?: StringToken;
  update(source: string): boolean {
    let changed = false;
    const append = (value: string) => {
      const token = this.string!;
      if (token.key) token.value += value;
      else if (token.file) {
        this.files[token.file] += value;
        this.changed.add(token.file);
        changed = true;
      }
    };
    for (; this.offset < source.length; this.offset++) {
      const char = source[this.offset];
      if (this.string) {
        const token = this.string;
        if (token.unicode !== undefined) {
          token.unicode += char;
          if (token.unicode.length === 4) {
            if (/^[a-f0-9]{4}$/i.test(token.unicode))
              append(String.fromCharCode(parseInt(token.unicode, 16)));
            token.unicode = undefined;
          }
        } else if (token.escape) {
          token.escape = false;
          if (char === "u") token.unicode = "";
          else
            append(
              (
                {
                  '"': '"',
                  "\\": "\\",
                  "/": "/",
                  b: "\b",
                  f: "\f",
                  n: "\n",
                  r: "\r",
                  t: "\t",
                } as Record<string, string>
              )[char] ?? char,
            );
        } else if (char === "\\") token.escape = true;
        else if (char === '"') {
          if (token.key) {
            token.frame.key = token.value;
            token.frame.state = "colon";
          } else token.frame.state = "comma";
          this.string = undefined;
        } else append(char);
        continue;
      }
      const frame = this.frames.at(-1);
      if (char === '"' && frame) {
        const key = frame.object && frame.state === "key";
        const file =
          !key &&
          frame.files &&
          frame.state === "value" &&
          frame.key &&
          safePath(frame.key)
            ? frame.key
            : undefined;
        this.string = { frame, key, file, value: "", escape: false };
        if (file) {
          this.files[file] = "";
          this.changed.add(file);
          changed = true;
        }
      } else if (char === "{" || char === "[") {
        this.frames.push({
          object: char === "{",
          files:
            char === "{" && this.frames.length === 1 && frame?.key === "files",
          state: char === "{" ? "key" : "value",
        });
      } else if (char === "}" || char === "]") {
        this.frames.pop();
        const parent = this.frames.at(-1);
        if (parent) parent.state = "comma";
      } else if (char === ":" && frame) frame.state = "value";
      else if (char === "," && frame) {
        frame.state = frame.object ? "key" : "value";
        frame.key = undefined;
      }
    }
    return changed;
  }
}
