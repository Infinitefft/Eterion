package chat

import (
	"strings"
	"testing"
)

func TestInteractionAcceptsCustomAnswers(t *testing.T) {
	for _, multiple := range []bool{false, true} {
		question := HITLQuestion{QuestionID: "topic", Options: []string{"A", "B"}, Multiple: multiple, Required: true}
		var value any = "自己的想法"
		if multiple {
			value = []any{"A", "自己的想法"}
		}
		if err := validateInteractionAnswers([]HITLQuestion{question}, []HITLAnswer{{QuestionID: "topic", Value: value}}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestInteractionStillRejectsInvalidAnswers(t *testing.T) {
	question := HITLQuestion{QuestionID: "topic", Options: []string{"A", "B"}, Multiple: true, Required: true}
	for _, value := range []any{"A", []any{}, []any{" "}, []any{"A", "A"}, []any{42}, []any{strings.Repeat("a", 501)}} {
		if err := validateInteractionAnswers([]HITLQuestion{question}, []HITLAnswer{{QuestionID: "topic", Value: value}}); err == nil {
			t.Fatalf("accepted invalid answer: %#v", value)
		}
	}
}
