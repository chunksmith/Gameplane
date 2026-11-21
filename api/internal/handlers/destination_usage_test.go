package handlers

import "testing"

func TestParseS3Repo(t *testing.T) {
	cases := []struct {
		repo string
		want s3Target
		ok   bool
	}{
		{"s3:https://s3.de.io.cloud.ovh.net/bucket/gameplane/repo", s3Target{endpoint: "s3.de.io.cloud.ovh.net", bucket: "bucket", prefix: "gameplane/repo", secure: true}, true},
		{"s3:s3.amazonaws.com/bucket", s3Target{endpoint: "s3.amazonaws.com", bucket: "bucket", secure: true}, true},
		{"s3:http://minio.local:9000/bucket/", s3Target{endpoint: "minio.local:9000", bucket: "bucket"}, true},
		{"s3:https://host", s3Target{}, false},
		{"s3:ftp://host/bucket", s3Target{}, false},
		{"rest:https://host/repo", s3Target{}, false},
		{"/srv/restic", s3Target{}, false},
	}
	for _, tc := range cases {
		got, ok := parseS3Repo(tc.repo)
		if ok != tc.ok || got != tc.want {
			t.Errorf("parseS3Repo(%q) = %+v, %v; want %+v, %v", tc.repo, got, ok, tc.want, tc.ok)
		}
	}
}
