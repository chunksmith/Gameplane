package prom

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := newWithHTTP(server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestQueryVectorDropsNonFinite(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/api/v1/query" || req.URL.Query().Get("query") != "up" {
			http.NotFound(w, req)
			return
		}
		_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"vector","result":[`+
			`{"metric":{"nodename":"n1"},"value":[1700000000,"1.5"]},`+
			`{"metric":{"nodename":"n2"},"value":[1700000000,"NaN"]},`+
			`{"metric":{"nodename":"n3"},"value":[1700000000,"+Inf"]}]}}`)
	})
	samples, err := client.Query(t.Context(), "up", time.Unix(1700000000, 0))
	if err != nil {
		t.Fatal(err)
	}
	if len(samples) != 1 || samples[0].Labels["nodename"] != "n1" || samples[0].Value != 1.5 {
		t.Fatalf("samples = %+v", samples)
	}
}

func TestQueryRangeMatrix(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Query().Get("step") != "60" {
			http.Error(w, "bad step", http.StatusBadRequest)
			return
		}
		_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"matrix","result":[`+
			`{"metric":{},"values":[[1700000000,"1"],[1700000060,"+Inf"],[1700000120,"2.5"]]}]}}`)
	})
	series, err := client.QueryRange(t.Context(), "sum(up)", time.Unix(1700000000, 0), time.Unix(1700000120, 0), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(series) != 1 || len(series[0].Points) != 2 {
		t.Fatalf("series = %+v", series)
	}
	if series[0].Points[0] != (Point{1700000000, 1}) || series[0].Points[1] != (Point{1700000120, 2.5}) {
		t.Fatalf("points = %+v", series[0].Points)
	}
}

func TestQueryErrorStatusIncludesBody(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"status":"error","errorType":"bad_data","error":"parse error"}`)
	})
	_, err := client.Query(t.Context(), "up{", time.Now())
	if err == nil || !strings.Contains(err.Error(), "bad_data") || !strings.Contains(err.Error(), "parse error") {
		t.Fatalf("err = %v", err)
	}
}

func TestQueryNon2xxIsError(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "upstream down", http.StatusServiceUnavailable)
	})
	if _, err := client.Query(t.Context(), "up", time.Now()); err == nil {
		t.Fatal("expected error for 503")
	}
}

func TestBasePathPrefixIsKept(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/prometheus/api/v1/query" {
			http.NotFound(w, req)
			return
		}
		_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"vector","result":[]}}`)
	}))
	t.Cleanup(server.Close)
	client, err := newWithHTTP(server.URL+"/prometheus", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Query(t.Context(), "up", time.Now()); err != nil {
		t.Fatal(err)
	}
}

func TestNewRejectsBadURLs(t *testing.T) {
	if client, err := New(""); client != nil || err != nil {
		t.Fatalf("New(\"\") = %v, %v", client, err)
	}
	if _, err := New("ftp://x"); err == nil {
		t.Fatal("New(ftp) accepted")
	}
	if _, err := New("http://"); err == nil {
		t.Fatal("New(no host) accepted")
	}
}

func TestQuoteEscapes(t *testing.T) {
	if got := Quote("a\"b\\c\nd"); got != `"a\"b\\c\nd"` {
		t.Fatalf("Quote = %s", got)
	}
}
