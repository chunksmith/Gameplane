package handlers

import (
	"slices"
	"strings"
	"testing"
)

func TestAILinearIssuePrompt(t *testing.T) {
	if got := aiLinearIssuePrompt("", []string{"linear_save_comment", "linear_save_issue"}); got != "" {
		t.Fatalf("prompt without issue = %q", got)
	}
	full := aiLinearIssuePrompt("CHK-142", []string{"linear_save_comment", "linear_save_issue"})
	if !strings.Contains(full, "CHK-142") || !strings.Contains(full, "build_start") || strings.Contains(full, "cannot") {
		t.Fatalf("full prompt = %q", full)
	}
	bare := aiLinearIssuePrompt("CHK-142", nil)
	if !strings.Contains(bare, "cannot post comments") || !strings.Contains(bare, "cannot change Linear issues") {
		t.Fatalf("bare prompt = %q", bare)
	}
}

func TestAIStartedState(t *testing.T) {
	states := []aiLinearState{
		{ID: "s-review", Type: "started", Name: "In Review"},
		{ID: "s-done", Type: "completed", Name: "Done"},
		{ID: "s-progress", Type: "started", Name: "In Progress"},
		{ID: "s-todo", Type: "unstarted", Name: "Todo"},
	}
	if got := aiStartedState(states); got != "s-progress" {
		t.Fatalf("started state = %q", got)
	}
	if got := aiStartedState(states[:1]); got != "s-review" {
		t.Fatalf("only review state = %q", got)
	}
	if got := aiStartedState(nil); got != "" {
		t.Fatalf("no states = %q", got)
	}
}

func TestAICLIArgsLinearIssue(t *testing.T) {
	conv := aiConversation{Repository: "r", Namespace: "n", LinearIssue: "CHK-1", Model: "m", Effort: "medium", Mode: "default"}
	args := aiCLIArgs(conv, "", "", false, "linear_save_comment")
	i := slices.Index(args, "--append-system-prompt")
	if i < 0 || !strings.Contains(args[i+1], "Linear issue CHK-1") {
		t.Fatalf("system prompt does not name the issue: %v", args)
	}
}
