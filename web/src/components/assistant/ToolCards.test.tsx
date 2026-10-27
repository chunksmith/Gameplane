import { describe, it, expect, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithQuery } from "@/test/render";
import { Assistant, type AssistantBlock } from "@/lib/assistant";
import { BackgroundActions, PlanCard, QuestionCard, SubagentCard, TasksCard } from "./ToolCards";

const askBlock: AssistantBlock = {
  type: "tool_use",
  id: "q1",
  name: "ask_user",
  input: { question: "Which region?", options: [{ label: "eu" }, { label: "us", description: "US East" }] },
};

const planBlock: AssistantBlock = { type: "tool_use", id: "p1", name: "propose_plan", input: { plan: "1. Read the config\n2. Change the motd" } };

describe("ToolCards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the task list with its progress", () => {
    renderWithQuery(
      <TasksCard
        todos={[
          { content: "Read config", status: "completed" },
          { content: "Write motd", status: "in_progress" },
        ]}
      />,
    );
    expect(screen.getByText("Tasks")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 done")).toBeInTheDocument();
    expect(screen.getByText("Write motd")).toBeInTheDocument();
  });

  it("shows a running subagent and a finished one with their steps", () => {
    const task: AssistantBlock = { type: "tool_use", id: "t1", name: "Task", input: { description: "Scan plugins", subagent_type: "explore" } };
    const { unmount } = renderWithQuery(
      <ul>
        <SubagentCard block={task} running count={3}>
          <li>step</li>
        </SubagentCard>
      </ul>,
    );
    expect(screen.getByText("Running · 3 steps")).toBeInTheDocument();
    expect(screen.getByText("Scan plugins")).toBeInTheDocument();
    unmount();
    renderWithQuery(
      <ul>
        <SubagentCard block={task} result={{ type: "tool_result", tool_use_id: "t1", content: "done" }} running={false} count={1}>
          <li>step</li>
        </SubagentCard>
      </ul>,
    );
    expect(screen.getByText("1 step")).toBeInTheDocument();
  });

  it("sends the picked option as the answer", async () => {
    const answer = vi.spyOn(Assistant, "answer").mockResolvedValue(undefined);
    renderWithQuery(
      <ul>
        <QuestionCard block={askBlock} conversationId="c1" interactive />
      </ul>,
    );
    await userEvent.click(screen.getByRole("radio", { name: /^us/ }));
    await userEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith("c1", "us"));
  });

  it("skips the question with an empty answer", async () => {
    const answer = vi.spyOn(Assistant, "answer").mockResolvedValue(undefined);
    renderWithQuery(
      <ul>
        <QuestionCard block={askBlock} conversationId="c1" interactive />
      </ul>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith("c1", ""));
  });

  it("disables the question controls when it is not waiting", () => {
    renderWithQuery(
      <ul>
        <QuestionCard block={askBlock} conversationId="c1" interactive={false} />
      </ul>,
    );
    expect(screen.getByRole("button", { name: "Skip" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send answer" })).toBeDisabled();
  });

  it("approves or keeps planning", async () => {
    const onDecide = vi.fn();
    renderWithQuery(
      <ul>
        <PlanCard block={planBlock} interactive deciding={false} onDecide={onDecide} />
      </ul>,
    );
    expect(screen.getByText("Plan mode · nothing changed yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep planning" }));
    expect(onDecide.mock.calls).toEqual([[true], [false]]);
  });

  it("shows the output of a background job and stops it", async () => {
    const stop = vi.spyOn(Assistant, "stopJob").mockResolvedValue(undefined);
    const scope = { server: "lobby", namespace: "games" };
    renderWithQuery(<BackgroundActions scope={scope} jobId="0123456789ab" status={{ state: "running", output: "tick 3" }} own />);
    await userEvent.click(screen.getByRole("button", { name: "Show output" }));
    expect(screen.getByText("tick 3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(stop).toHaveBeenCalledWith(scope, "0123456789ab"));
  });
});
