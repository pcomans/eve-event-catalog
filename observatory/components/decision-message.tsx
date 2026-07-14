import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Badge } from "@/components/ui/badge";
import type { EveMessage, EveMessagePart } from "eve/client";

// EveDynamicToolPart's `state` union is deliberately the same one
// ai-elements' Tool component expects (both follow the AI SDK dynamic-tool
// convention) — no adaptation needed beyond passing the fields straight
// through.
function DecisionPart({ part }: { part: EveMessagePart }) {
  switch (part.type) {
    case "text":
      return <MessageResponse>{part.text}</MessageResponse>;
    case "reasoning":
      return (
        <Reasoning isStreaming={part.state === "streaming"}>
          <ReasoningTrigger />
          <ReasoningContent>{part.text}</ReasoningContent>
        </Reasoning>
      );
    case "dynamic-tool":
      return (
        <Tool>
          <ToolHeader state={part.state} toolName={part.toolName} type="dynamic-tool" />
          <ToolContent>
            <ToolInput input={part.input} />
            {(part.state === "output-available" || part.state === "output-error") && (
              <ToolOutput errorText={part.errorText} output={part.output} />
            )}
          </ToolContent>
        </Tool>
      );
    // Structural markers and part types this trading agent doesn't produce
    // (file attachments, interactive OAuth authorization) — rendered as a
    // small fallback badge rather than silently dropped, so nothing here
    // can vanish without a trace the way observe-page.ts's original
    // unknown-type bug did.
    case "step-start":
      return null;
    case "file":
      return (
        <Badge className="text-xs" variant="outline">
          file: {part.filename ?? part.mediaType}
        </Badge>
      );
    case "authorization":
      return (
        <Badge className="text-xs" variant="outline">
          authorization: {part.displayName} ({part.state})
        </Badge>
      );
  }
}

export function DecisionMessage({ message }: { message: EveMessage }) {
  return (
    <Message from={message.role}>
      <MessageContent>
        {message.parts.map((part, i) => (
          // Parts have no stable id of their own; index is fine here since
          // this array is only ever appended-to within a message, never reordered.
          <DecisionPart key={i} part={part} />
        ))}
      </MessageContent>
    </Message>
  );
}
