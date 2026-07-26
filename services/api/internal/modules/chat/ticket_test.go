// 负责验证 WebSocket Ticket 的绑定、过期和一次性消费语义。
package chat

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestTicketCanOnlyBeConsumedOnce(t *testing.T) {
	service := NewTicketService(45 * time.Second)
	now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	service.now = func() time.Time {
		return now
	}

	userID := uuid.New()
	chatID := uuid.New()
	ticket, err := service.Issue(userID, chatID)
	if err != nil {
		t.Fatalf("issue ticket: %v", err)
	}

	consumedUserID, err := service.Consume(ticket.Value, chatID)
	if err != nil {
		t.Fatalf("consume ticket: %v", err)
	}
	if consumedUserID != userID {
		t.Fatalf(
			"unexpected user ID: got %s want %s",
			consumedUserID,
			userID,
		)
	}

	if _, err := service.Consume(ticket.Value, chatID); !errors.Is(
		err,
		ErrTicketInvalid,
	) {
		t.Fatalf("second consume should be invalid, got %v", err)
	}
}

func TestTicketExpires(t *testing.T) {
	service := NewTicketService(time.Second)
	now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	service.now = func() time.Time {
		return now
	}

	chatID := uuid.New()
	ticket, err := service.Issue(uuid.New(), chatID)
	if err != nil {
		t.Fatalf("issue ticket: %v", err)
	}

	now = now.Add(2 * time.Second)
	if _, err := service.Consume(
		ticket.Value,
		chatID,
	); !errors.Is(err, ErrTicketExpired) {
		t.Fatalf("expired ticket should fail, got %v", err)
	}
}
