import { spawn } from "node:child_process";

// Putting something on the clipboard from inside a terminal, which is less
// obvious than it sounds.
//
// The usual approach — shell out to pbcopy/xclip/clip.exe — only works when the
// program is running on the same machine as the clipboard. Over SSH it writes
// to the *server's* clipboard, which nobody can reach. So the primary route
// here is OSC 52: an escape sequence that asks the *terminal emulator* to set
// its clipboard, which means it travels back over the SSH connection to the
// machine the person is actually sitting at. Both routes are attempted,
// because neither works everywhere.

const ESC = "\u001B";
const BEL = "\u0007";
const ST = `${ESC}\\`; // string terminator

function osc52(text: string): string {
  const payload = Buffer.from(text, "utf8").toString("base64");
  const sequence = `${ESC}]52;c;${payload}${BEL}`;
  // tmux and screen swallow escape sequences they don't recognise unless
  // they're wrapped for passthrough — without this, copying inside tmux
  // silently does nothing, which is the most confusing outcome available.
  if (process.env.TMUX) return `${ESC}Ptmux;${ESC}${sequence}${ST}`;
  if ((process.env.TERM ?? "").startsWith("screen")) return `${ESC}P${sequence}${ST}`;
  return sequence;
}

const isWsl = () =>
  process.platform === "linux" &&
  (!!process.env.WSL_DISTRO_NAME || (process.env.WSL_INTEROP ?? "") !== "");

// The local helper for this platform, if there is one. WSL is checked before
// the Linux tools on purpose: a WSL session's real clipboard is Windows', and
// clip.exe is the only thing that reaches it.
function localHelpers(): [string, string[]][] {
  if (process.platform === "win32") return [["clip", []]];
  if (process.platform === "darwin") return [["pbcopy", []]];
  if (isWsl()) return [["clip.exe", []]];
  return [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ];
}

function runHelper(command: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      return resolve(false);
    }
    // A missing binary surfaces as an error event rather than a throw.
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.on("error", () => resolve(false));
    child.stdin.end(text);
  });
}

/**
 * Copies `text`, reporting which route did it so the caller can be honest.
 * OSC 52 gives no acknowledgement — the terminal either honours it or ignores
 * it in silence — so a terminal-only copy can never be more than "asked for",
 * which is why the text is worth showing alongside either way.
 */
export async function copyToClipboard(
  text: string,
): Promise<{ via: "helper" | "terminal" }> {
  // Ask the terminal first. It's the route that survives SSH, and it costs a
  // few dozen bytes on stdout.
  try {
    process.stdout.write(osc52(text));
  } catch {
    // Closed or non-TTY stdout — a local helper may still manage it.
  }

  for (const [command, args] of localHelpers()) {
    if (await runHelper(command, args, text)) return { via: "helper" };
  }
  return { via: "terminal" };
}

/**
 * Wraps a URL as an OSC 8 hyperlink so terminals that support it make it
 * clickable. Ones that don't show the label and nothing else, because the
 * sequence is invisible to them — which is why this is safe unconditionally.
 */
export const hyperlink = (url: string, label = url): string =>
  `${ESC}]8;;${url}${ST}${label}${ESC}]8;;${ST}`;
