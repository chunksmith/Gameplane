package controller

import (
	"errors"
	"strings"
	"testing"
)

func TestParseResticSummary_HappyPath(t *testing.T) {
	// A representative slice of restic --json output. Real restic
	// interleaves status updates, then ends with a summary line.
	logs := strings.Join([]string{
		`{"message_type":"status","percent_done":0.1,"total_files":42}`,
		`{"message_type":"status","percent_done":0.5,"total_files":42}`,
		`{"message_type":"verbose_status","action":"new","item":"/data/world"}`,
		`{"message_type":"summary","files_new":42,"files_changed":0,"files_unmodified":0,"dirs_new":1,"snapshot_id":"3d8a2c91","total_bytes_processed":1048576,"total_duration":2.5}`,
	}, "\n")

	got, err := ParseResticSummary(strings.NewReader(logs))
	if err != nil {
		t.Fatalf("ParseResticSummary: %v", err)
	}
	if got.SnapshotID != "3d8a2c91" {
		t.Errorf("SnapshotID = %q, want %q", got.SnapshotID, "3d8a2c91")
	}
	if got.TotalBytesProcessed != 1048576 {
		t.Errorf("TotalBytesProcessed = %d, want 1048576", got.TotalBytesProcessed)
	}
}

func TestParseResticSummary_LastSummaryWins(t *testing.T) {
	// If somehow two summary lines appear (e.g. retried run within the
	// same pod), we pick the last one — that's the result of the run
	// that actually completed.
	logs := strings.Join([]string{
		`{"message_type":"summary","snapshot_id":"first","total_bytes_processed":100}`,
		`{"message_type":"status","percent_done":0.9}`,
		`{"message_type":"summary","snapshot_id":"second","total_bytes_processed":200}`,
	}, "\n")

	got, err := ParseResticSummary(strings.NewReader(logs))
	if err != nil {
		t.Fatalf("ParseResticSummary: %v", err)
	}
	if got.SnapshotID != "second" {
		t.Errorf("SnapshotID = %q, want %q", got.SnapshotID, "second")
	}
	if got.TotalBytesProcessed != 200 {
		t.Errorf("TotalBytesProcessed = %d, want 200", got.TotalBytesProcessed)
	}
}

func TestParseResticSummary_NoSummary(t *testing.T) {
	logs := strings.Join([]string{
		`{"message_type":"status","percent_done":0.1}`,
		`{"message_type":"status","percent_done":0.2}`,
	}, "\n")

	_, err := ParseResticSummary(strings.NewReader(logs))
	if !errors.Is(err, ErrNoResticSummary) {
		t.Errorf("err = %v, want ErrNoResticSummary", err)
	}
}

func TestParseResticSummary_TolerantToNonJSON(t *testing.T) {
	// restic occasionally prints free-form text on stderr that lands
	// in the same log stream (e.g. CA cert warnings). The parser must
	// skip them, not abort.
	logs := strings.Join([]string{
		`Loading repository config...`,
		`{"message_type":"status","percent_done":0.5}`,
		``,
		`{"message_type":"summary","snapshot_id":"abcd1234","total_bytes_processed":42}`,
		`Done.`,
	}, "\n")

	got, err := ParseResticSummary(strings.NewReader(logs))
	if err != nil {
		t.Fatalf("ParseResticSummary: %v", err)
	}
	if got.SnapshotID != "abcd1234" || got.TotalBytesProcessed != 42 {
		t.Errorf("got = %+v", got)
	}
}

func TestParseResticSummary_MalformedJSONIgnored(t *testing.T) {
	logs := strings.Join([]string{
		`{"message_type":"status","percent`,             // truncated
		`{"message_type":"summary","snapshot_id":"ok"}`, // valid
	}, "\n")
	got, err := ParseResticSummary(strings.NewReader(logs))
	if err != nil {
		t.Fatalf("ParseResticSummary: %v", err)
	}
	if got.SnapshotID != "ok" {
		t.Errorf("got %+v", got)
	}
}

func TestResticSummary_AddedBytes(t *testing.T) {
	cases := []struct {
		summary ResticSummary
		want    int64
	}{
		{ResticSummary{DataAdded: 4096, DataAddedPacked: 1024}, 1024},
		{ResticSummary{DataAdded: 4096}, 4096},
		{ResticSummary{}, 0},
	}
	for _, c := range cases {
		if got := c.summary.addedBytes(); got != c.want {
			t.Errorf("addedBytes(%+v) = %d, want %d", c.summary, got, c.want)
		}
	}
}
