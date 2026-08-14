/**
 * Safety boundary pre-filter for the ARX Assistant.
 *
 * Returns a refusal Answer when the user asks the assistant to:
 *   - recommend trades / pick a direction
 *   - bypass a safety lock (live-disabled, kill switch, risk lock)
 *   - force MT5 / disable Emergency Stop
 *
 * The refusal is friendly, redirects to safe alternatives, and never
 * pretends the assistant could perform the unsafe action.
 */
import type { Answer, AskContext } from "./answerEngine";
import { resolveRoute } from "./routeKnowledge";

interface RefusalRule {
  id: string;
  patterns: RegExp[];
  reply: string;
}

export const SAFETY_REFUSALS: RefusalRule[] = [
  {
    id: "refusal:trade-advice",
    patterns: [
      /\bwhat\s+(should|do)\s+i\s+(buy|sell|trade|enter)\b/i,
      /\bshould\s+i\s+(buy|sell|short|long|enter|exit)\b/i,
      /\bgive me a (trade|signal|tip|call)\b/i,
      /\bpick (a|the) (trade|direction|side)\b/i,
      /\bwhich (pair|symbol) (should|do) i\b/i,
      /\bshould i use real money\b/i,
      /\bgo live (now|today)?\b/i,
      /\bis\s+\w+\s+a\s+(buy|sell|long|short)\b/i,
      /\b(recommend|suggest|tell me)\b.*\b(entry|exit|sl|tp|stop\s*loss|take\s*profit|trade|direction|side)\b/i,
      /\bwhat'?s the best (pair|symbol|trade) (right )?now\b/i,
      /\bbuy\s+or\s+sell\b/i,
      /^\s*(buy|sell|short|long)\s+\w+/i,
      /\b(buy|sell|short|long)\b\s+\w+\s+(now|today|asap|immediately)\b/i,
      /\b(can|could|will|would|please)\s+(you\s+)?(buy|sell|short|long|trade|enter|place|open|execute|submit|send|fire)\b/i,
      /\b(buy|sell|short|long|trade|enter|place|open|execute)\b[^?.!\n]{0,40}\bfor\s+me\b/i,
      /\b(place|open|enter|execute|submit|send|fire)\s+(a\s+)?(trade|order|position|buy|sell|long|short)\b/i,
    ],
    reply:
      "I can explain ARX, your blockers, demo/sim mode, and risk controls — but I cannot recommend trades, pick a direction, or tell you to use real money. ARX is a demo-only educational app today; real broker execution requires the MT5 bridge and the guarded order router, which you control yourself.",
  },
  {
    id: "refusal:bypass-safety",
    patterns: [
      /\bbypass\b.*\b(safety|lock|kill\s*switch|guard|risk|emergency|paper|live)\b/i,
      /\boverride\b.*\b(safety|lock|kill|guard|risk|emergency)\b/i,
      /\bdisable\b.*\b(emergency\s*stop|kill\s*switch|risk\s*lock|safety)\b/i,
      /\bturn\s*off\b.*\b(emergency|kill\s*switch|safety|risk\s*lock)\b/i,
      /\bignore\b.*\b(risk|safety|lock|kill\s*switch|guard)\b/i,
      /\bskip\b.*\b(readiness|safety|kill\s*switch|guard)\b/i,
      /\b(enable|turn\s*on|switch\s*on|activate|start|begin)\b.*\blive\s*(trading|mode|exec)/i,
      /\bunlock\b.*\b(execution|live|broker|order|trading)\b/i,
      /\b(remove|clear|delete)\b.*\brisk\s*lock\b/i,
      /\bdefeat\b.*\b(safety|lock|guard|kill\s*switch)\b/i,
    ],
    reply:
      "I won't help bypass an ARX safety lock. Those locks (kill switch, risk lock, Emergency Stop, live-trading disable) protect your account and stay enforced server-side regardless of what the assistant says. The right move is to resolve the underlying setup or readiness gate — open the Readiness Checklist and I can walk you through the specific failing item.",
  },
  {
    id: "refusal:secret-disclosure",
    patterns: [
      /\b(reveal|show|print|leak|expose|give\s+me|what\s+is|tell\s+me)\b.*\b(api[\s_-]*keys?|secrets?|tokens?|passwords?|credentials?|env(ironment)?[\s_-]*vars?)\b/i,
      /\bMT5_BRIDGE_TOKEN\b/i,
      /\bDATABASE_URL\b/i,
    ],
    reply:
      "I won't reveal API keys, tokens, secrets, or environment variables. They're managed by the Replit secrets system and never exposed through the assistant. If you need to rotate one, do it from the Replit secrets panel — never paste it into chat.",
  },
  {
    id: "refusal:role-escalation",
    patterns: [
      /\b(change|set|make|grant|elevate|promote)\b.*\b(my|user|role)\b.*\b(owner|admin|tester|root|superuser)\b/i,
      /\b(give|grant)\s+me\s+(owner|admin|root)\b/i,
      /\bbecome\s+(owner|admin|root)\b/i,
    ],
    reply:
      "I can't change your role or grant elevated permissions. Roles are assigned server-side by an existing OWNER through the admin permissions page — the assistant has no authority to escalate access.",
  },
  {
    id: "refusal:skip-readiness",
    patterns: [
      /\b(ignore|skip|bypass|disable|turn\s*off)\b.*\breadiness\b/i,
      /\bproceed\s+without\s+readiness\b/i,
      /\bmark\s+readiness\s+(as\s+)?(complete|done|passed)\b/i,
    ],
    reply:
      "I won't help skip the readiness checklist. Each gate exists to prevent a specific class of mistake; the right move is to fix the failing gate, not bypass it. Open the Readiness Checklist and I can explain whichever item is red.",
  },
  {
    id: "refusal:force-mt5",
    patterns: [
      /\bforce\b.*\b(mt5|broker|order|live|execution)\b/i,
      /\bmake\b.*\b(mt5|broker)\b.*\b(send|place|execute|trade)\b/i,
      /\b(send|place)\b.*\b(real|live)\b.*\b(order|trade)\b/i,
    ],
    reply:
      "I can't force MT5 to send orders. Live broker execution is gated by the MT5 bridge connection plus the guarded order router — both server-side, both intentional. To progress, follow the documented bridge setup (MT5 Bridge → install EA → set MT5_BRIDGE_TOKEN → wait for heartbeat).",
  },
];

export function checkSafetyRefusal(question: string, ctx: AskContext): Answer | null {
  for (const rule of SAFETY_REFUSALS) {
    if (rule.patterns.some((p) => p.test(question))) {
      const candidates = [
        { label: "Readiness Checklist", route: "/readiness-checklist" },
        { label: "Help Center", route: "/help" },
        { label: "Emergency Stop", route: "/emergency" },
      ];
      const related = candidates.filter((r) => !!resolveRoute(r.route));
      return {
        answer: rule.reply,
        safety:
          "ARX safety locks are enforced server-side and cannot be bypassed by anything the assistant says.",
        sourceId: rule.id,
        matchType: "kb",
        confidence: 1,
        related,
        nextAction: related[0],
      } satisfies Answer;
    }
  }
  // ctx is unused today but reserved for future per-mode rules.
  void ctx;
  return null;
}
