import { safePath } from "./files.js";

type Frame = {
  object: boolean;
  files: boolean;
  state: "key" | "value" | "colon" | "comma";
  key?: string;
  entry?: { path?: string; content?: string };
};
type StringToken = {
  frame: Frame;
  key: boolean;
  file?: string;
  value: string;
  escape: boolean;
  unicode?: string;
};

/** Decode either website wire format as strings arrive, including unfinished values. */
export class PartialWebsite {
  readonly files: Record<string, string> = Object.create(null);
  readonly changed = new Set<string>();
  private offset = 0;
  private frames: Frame[] = [];
  private string?: StringToken;
  update(source: string): boolean {
    let changed = false;
    const publish = (path: string | undefined, content: string | undefined) => {
      if (!path || !safePath(path) || content === undefined) return;
      this.files[path] = content;
      this.changed.add(path);
      changed = true;
    };
    const append = (value: string) => {
      const token = this.string!;
      if (token.key) token.value += value;
      else if (token.frame.entry) {
        token.value += value;
        if (token.frame.key === "content") {
          token.frame.entry.content = token.value;
          publish(token.frame.entry.path, token.value);
        }
      } else if (token.file) {
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
          } else {
            const entry = token.frame.entry;
            if (entry && token.frame.key === "path") {
              entry.path = token.value;
              publish(entry.path, entry.content);
            }
            token.frame.state = "comma";
          }
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
          frame.object &&
          frame.state === "value" &&
          frame.key &&
          safePath(frame.key)
            ? frame.key
            : undefined;
        this.string = { frame, key, file, value: "", escape: false };
        if (!key && frame.entry && frame.key === "content") {
          frame.entry.content = "";
          publish(frame.entry.path, "");
        }
        if (file) {
          this.files[file] = "";
          this.changed.add(file);
          changed = true;
        }
      } else if (char === "{" || char === "[") {
        this.frames.push({
          object: char === "{",
          files: this.frames.length === 1 && frame?.key === "files",
          entry: char === "{" && frame?.files && !frame.object ? {} : undefined,
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
