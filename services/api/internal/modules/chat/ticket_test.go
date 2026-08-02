package chat

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestUserTicketCanOnlyBeConsumedOnce(t *testing.T) {
	service := NewTicketService(45 * time.Second)
	now := time.Date(2026, 8, 2, 12, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return now }
	userID := uuid.New()

	ticket, err := service.Issue(userID)
	if err != nil {
		t.Fatalf("issue ticket: %v", err)
	}
	consumed, err := service.Consume(ticket.Value)
	if err != nil || consumed != userID {
		t.Fatalf("consume ticket: user=%s err=%v", consumed, err)
	}
	if _, err := service.Consume(ticket.Value); !errors.Is(err, ErrTicketInvalid) {
		t.Fatalf("second consume should be invalid, got %v", err)
	}
}

func TestUserTicketExpires(t *testing.T) {
	service := NewTicketService(time.Second)
	now := time.Date(2026, 8, 2, 12, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return now }
	ticket, err := service.Issue(uuid.New())
	if err != nil {
		t.Fatalf("issue ticket: %v", err)
	}
	now = now.Add(2 * time.Second)
	if _, err := service.Consume(ticket.Value); !errors.Is(err, ErrTicketExpired) {
		t.Fatalf("expired ticket should fail, got %v", err)
	}
}
