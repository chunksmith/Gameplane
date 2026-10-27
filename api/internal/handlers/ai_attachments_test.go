package handlers

import (
	"encoding/base64"
	"testing"
)

func TestAIContent(t *testing.T) {
	encoded := func(data string) string { return base64.StdEncoding.EncodeToString([]byte(data)) }
	blocks, err := aiContent("look", []aiAttachment{
		{Name: "shot.png", MediaType: "image/png", Data: encoded("png")},
		{Name: "doc.pdf", MediaType: "application/pdf", Data: encoded("%PDF")},
		{Name: "config.yml", MediaType: "", Data: encoded("a: 1")},
	})
	if err != nil {
		t.Fatalf("aiContent: %v", err)
	}
	if len(blocks) != 4 || blocks[0].OfImage == nil || blocks[1].OfDocument == nil || blocks[2].OfDocument.Source.OfText == nil || blocks[3].OfText == nil {
		t.Fatalf("unexpected blocks: %+v", blocks)
	}
	if blocks[2].OfDocument.Title.Value != "config.yml" {
		t.Fatalf("title = %q", blocks[2].OfDocument.Title.Value)
	}
	for name, attachments := range map[string][]aiAttachment{
		"binary":  {{Name: "a.bin", MediaType: "application/octet-stream", Data: base64.StdEncoding.EncodeToString([]byte{0xff, 0xfe})}},
		"base64":  {{Name: "a.png", MediaType: "image/png", Data: "!!"}},
		"tooMany": make([]aiAttachment, aiMaxAttachment+1),
		"empty":   {{Name: "a.txt", MediaType: "text/plain"}},
	} {
		if _, err := aiContent("x", attachments); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}
