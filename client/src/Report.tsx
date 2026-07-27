import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "./socket";

type Limits = {
  enabled: boolean;
  minLength: number;
  maxLength: number;
  imageMaxBytes: number;
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
export function ReportBug({ roomId }: { roomId?: string }) {
  const [limits, setLimits] = useState<Limits | null>(null);
  const [open, setOpen] = useState(false);
  // Held still deliberately. A room re-renders every second (the uptime clock),
  // and a closure recreated each time would restart the dialog's timers with
  // it — the thank-you would never get to the end of its two and a half
  // seconds, so the form would sit there having already been sent.
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    let cancelled = false;
    void fetchLimits().then((value) => !cancelled && setLimits(value));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!limits?.enabled) return null;

  return (
    <>
      <button className="report-link" onClick={() => setOpen(true)}>
        Report a bug
      </button>
      {open && <ReportDialog limits={limits} roomId={roomId} onClose={close} />}
    </>
  );
}

function ReportDialog({
  limits,
  roomId,
  onClose,
}: {
  limits: Limits;
  roomId?: string;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [image, setImage] = useState<{ dataUrl: string; bytes: number } | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sent, setSent] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const tooLong = image !== null && image.bytes > limits.imageMaxBytes;
  const canSend = text.trim().length >= limits.minLength && !tooLong && !busy;

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

  const attach = async (blob: Blob) => {
    setImageError(null);
    try {
      const dataUrl = await shrink(blob);
      const bytes = dataUrlBytes(dataUrl);
      setImage({ dataUrl, bytes });
      // Even shrunk, a very large or very noisy screenshot can land over the
      // limit. Saying so now is the whole point of checking here: the server
      // would refuse it, and it would refuse it after the report was typed.
      if (bytes > limits.imageMaxBytes) {
        setImageError(
          `That's still ${asSize(bytes)} after shrinking, over the ${asSize(limits.imageMaxBytes)} limit — try a crop of just the problem.`,
        );
      }
    } catch (err) {
      setImage(null);
      setImageError((err as Error).message);
    }
  };

  // Ctrl+V of a screenshot is how people actually attach one, so it's listened
  // for on the window rather than on any one field — wherever the cursor
  // happens to be inside the form, the paste lands. Text pastes carry no file
  // and fall straight through to the textarea.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const item = [...(event.clipboardData?.items ?? [])].find(
        (entry) => entry.kind === "file" && entry.type.startsWith("image/"),
      );
      const file = item?.getAsFile();
      if (!file) return;
      event.preventDefault();
      void attach(file);
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
          client: "web",
          ...(roomId ? { roomId } : {}),
          ...(image ? { image: image.dataUrl } : {}),
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
    } catch {
      setError("Couldn't reach the server — check your connection.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="report-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={dragging ? "report-dialog is-dragging" : "report-dialog"}
        role="dialog"
        aria-modal="true"
        aria-label="Report a bug"
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
          const file = event.dataTransfer.files[0];
          if (file) void attach(file);
        }}
      >
        {sent ? (
          <>
            <h2 className="report-title">Thanks — that's filed.</h2>
            <p className="report-lead">We read these. Sorry about whatever it was.</p>
            <div className="report-actions">
              <button onClick={onClose}>Close</button>
            </div>
          </>
        ) : (
          <>
            <h2 className="report-title">Report a bug</h2>
            <p className="report-lead">
              What went wrong? A screenshot helps more than anything.
              {roomId && ` We'll include the room code (${roomId}).`}
            </p>

            <textarea
              ref={textRef}
              className="report-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={limits.maxLength}
              rows={5}
              placeholder="What happened, and what you expected instead…"
            />
            <p className="report-count">
              {text.trim().length < limits.minLength
                ? `At least ${limits.minLength} characters.`
                : `${text.trim().length} / ${limits.maxLength}`}
            </p>

            {image ? (
              <div className="report-thumb">
                <img src={image.dataUrl} alt="Attached screenshot" />
                <span className="report-thumb-meta">{asSize(image.bytes)}</span>
                <button
                  className="report-thumb-remove"
                  aria-label="Remove the screenshot"
                  onClick={() => {
                    setImage(null);
                    setImageError(null);
                  }}
                >
                  ✕
                </button>
              </div>
            ) : (
              <button className="report-attach" onClick={() => fileInputRef.current?.click()}>
                Attach a screenshot — or paste or drop one here
              </button>
            )}
            <input
              ref={fileInputRef}
              className="report-file"
              type="file"
              accept="image/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void attach(file);
                // Cleared so picking the same file twice in a row still fires.
                e.target.value = "";
              }}
            />

            {imageError && <p className="load-error report-error">{imageError}</p>}
            {error && <p className="load-error report-error">{error}</p>}

            <div className="report-actions">
              <button className="report-cancel" onClick={onClose}>
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
