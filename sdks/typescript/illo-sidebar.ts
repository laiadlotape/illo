// illo-sidebar — minimal TypeScript / JavaScript client for the illo-sidebar daemon.
//
// No dependencies. Uses global fetch (Node 18+, all modern browsers). Targets
// the v0.2 protocol documented at docs/protocol.md. Errors are swallowed by
// default so a flaky daemon can never break the calling agent — pass
// `raiseOnError: true` to override.
//
// Example:
//   import { IlloSidebar } from "./illo-sidebar";
//   const c = new IlloSidebar({ port: 7821, agentId: "my-agent", agentKind: "codex" });
//   await c.ask({ question: "Approve deploy?", options: ["yes", "no"], urgency: "urgent" });
//   await c.notify({ message: "Long-running task done", urgency: "low" });
//   await c.heartbeat();

export type Urgency = "low" | "normal" | "urgent";

export interface IlloOptions {
  port?: number;
  host?: string;
  agentId: string;
  agentKind: string;
  sessionId?: string;
  timeoutMs?: number;
  raiseOnError?: boolean;
}

export interface AskArgs {
  question: string;
  options?: string[];
  urgency?: Urgency;
  transcript?: string;
  title?: string;
  snippet?: string;
  payload?: Record<string, unknown>;
  quickReplyEnabled?: boolean;
}

export interface NotifyArgs {
  message: string;
  urgency?: Urgency;
  subkind?: string;
  transcript?: string;
  payload?: Record<string, unknown>;
}

export class IlloSidebar {
  private readonly host: string;
  private readonly port: number;
  private readonly agentId: string;
  private readonly agentKind: string;
  private readonly sessionId?: string;
  private readonly timeoutMs: number;
  private readonly raiseOnError: boolean;

  constructor(opts: IlloOptions) {
    const envPort =
      typeof process !== "undefined" ? process.env?.ILLO_SIDEBAR_PORT : undefined;
    this.port = envPort ? Number(envPort) : opts.port ?? 7821;
    this.host = opts.host ?? "127.0.0.1";
    this.agentId = opts.agentId;
    this.agentKind = opts.agentKind;
    this.sessionId = opts.sessionId;
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.raiseOnError = opts.raiseOnError ?? false;
  }

  ask(args: AskArgs): Promise<unknown> {
    return this.postEvent({
      kind: "ask_user",
      tool_input: {
        questions: [
          {
            question: args.question,
            options: (args.options ?? []).map((label) => ({ label })),
          },
        ],
      },
      title: args.title,
      snippet: args.snippet,
      urgency: args.urgency ?? "normal",
      transcript_snapshot: args.transcript,
      quick_reply_enabled: args.quickReplyEnabled ?? true,
      payload: args.payload,
    });
  }

  notify(args: NotifyArgs): Promise<unknown> {
    return this.postEvent({
      kind: "notification",
      message: args.message,
      subkind: args.subkind,
      urgency: args.urgency ?? "normal",
      transcript_snapshot: args.transcript,
      payload: args.payload,
    });
  }

  custom(body: Record<string, unknown>): Promise<unknown> {
    return this.postEvent({ kind: "custom", ...body });
  }

  heartbeat(): Promise<unknown> {
    return this.postEvent({ kind: "heartbeat" });
  }

  private async postEvent(body: Record<string, unknown>): Promise<unknown> {
    const payload: Record<string, unknown> = { ...body };
    payload.agent_id = payload.agent_id ?? this.agentId;
    payload.agent_kind = payload.agent_kind ?? this.agentKind;
    if (this.sessionId && payload.session_id == null) {
      payload.session_id = this.sessionId;
    }
    for (const k of Object.keys(payload))
      if (payload[k] === undefined) delete payload[k];

    const url = `http://${this.host}:${this.port}/event`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const text = await res.text();
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        return text;
      }
    } catch (err) {
      if (this.raiseOnError) throw err;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
