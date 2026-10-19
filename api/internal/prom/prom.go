package prom

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/GameplanePanel/gameplane/netguard"
)

const maxResponseBytes = 32 << 20

// Point is one [unixSeconds, value] sample.
type Point [2]float64

// Sample is one instant-vector element.
type Sample struct {
	Labels map[string]string
	Value  float64
}

// Series is one range-vector element.
type Series struct {
	Labels map[string]string
	Points []Point
}

// Client queries the Prometheus HTTP API.
type Client struct {
	base *url.URL
	http *http.Client
}

// New returns a client for rawURL, or nil when rawURL is empty.
func New(rawURL string) (*Client, error) {
	if rawURL == "" {
		return nil, nil
	}
	return newWithHTTP(rawURL, netguard.HTTPClient(10*time.Second, netguard.IsAllowed))
}

func newWithHTTP(rawURL string, httpClient *http.Client) (*Client, error) {
	base, err := url.Parse(rawURL)
	if err != nil {
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			err = urlErr.Err
		}
		return nil, fmt.Errorf("parse prometheus url: %w", err)
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return nil, errors.New("prometheus url must use http or https")
	}
	if base.Host == "" {
		return nil, errors.New("prometheus url has no host")
	}
	return &Client{base: base, http: httpClient}, nil
}

// Query runs an instant query at the given time.
func (c *Client) Query(ctx context.Context, expr string, at time.Time) ([]Sample, error) {
	data, err := c.get(ctx, "/api/v1/query", url.Values{"query": {expr}, "time": {unixParam(at)}})
	if err != nil {
		return nil, err
	}
	var body struct {
		Result []struct {
			Metric map[string]string `json:"metric"`
			Value  rawPoint          `json:"value"`
		} `json:"result"`
	}
	if err := json.Unmarshal(data, &body); err != nil {
		return nil, fmt.Errorf("decode prometheus vector: %w", err)
	}
	samples := make([]Sample, 0, len(body.Result))
	for _, item := range body.Result {
		if point, ok := item.Value.point(); ok {
			samples = append(samples, Sample{Labels: item.Metric, Value: point[1]})
		}
	}
	return samples, nil
}

// QueryRange runs a range query between start and end at step.
func (c *Client) QueryRange(ctx context.Context, expr string, start, end time.Time, step time.Duration) ([]Series, error) {
	data, err := c.get(ctx, "/api/v1/query_range", url.Values{
		"query": {expr},
		"start": {unixParam(start)},
		"end":   {unixParam(end)},
		"step":  {strconv.FormatFloat(step.Seconds(), 'f', -1, 64)},
	})
	if err != nil {
		return nil, err
	}
	var body struct {
		Result []struct {
			Metric map[string]string `json:"metric"`
			Values []rawPoint        `json:"values"`
		} `json:"result"`
	}
	if err := json.Unmarshal(data, &body); err != nil {
		return nil, fmt.Errorf("decode prometheus matrix: %w", err)
	}
	series := make([]Series, 0, len(body.Result))
	for _, item := range body.Result {
		points := make([]Point, 0, len(item.Values))
		for _, value := range item.Values {
			if point, ok := value.point(); ok {
				points = append(points, point)
			}
		}
		series = append(series, Series{Labels: item.Metric, Points: points})
	}
	return series, nil
}

var quoter = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\r", `\r`)

// Quote renders s as a PromQL string literal.
func Quote(s string) string {
	return `"` + quoter.Replace(s) + `"`
}

func (c *Client) get(ctx context.Context, endpoint string, params url.Values) (json.RawMessage, error) {
	target := *c.base
	target.Path = strings.TrimSuffix(c.base.Path, "/") + endpoint
	target.RawPath = ""
	target.RawQuery = params.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("build prometheus request: %w", err)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("prometheus request: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	if err != nil {
		return nil, fmt.Errorf("read prometheus response: %w", err)
	}
	var envelope struct {
		Status    string          `json:"status"`
		ErrorType string          `json:"errorType"`
		Error     string          `json:"error"`
		Data      json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, fmt.Errorf("decode prometheus response (http %d): %w", response.StatusCode, err)
	}
	if response.StatusCode/100 != 2 || envelope.Status != "success" {
		return nil, fmt.Errorf("prometheus %s: http %d, %s: %s", endpoint, response.StatusCode, envelope.ErrorType, envelope.Error)
	}
	return envelope.Data, nil
}

type rawPoint [2]json.RawMessage

func (p rawPoint) point() (Point, bool) {
	var text string
	if json.Unmarshal(p[1], &text) != nil {
		return Point{}, false
	}
	value, valueErr := strconv.ParseFloat(text, 64)
	timestamp, timeErr := strconv.ParseFloat(string(p[0]), 64)
	if valueErr != nil || timeErr != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return Point{}, false
	}
	return Point{timestamp, value}, true
}

func unixParam(at time.Time) string {
	return strconv.FormatFloat(float64(at.UnixMilli())/1000, 'f', -1, 64)
}
