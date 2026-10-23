// TapToHearRubyBanner — surfaces a "Tap to hear Ruby" prompt when the
// browser refused autoplay (typically mobile Safari / mobile Chrome on
// the first audio of a session). Calling playPending() runs from inside
// the user's click handler, which satisfies the autoplay policy.

import { Volume2, X } from "lucide-react";
import { useAssistantName } from "@/lib/assistant-name";

interface Props {
  visible: boolean;
  preview: string | null;
  onPlay: () => void;
  onDismiss: () => void;
}

export function TapToHearRubyBanner({ visible, preview, onPlay, onDismiss }: Props) {
  const { name } = useAssistantName();
  if (!visible) return null;
  return (
    <div
      className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-100"
      role="status"
      aria-live="polite"
      data-testid="ruby-tap-to-hear-banner"
    >
      <Volume2 className="h-4 w-4 shrink-0 text-amber-300" />
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium leading-tight">Tap to hear {name}</div>
        {preview ? (
          <div className="truncate text-[11px] text-amber-200/80" title={preview}>
            {preview}
          </div>
        ) : (
          <div className="text-[11px] text-amber-200/80">
            Your browser blocked {name}&rsquo;s voice. Tap to play.
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onPlay}
        className="rounded-md border border-amber-400/60 bg-amber-500/20 px-2 py-1 text-[11px] font-medium hover:bg-amber-500/30"
        data-testid="ruby-tap-to-hear-play"
      >
        Play
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded-md p-1 text-amber-200/80 hover:text-amber-100"
        aria-label="Dismiss"
        data-testid="ruby-tap-to-hear-dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
