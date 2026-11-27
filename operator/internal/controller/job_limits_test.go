package controller

import "testing"

func TestResolveJobLimits(t *testing.T) {
	zero, five, neg := int32(0), int32(5), int32(-1)
	cases := []struct {
		name  string
		b     *int32
		d     int64
		wantB int32
		wantD int64
	}{
		{"unset uses defaults", nil, 0, 2, 21600},
		{"override both", &five, 3600, 5, 3600},
		{"explicit zero backoff honoured", &zero, 0, 0, 21600},
		{"negative backoff and deadline fall back", &neg, -5, 2, 21600},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b, d := resolveJobLimits(tc.b, tc.d)
			if b != tc.wantB || d != tc.wantD {
				t.Errorf("got (%d,%d), want (%d,%d)", b, d, tc.wantB, tc.wantD)
			}
		})
	}
}
