import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Checkbox, Input, Radio, RadioGroup, TextField } from "@heroui/react";
import { Check, Circle, Loader2 } from "lucide-react";
import { defineMessages } from "react-intl";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Markdown } from "@/components/assistant/Markdown";
import { Assistant, resultText, type AssistantBlock, type AssistantScope, type AssistantTodo, type JobStatus } from "@/lib/assistant";
import { useOptionalIntl } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";

const TASK_MESSAGES = defineMessages({
  title: { id: "web.components.assistant.tool_cards.tasks", defaultMessage: "Tasks", description: "Assistant tool card: heading of the task list the assistant keeps while it works; keep it short" },
});

function TodoIcon({ status }: { status: AssistantTodo["status"] }) {
  if (status === "completed") return <Check aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />;
  if (status === "in_progress") return <Loader2 aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-accent" />;
  return <Circle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />;
}

export function TasksCard({ todos }: { todos: AssistantTodo[] }) {
  const intl = useOptionalIntl();
  const done = todos.filter((todo) => todo.status === "completed").length;
  return (
    <div className="rounded-2xl border border-border bg-surface-secondary/60 p-4 text-xs">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">{intl.formatMessage(TASK_MESSAGES.title)}</span>
        <span className="text-muted">{intl.formatMessage({ id: "web.components.assistant.tool_cards.tasks_progress", defaultMessage: "{done} of {total} done", description: "Assistant tool card: count of finished tasks in the task list; {done} and {total} are numbers" }, { done, total: todos.length })}</span>
      </div>
      <ul className="space-y-2">
        {todos.map((todo, index) => (
          <li key={index} className="flex items-start gap-2">
            <TodoIcon status={todo.status} />
            <span className={cn(todo.status === "completed" && "text-muted line-through", todo.status === "in_progress" && "font-medium text-foreground", todo.status === "pending" && "text-muted")}>
              {todo.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const SUBAGENT_MESSAGES = defineMessages({
  label: { id: "web.components.assistant.tool_cards.subagent", defaultMessage: "Subagent", description: "Assistant tool card: heading of a card for a subagent the assistant started; keep it short" },
});

export function SubagentCard({ block, result, running, count, children }: { block: AssistantBlock; result?: AssistantBlock; running: boolean; count: number; children: ReactNode }) {
  const intl = useOptionalIntl();
  const input = block.input ?? {};
  return (
    <li className="overflow-hidden rounded-xl border border-border bg-surface-secondary/60 text-xs">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span className="shrink-0 font-medium text-foreground">{intl.formatMessage(SUBAGENT_MESSAGES.label)}</span>
        <span className="shrink-0 text-muted">{String(input.subagent_type ?? "")}</span>
        <span className="min-w-0 flex-1 truncate text-foreground">{String(input.description ?? "")}</span>
        {result && (
          <span className="inline-flex shrink-0 items-center gap-1 font-medium text-success">
            <Check aria-hidden="true" className="h-3 w-3" />
            {intl.formatMessage({ id: "web.components.assistant.tool_cards.subagent_done", defaultMessage: "{count, plural, one {# step} other {# steps}}", description: "Assistant tool card: finished subagent with its number of steps; {count} is the number of steps" }, { count })}
          </span>
        )}
        {!result && running && (
          <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-accent">
            <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            {intl.formatMessage({ id: "web.components.assistant.tool_cards.subagent_running", defaultMessage: "Running · {count, plural, one {# step} other {# steps}}", description: "Assistant tool card: subagent still running with its number of steps so far; {count} is the number of steps" }, { count })}
          </span>
        )}
      </div>
      {count > 0 && <ul className="space-y-1.5 border-t border-border px-3 py-2 pl-6">{children}</ul>}
    </li>
  );
}

const QUESTION_MESSAGES = defineMessages({
  label: { id: "web.components.assistant.tool_cards.question", defaultMessage: "Question", description: "Assistant tool card: label above a question the assistant asks the user; keep it short" },
  other: { id: "web.components.assistant.tool_cards.other_answer", defaultMessage: "Other answer…", description: "Assistant tool card: placeholder of the free-text answer box under the options of a question; keep it short" },
  send: { id: "web.components.assistant.tool_cards.send_answer", defaultMessage: "Send answer", description: "Assistant tool card: button that sends the chosen answer to a question; keep it short" },
  skip: { id: "web.components.assistant.tool_cards.skip", defaultMessage: "Skip", description: "Assistant tool card: button that skips a question without answering; keep it short" },
});

interface AskOption {
  label: string;
  description: string;
}

function askOf(block: AssistantBlock) {
  const input = block.input ?? {};
  const options: AskOption[] = Array.isArray(input.options)
    ? input.options.map((option: { label?: unknown; description?: unknown }) => ({
        label: String(option.label ?? ""),
        description: typeof option.description === "string" ? option.description : "",
      }))
    : [];
  return { question: String(input.question ?? ""), options, multi: input.multi_select === true };
}

export function QuestionCard({ block, result, conversationId, interactive }: { block: AssistantBlock; result?: AssistantBlock; conversationId: string; interactive: boolean }) {
  const intl = useOptionalIntl();
  const qc = useQueryClient();
  const { question, options, multi } = askOf(block);
  const [picked, setPicked] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const answer = useMutation({
    mutationFn: (value: string) => Assistant.answer(conversationId, value),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["ai"] }),
  });
  const typed = other.trim();
  const answerText = (multi ? [...picked, typed] : [typed || (picked[0] ?? "")]).filter(Boolean).join(", ");
  const disabled = !interactive || answer.isPending;

  return (
    <li className="overflow-hidden rounded-2xl border border-accent/30 bg-surface-secondary/60 p-4 text-sm">
      <span className="text-xs font-medium text-accent">{intl.formatMessage(QUESTION_MESSAGES.label)}</span>
      <p className="mt-1 text-foreground">{question}</p>
      {result ? (
        <p className="mt-2 text-xs text-muted">{resultText(result)}</p>
      ) : (
        <div className="mt-3 space-y-3">
          {multi ? (
            <div className="space-y-2">
              {options.map((option) => (
                <Checkbox
                  key={option.label}
                  isSelected={picked.includes(option.label)}
                  isDisabled={disabled}
                  onChange={(checked: boolean) => setPicked(checked ? [...picked, option.label] : picked.filter((label) => label !== option.label))}
                  className="flex-row items-center gap-2"
                >
                  <Checkbox.Control className="size-4">
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <Checkbox.Content>
                    <span className="font-medium">{option.label}</span>
                    {option.description && <span className="block text-xs text-muted">{option.description}</span>}
                  </Checkbox.Content>
                </Checkbox>
              ))}
            </div>
          ) : (
            <RadioGroup aria-label={question} value={picked[0] ?? ""} onChange={(value) => setPicked([value])} isDisabled={disabled} className="space-y-2">
              {options.map((option) => (
                <Radio key={option.label} value={option.label}>
                  <Radio.Control />
                  <Radio.Content>
                    <span className="font-medium">{option.label}</span>
                    {option.description && <span className="block text-xs text-muted">{option.description}</span>}
                  </Radio.Content>
                </Radio>
              ))}
            </RadioGroup>
          )}
          <TextField aria-label={intl.formatMessage(QUESTION_MESSAGES.other)} value={other} onChange={setOther} isDisabled={disabled}>
            <Input placeholder={intl.formatMessage(QUESTION_MESSAGES.other)} />
          </TextField>
          {answer.error && <ErrorBanner err={answer.error} />}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" size="sm" isDisabled={disabled} onPress={() => answer.mutate("")}>{intl.formatMessage(QUESTION_MESSAGES.skip)}</Button>
            <Button variant="primary" size="sm" isDisabled={disabled || !answerText} onPress={() => answer.mutate(answerText)}>{intl.formatMessage(QUESTION_MESSAGES.send)}</Button>
          </div>
        </div>
      )}
    </li>
  );
}

const PLAN_MESSAGES = defineMessages({
  label: { id: "web.components.assistant.tool_cards.plan", defaultMessage: "Plan", description: "Assistant tool card: heading of a plan the assistant proposes before making changes; keep it short" },
  ready: { id: "web.components.assistant.tool_cards.plan_ready", defaultMessage: "Ready for your approval", description: "Assistant tool card: text under the Plan heading while the plan waits for the user's approval; keep it short" },
  note: { id: "web.components.assistant.tool_cards.plan_note", defaultMessage: "Plan mode · nothing changed yet", description: "Assistant tool card: warning note on a plan that waits for approval, saying the assistant has not changed anything yet; keep it short" },
  approve: { id: "web.components.assistant.tool_cards.approve_plan", defaultMessage: "Approve plan", description: "Assistant tool card: button that approves the proposed plan so the assistant carries it out; keep it short" },
  keep: { id: "web.components.assistant.tool_cards.keep_planning", defaultMessage: "Keep planning", description: "Assistant tool card: button that declines the proposed plan so the assistant keeps planning; keep it short" },
});

export function PlanCard({ block, result, interactive, deciding, onDecide }: { block: AssistantBlock; result?: AssistantBlock; interactive: boolean; deciding: boolean; onDecide: (approve: boolean) => void }) {
  const intl = useOptionalIntl();
  const plan = String(block.input?.plan ?? "");
  return (
    <li className="overflow-hidden rounded-2xl border border-border bg-surface-secondary/60 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-medium text-foreground">{intl.formatMessage(PLAN_MESSAGES.label)}</span>
          <span className="truncate text-xs text-muted">{result ? resultText(result) : intl.formatMessage(PLAN_MESSAGES.ready)}</span>
        </div>
        {!result && <span className="rounded-full bg-warning-soft px-2.5 py-0.5 text-xs text-warning-soft-foreground">{intl.formatMessage(PLAN_MESSAGES.note)}</span>}
      </div>
      <div className="px-4 py-3">
        <Markdown text={plan} />
      </div>
      {interactive && (
        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4 py-3">
          <Button variant="ghost" size="sm" isDisabled={deciding} onPress={() => onDecide(false)}>{intl.formatMessage(PLAN_MESSAGES.keep)}</Button>
          <Button variant="primary" size="sm" isDisabled={deciding} onPress={() => onDecide(true)}>{intl.formatMessage(PLAN_MESSAGES.approve)}</Button>
        </div>
      )}
    </li>
  );
}

const BACKGROUND_MESSAGES = defineMessages({
  show: { id: "web.components.assistant.tool_cards.show_output", defaultMessage: "Show output", description: "Assistant tool card: button that shows the latest output of a background command; keep it short" },
  hide: { id: "web.components.assistant.tool_cards.hide_output", defaultMessage: "Hide output", description: "Assistant tool card: button that hides the output of a background command; keep it short" },
  stop: { id: "web.components.assistant.tool_cards.stop_job", defaultMessage: "Stop", description: "Assistant tool card: button that stops a background command still running; keep it short" },
});

export function BackgroundActions({ scope, jobId, status, own }: { scope: AssistantScope; jobId: string; status?: JobStatus; own: boolean }) {
  const intl = useOptionalIntl();
  const qc = useQueryClient();
  const [showOutput, setShowOutput] = useState(false);
  const stop = useMutation({
    mutationFn: () => Assistant.stopJob(scope, jobId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["ai"] }),
  });
  const canStop = own && Boolean(scope.server) && (!status || status.state === "running");
  return (
    <div className="space-y-2 pl-6 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" aria-expanded={showOutput} onPress={() => setShowOutput(!showOutput)}>
          {intl.formatMessage(showOutput ? BACKGROUND_MESSAGES.hide : BACKGROUND_MESSAGES.show)}
        </Button>
        {canStop && (
          <Button size="sm" variant="danger-soft" isDisabled={stop.isPending} onPress={() => stop.mutate()}>{intl.formatMessage(BACKGROUND_MESSAGES.stop)}</Button>
        )}
      </div>
      {stop.error && <ErrorBanner err={stop.error} />}
      {showOutput && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-border px-3 py-2 font-mono text-[11px] text-muted scrollbar-thin">{status?.output ?? ""}</pre>}
    </div>
  );
}
