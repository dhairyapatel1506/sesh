import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "./socket";
import { useAuth } from "./auth";

type Limits = {
  enabled: boolean;
  minLength: number;
  maxLength: number;
  imageMaxBytes: number;
  maxImages?: number;
  retentionDays: number;
};

// The server enforces these and the form states them, so the two can never
// disagree about what's acceptable. Fetched once per page load and shared —
// both the landing page and a room can ask for them, and the answer is the
// same either way.
let limitsPromise: Promise<Limits | null> | null = null;
function fetchLimits(): Promise<Limits | null> {
  return (limitsPromise ??= fetch(`${API_BASE}/api/report/limits`)
    .then((res) => (res.ok ? (res.json() as Promise<Limits>) : null))
    .catch(() => {
      // An older server, or none reachable — behave exactly like reports off.
      limitsPromise = null; // a later mount may find it back up
      return null;
    }));
}

// A phone screenshot is a few megapixels and a desktop one can be 4K; sent as
// they are, most would be refused for size after someone had already written
// their report. Shrinking here means the attachment is small enough by the time
// anyone presses send, and 1600px is still enough to read a UI in.
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file didn't open as an image."));
    };
    img.src = url;
  });
}

async function shrink(blob: Blob): Promise<string> {
  const img = await loadImage(blob);
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser wouldn't let us process that image.");
  // JPEG has no transparency, and anything transparent composites onto black
  // by default — which turns a screenshot of dark text on a clear background
  // into a black rectangle. White is what such a screenshot was taken over.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

// What the server will actually receive, worked out from the base64 rather than
// the string length — four characters carry three bytes, minus the padding.
function dataUrlBytes(url: string): number {
  const base64 = url.slice(url.indexOf(",") + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

const asSize = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * The way in: a quiet link that opens the form. Renders nothing at all when the
 * server has no database to file reports in.
 */
export function ReportBug({
  roomId,
  name,
  placement = "below",
}: {
  roomId?: string;
  // The name this person goes by in the room, so a report says who sent it.
  name?: string;
  // "above" opens the panel upward and centred on the chip (the landing page,
  // where the chip sits at the bottom of the screen).
  placement?: "below" | "above";
}) {
  const [limits, setLimits] = useState<Limits | null>(null);
  const [open, setOpen] = useState(false);
  // Hover opens it; a click inside keeps it open until a click somewhere else
  // (or the X / Escape). Otherwise the thank-you after sending — which makes
  // the panel shrink out from under a pointer that's already left — is never
  // seen.
  const pinnedRef = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // The panel closes when the pointer leaves, always — it's a hover menu like
  // the others. What survives is the draft: whatever was typed is kept for
  // the session, so wandering off costs nothing and coming back resumes.
  // Cancel is the one thing that throws it away.
  // Held still deliberately. A room re-renders every second (the uptime clock),
  // and a closure recreated each time would restart the dialog's timers with
  // it — the thank-you would never get to the end of its two and a half
  // seconds, so the form would sit there having already been sent.
  const close = useCallback(() => {
    pinnedRef.current = false;
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) pinnedRef.current = true;
      else close();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, close]);

  useEffect(() => {
    let cancelled = false;
    void fetchLimits().then((value) => !cancelled && setLimits(value));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!limits?.enabled) return null;

  return (
    <div
      ref={menuRef}
      className={`feedback-menu hover-menu${placement === "above" ? " is-above" : ""}`}
      onPointerEnter={(event) => {
        // Hover opens it, the same as Friends and Invite. Touch has no hover,
        // so a tap still does.
        if (event.pointerType !== "touch") setOpen(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "touch" || pinnedRef.current) return;
        setOpen(false);
      }}
    >
      <button className="meta-chip report-link" onClick={() => {
          pinnedRef.current = true;
          setOpen(true);
        }}
        aria-expanded={open}>
        <span className="meta-label">Feedback</span>
      </button>
      {open && (
        <div className="feedback-popover">
          <ReportDialog limits={limits} roomId={roomId} name={name} onClose={close} />
        </div>
      )}
    </div>
  );
}

function ReportDialog({
  limits,
  roomId,
  name,
  onClose,
}: {
  limits: Limits;
  roomId?: string;
  name?: string;
  onClose: () => void;
}) {
  // One draft per kind, and the kind itself is remembered too: an idea
  // written under "Idea for a feature" must not turn up under "Something's
  // broken", and the panel reopens on whichever one was last in use.
  const KIND_KEY = "sesh-feedback-kind";
  const draftKey = (k: "bug" | "idea") => `sesh-feedback-draft-${k}`;
  const readDraft = (k: "bug" | "idea") => {
    try {
      return sessionStorage.getItem(draftKey(k)) ?? "";
    } catch {
      return "";
    }
  };
  const [kind, setKindState] = useState<"bug" | "idea">(() => {
    try {
      return sessionStorage.getItem(KIND_KEY) === "idea" ? "idea" : "bug";
    } catch {
      return "bug";
    }
  });
  const [drafts, setDrafts] = useState({ bug: readDraft("bug"), idea: readDraft("idea") });
  const text = drafts[kind];
  const setKind = (k: "bug" | "idea") => {
    setKindState(k);
    try {
      sessionStorage.setItem(KIND_KEY, k);
    } catch {
      // A private window keeps nothing; the form still works.
    }
    textRef.current?.focus();
  };
  const setText = (value: string) => {
    setDrafts((was) => ({ ...was, [kind]: value }));
    try {
      sessionStorage.setItem(draftKey(kind), value);
    } catch {
      // A private window keeps nothing; the form still works.
    }
  };
  const { user } = useAuth();
  // Signed out, a reply address is the only way to reach someone back — so
  // it's offered, and optional. Kept for the session like the draft.
  const [contact, setContact] = useState(() => {
    try {
      return sessionStorage.getItem("sesh-feedback-email") ?? "";
    } catch {
      return "";
    }
  });
  const contactOk = contact.trim() === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.trim());
  const [images, setImages] = useState<{ dataUrl: string; bytes: number }[]>([]);
  const maxImages = limits.maxImages ?? 1;
  const [imageError, setImageError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sent, setSent] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const canSend = text.trim().length >= limits.minLength && contactOk && !busy;

  useEffect(() => {
    textRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const imagesRef = useRef(images);
  imagesRef.current = images;

  // Adds as many as there's room for. An image that's still over the limit
  // after shrinking is refused with the reason rather than added and left to
  // block the send button.
  const attach = async (blobs: Blob[]) => {
    setImageError(null);
    const room = maxImages - imagesRef.current.length;
    if (room <= 0) {
      setImageError(`That's the most we take — ${maxImages} screenshots per report.`);
      return;
    }
    if (blobs.length > room) setImageError(`Only ${room} more fit — the rest were left out.`);
    const added: { dataUrl: string; bytes: number }[] = [];
    for (const blob of blobs.slice(0, room)) {
      try {
        const dataUrl = await shrink(blob);
        const bytes = dataUrlBytes(dataUrl);
        if (bytes > limits.imageMaxBytes) {
          setImageError(
            `One is still ${asSize(bytes)} after shrinking, over the ${asSize(limits.imageMaxBytes)} limit — try a crop of just the problem.`,
          );
          continue;
        }
        added.push({ dataUrl, bytes });
      } catch (err) {
        setImageError((err as Error).message);
      }
    }
    if (added.length > 0) setImages((was) => [...was, ...added].slice(0, maxImages));
  };

  // Ctrl+V of a screenshot is how people actually attach one, so it's listened
  // for on the window rather than on any one field — wherever the cursor
  // happens to be inside the form, the paste lands. Text pastes carry no file
  // and fall straight through to the textarea.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.items ?? [])]
        .filter((entry) => entry.kind === "file" && entry.type.startsWith("image/"))
        .map((entry) => entry.getAsFile())
        .filter((file): file is File => file !== null);
      if (files.length === 0) return;
      event.preventDefault();
      void attach(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  // A sent report needs no further form. The thank-you stays up long enough to
  // be read, and closing is also one click away for anyone who isn't waiting.
  useEffect(() => {
    if (!sent) return;
    const timer = window.setTimeout(onClose, 2500);
    return () => window.clearTimeout(timer);
  }, [sent, onClose]);

  const submit = async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Signed in, the report gets a name on it; anonymous, it's still filed.
        credentials: "include",
        body: JSON.stringify({
          text: text.trim(),
          kind,
          client: "web",
          ...(name ? { name } : {}),
          ...(!user && contact.trim() ? { contactEmail: contact.trim() } : {}),
          ...(roomId ? { roomId } : {}),
          ...(images.length > 0 ? { images: images.map((i) => i.dataUrl) } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      // The server's refusals are written to be read by a person — the
      // rate-limit ones especially — so they're shown as they arrive rather
      // than translated into something vaguer.
      if (!res.ok) {
        setError(data?.error ?? "Couldn't file that — try again in a moment.");
        return;
      }
      setSent(true);
      setDrafts((was) => ({ ...was, [kind]: "" }));
      try {
        sessionStorage.removeItem(draftKey(kind));
      } catch {
        // Nothing to clear in a window that kept nothing.
      }
    } catch {
      setError("Couldn't reach the server — check your connection.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="report-shell">
      <div
        className={dragging ? "report-dialog is-dragging" : "report-dialog"}
        role="dialog"
        aria-label="Send feedback"
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          // Moving between children fires dragleave on the one being left, so
          // only a leave of the dialog itself means the file is really gone.
          if (event.target === event.currentTarget) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const files = [...event.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
          if (files.length > 0) void attach(files);
        }}
      >
        {sent ? (
          <>
            <h2 className="report-title">Thanks — that's filed.</h2>
            <p className="report-lead">
              {kind === "bug"
                ? "We read these. Sorry about whatever it was."
                : "We read every one of these. Good ideas do get built."}
            </p>
            <div className="report-actions">
              <button onClick={onClose}>Close</button>
            </div>
          </>
        ) : (
          <>
            <div className="report-head">
              <h2 className="report-title">Send feedback</h2>
              <button className="report-x" onClick={onClose} aria-label="Close" title="Close">
                <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="report-kind" role="radiogroup" aria-label="What kind of feedback">
              <button
                className={kind === "bug" ? "is-on" : ""}
                role="radio"
                aria-checked={kind === "bug"}
                onClick={() => setKind("bug")}
              >
                🐞 Something's broken
              </button>
              <button
                className={kind === "idea" ? "is-on" : ""}
                role="radio"
                aria-checked={kind === "idea"}
                onClick={() => setKind("idea")}
              >
                💡 Idea for a feature
              </button>
            </div>
            <p className="report-lead">
              {kind === "bug"
                ? "What went wrong? A screenshot helps more than anything."
                : "What would you like Sesh to do? Sketches and screenshots are welcome."}
              {roomId && ` We'll include the room code (${roomId}).`}
            </p>

            <textarea
              ref={textRef}
              className="report-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={limits.maxLength}
              rows={5}
              placeholder={
                kind === "bug"
                  ? "What happened, and what you expected instead…"
                  : "What should it do, and when would you use it…"
              }
            />
            <p className="report-count">
              {text.trim().length < limits.minLength
                ? `At least ${limits.minLength} characters.`
                : `${text.trim().length} / ${limits.maxLength}`}
            </p>

            {!user && (
              <label className="report-email">
                <span>Your email, if you'd like a reply (optional)</span>
                <input
                  type="email"
                  value={contact}
                  maxLength={120}
                  autoComplete="email"
                  placeholder="you@example.com"
                  onChange={(e) => {
                    setContact(e.target.value);
                    try {
                      sessionStorage.setItem("sesh-feedback-email", e.target.value);
                    } catch {
                      // A private window keeps nothing; the form still works.
                    }
                  }}
                />
                {!contactOk && <span className="report-email-bad">That doesn't look like an email address.</span>}
              </label>
            )}
            {images.length > 0 && (
              <div className="report-thumbs">
                {images.map((image, n) => (
                  <div className="report-thumb" key={n}>
                    <img src={image.dataUrl} alt={`Attached screenshot ${n + 1}`} />
                    <span className="report-thumb-meta">{asSize(image.bytes)}</span>
                    <button
                      className="report-thumb-remove"
                      aria-label={`Remove screenshot ${n + 1}`}
                      onClick={() => {
                        setImages((was) => was.filter((_, i) => i !== n));
                        setImageError(null);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            {images.length < maxImages && (
              <button className="report-attach" onClick={() => fileInputRef.current?.click()}>
                {images.length === 0
                  ? maxImages > 1
                    ? `Attach screenshots (up to ${maxImages}) — or paste or drop them here`
                    : "Attach a screenshot — or paste or drop one here"
                  : `Add another (${images.length} of ${maxImages})`}
              </button>
            )}
            <input
              ref={fileInputRef}
              className="report-file"
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                if (files.length > 0) void attach(files);
                // Cleared so picking the same file twice in a row still fires.
                e.target.value = "";
              }}
            />

            {imageError && <p className="load-error report-error">{imageError}</p>}
            {error && <p className="load-error report-error">{error}</p>}

            <div className="report-actions">
              <button
                className="report-cancel"
                onClick={() => {
                  // Cancel means "forget it" — this kind's draft goes with it.
                  setText("");
                  setImages([]);
                  onClose();
                }}
              >
                Cancel
              </button>
              <button onClick={() => void submit()} disabled={!canSend}>
                {busy ? "Sending…" : "Send report"}
              </button>
            </div>
            <p className="report-retention">
              Kept for {limits.retentionDays} days, then deleted.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
